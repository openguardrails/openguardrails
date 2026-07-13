# mitmproxy gateway integration

A [mitmproxy](https://github.com/mitmproxy/mitmproxy) addon that enforces an
OpenGuardrails **runtime policy** on LLM traffic. Your agent talks to the LLM
through mitmproxy; the addon normalizes each request/response into an OGR
`GuardEvent`, asks the runtime PDP for a `Verdict`, and short-circuits the flow
when the policy says `block` / `require_approval`.

```
   agent  ──HTTPS──▶  mitmproxy (this addon)  ──▶  LLM API (OpenAI / Anthropic)
                          │
                          ▼  GuardEvent
              runtime  POST /api/public/ogr/v1/evaluate  ──▶  Verdict
              (your policy: moderation, injection, … ;  model served by vLLM)
```

Unlike the in-process [`openai-anthropic`](../openai-anthropic/) example (which
runs reference detectors locally), this addon is a pure **PEP**: it carries no
detection logic and holds no policy model. All decisions come from the runtime
you configure — the same policy your other observation points (agent hook,
sandbox) share.

## What it does

| Hook | Event | On `block`/`require_approval` |
|------|-------|-------------------------------|
| `request` | `user_input` = the latest user turn on the wire | replaces the request with a `403`/`409` error — the model is never called |
| `response` | `model_output` = the completion | replaces the completion with a `403`/`409` error |

Supported wire protocols: OpenAI Chat Completions (`/v1/chat/completions`),
OpenAI Responses (`/v1/responses`), Anthropic Messages (`/v1/messages`), and
**Codex over WebSocket** (ChatGPT-login mode — see below).

### Codex (ChatGPT backend, WebSocket)

Codex in ChatGPT-login mode does not use plain HTTP — it opens a **WebSocket** to
`chatgpt.com/backend-api/codex/responses` and sends each turn as a Responses-API
`response.create` text frame. The addon's `websocket_message` hook parses the
client→server frame, extracts the user turn, evaluates it, and on `block` **drops
that frame** so the model never receives it (the request never completes).

Two things are Codex-specific:
- **CA trust**: Codex is a Rust binary (reqwest), so `NODE_EXTRA_CA_CERTS` does
  nothing. Use `SSL_CERT_FILE` pointing at a bundle that includes the mitmproxy
  CA (system roots + `~/.mitmproxy/mitmproxy-ca-cert.pem`), or add the CA to the
  system store (`update-ca-certificates`).
- **Block UX**: dropping a WebSocket request frame stops the model from seeing the
  input, but there is no clean 403 — Codex surfaces it as a stalled/failed turn.
  (HTTP protocols get a proper 403/409 body; WebSocket blocking is drop-based.)

```bash
export HTTPS_PROXY=http://localhost:8080 HTTP_PROXY=http://localhost:8080
export SSL_CERT_FILE=~/.mitmproxy/combined-ca.pem   # system roots + mitmproxy CA
codex exec "…"                                       # traffic now flows through the proxy
```

## Quick start (end-to-end moderation)

This walks the exact loop: **agent → mitmproxy → runtime → vLLM(moderation LoRA)**,
detecting runs whose content violates the moderation policy.

### 1. Serve the moderation model (vLLM + LoRA)

The runtime's model gateway calls a model service with `{texts, checks}` and
expects `{findings}`. Serve the moderation LoRA behind that contract — see the
adapter and launch script in the model pipeline repo
(`openguardrails-pipeline/moderation/serve/`). In short:

```bash
# vLLM serves the base + moderation LoRA (OpenAI-compatible), then a thin adapter
# wraps it in the OGR /v1/detect contract on :8090.
bash moderation/serve/run_vllm.sh                 # base + --lora-modules moderation=<adapter>
python moderation/serve/detect_server.py          # -> POST /v1/detect  (:8090)
```

### 2. Point the runtime at the model and configure a policy

```bash
# runtime env
export OGR_MODEL_GATEWAY_URL=http://localhost:8090/v1/detect
```

In the runtime, attach the **`moderation`** guardrail to a policy (Guardrails UI,
or seed it). With `OGR_MODEL_GATEWAY_URL` set, that guardrail calls the model
instead of the regex mock. Create an API key (`ogr_...`) for the workspace.

### 3. Run the proxy

```bash
pip install -e .                    # needs mitmproxy >= 10 (older 6.x is broken on modern pyOpenSSL)
export OGR_RUNTIME_URL=http://localhost:3000
export OGR_API_KEY=ogr_xxx          # workspace key from step 2
mitmdump -s run.py --listen-port 8080
```

`run.py` is the entrypoint — load that, not `ogr_mitmproxy/addon.py` directly
(mitmproxy loads a `-s` script standalone, which would break the addon's
intra-package imports). `run.py` puts the package on `sys.path` and exposes `addons`.

### 4. Route the agent through the proxy

```bash
# trust mitmproxy's CA once (agent must accept the proxy's TLS)
#   the cert is generated at ~/.mitmproxy/mitmproxy-ca-cert.pem on first run
export HTTPS_PROXY=http://localhost:8080
export SSL_CERT_FILE=~/.mitmproxy/mitmproxy-ca-cert.pem   # or REQUESTS_CA_BUNDLE / NODE_EXTRA_CA_CERTS
# now point the agent's base_url at the real LLM and run it as usual
```

A prompt that trips the moderation policy comes back as:

```json
{ "error": { "type": "ogr_policy_block", "code": "guardrails_blocked",
  "message": "Blocked by OpenGuardrails policy: safety.self_harm",
  "ogr": { "decision": "block", "guard_id": "gw-000123", "categories": [ … ] } } }
```

## Configuration (env)

| Var | Default | Meaning |
|-----|---------|---------|
| `OGR_RUNTIME_URL` | `http://localhost:3000` | runtime base URL (PDP) |
| `OGR_API_KEY` | — | workspace key, `Authorization: Bearer` (required) |
| `OGR_AGENT_ID` | `mitmproxy-agent` | `subject.agent_id` on every event |
| `OGR_AGENT_TYPE` | — | optional `subject.agent_type` |
| `OGR_FAIL_MODE_CLOSED` | `true` | if the runtime is unreachable: block (`true`) or pass through (`false`) |
| `OGR_CHECK_RESPONSE` | `true` | also moderate the model completion |
| `OGR_EVAL_TIMEOUT` | `2.0` | seconds to wait on the PDP call |

Session correlation: the addon uses an `x-ogr-session` (or `x-session-id`)
request header if the agent sets one, else the client connection id. The runtime
derives a **run** at each new `user_input` in a session, so a moderated run maps
to one conversation turn.

## Notes / limits (milestone)

- **Streaming responses** (`text/event-stream`) skip response-side moderation for
  now; request-side (`user_input`) moderation always applies. Disable streaming
  on the agent to moderate completions, or wait for the streaming follow-up.
- The addon evaluates the **latest user turn** per request (the run's new input),
  not the entire history each time — that is what the runtime derives runs from.
- Blocking is synchronous and bounded by `OGR_EVAL_TIMEOUT`; the PDP call runs off
  the proxy event loop so throughput is not serialized on it.

## Test

```bash
pip install -e ".[test]" 2>/dev/null || pip install mitmproxy pytest
python -m pytest tests/ -q
```
