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
| `request` | `user_input` = the latest user turn on the wire; also **`tool_result`** for HTTP-transport Codex | replaces the request with a `403`/`409` error — the model is never called |
| `response` | `model_output` = the completion; also **`tool_call`** for HTTP-transport Codex | replaces the completion with a `403`/`409` error |
| `websocket_message` | `user_input`, **`tool_call`**, `tool_result` (Codex, WebSocket transport) | drops the frame — the command never reaches the agent |

Supported wire protocols: OpenAI Chat Completions (`/v1/chat/completions`),
OpenAI Responses (`/v1/responses`), Anthropic Messages (`/v1/messages`),
**Codex over WebSocket** (ChatGPT-login mode — see below), and **Codex over
HTTP+SSE** (third-party ChatGPT-backend clients built on the openai SDK — see
further below).

### Server-side lifecycle reconstruction

An HTTP connection is a transport detail, not an agent Session. The gateway
reconstructs lifecycle from the ordinary provider request and response; the
agent client does not need to send OGR-specific fields. It extracts an existing
conversation ID from standard/provider fields such as `session_id`,
`prompt_cache_key`, `x-session-id`, or `x-conversation-id`, then follows message
history, tool calls/results, and the final response to emit one `user_input` per
Run, a full `model_input` and `model_output` per Turn, and correlated
`tool_call` / `tool_result` events. OpenAI/Anthropic streaming responses are
reconstructed before telemetry and tool-call enforcement.

The tool call and its later result share one OGR `guard_id`; the provider's
call ID is retained as `payload.call_id`.

Whenever a request carries no `x-ogr-*` lifecycle headers, the gateway infers
the lifecycle server-side (`OGR_INFER_LIFECYCLE`, on by default): the same
latest user instruction remains one Run until a model response has no tool
calls; each intervening model request is the next Turn; a `tool_result` is
attributed back to the Turn of the Action that produced it. A conversation that
restarts with an identical opening prompt is NOT merged into the older inferred
Session once that Session has grown past it. Transcript-only title/summary
helper calls are passed upstream but excluded from the primary Agent timeline.

Agent identity is NOT configured on the gateway: events are sent without
`subject.agent_id` and the runtime recognises the Agent from the system
prompt's self-definition at ingest (`OGR_AGENT_ID`/`OGR_AGENT_TYPE` remain as
explicit operator overrides only).

### Codex (ChatGPT backend, WebSocket)

Codex in ChatGPT-login mode does not use plain HTTP — it opens a **WebSocket** to
`chatgpt.com/backend-api/codex/responses` and sends each turn as a Responses-API
`response.create` text frame. The addon's `websocket_message` hook handles three
surfaces on that socket:

| Direction | Frame | Event |
|-----------|-------|-------|
| client→server | `response.create` user turn | `user_input` |
| client→server | `response.create` → `custom_tool_call_output` | `tool_result` (untrusted — the indirect-injection surface) |
| **server→client** | `response.output_item.done` → `custom_tool_call` | **`tool_call`** — the command the model wants Codex to run |

The `tool_call` direction is the one that matters for a coding agent, and it is
**server→client**: Codex threads history server-side via `previous_response_id`,
so the call itself is never re-sent by the client — the only place to see it is
on its way to the agent. mitmproxy awaits the hook before forwarding the frame,
so a `block` verdict stops the command from ever reaching Codex. This is what
lights up the runtime's `yolo` guardrail (scope + command danger + tenant rules),
which only ever fires on `tool_call`.

**Graceful block (default).** Codex's freeform exec tool runs the tool call's
`input` as JS and reports whatever `text(...)` emits. On a blocked `tool_call`
the addon rewrites `input` in-frame to a bare `text("⛔ OpenGuardrails blocked
…")` — no command — and forwards it. Codex "runs" the notice, gets it as the
tool result, and relays it to the user in its own words; the dangerous command
never executes and the turn completes cleanly. Contrast the fallback below
(drop + kill), which leaves the user staring at a stalled turn. Set
`OGR_WS_BLOCK_REWRITE=false` to force the fallback. A **named** `function_call`
(rather than freeform exec) can't be rewritten — a benign argument would still
invoke the real tool — so those always fall back to drop + kill.

Three things are Codex-specific:
- **Streamed tool fragments**: the completed call is preceded by
  `custom_tool_call_input.delta` frames carrying it piecemeal — enough for Codex
  to assemble and run before the verdict lands. The addon withholds those deltas
  (`OGR_WS_HOLD_TOOL_DELTAS`, default on); the completed item carries the full
  input, so the agent loses only the typing animation.
- **Codex's own reviewer**: with `approvals_reviewer` enabled Codex runs a second
  model (`codex-auto-review`) over the *same socket*, and its prompt is the action
  being judged. Those frames are skipped — evaluating them would double-report
  every action with the reviewer's rubric as the "user turn".
- **CA trust**: Codex is a Rust binary (reqwest), so `NODE_EXTRA_CA_CERTS` does
  nothing. Use `SSL_CERT_FILE` pointing at a bundle that includes the mitmproxy
  CA (system roots + `~/.mitmproxy/mitmproxy-ca-cert.pem`), or add the CA to the
  system store (`update-ca-certificates`).
- **Block UX**: `user_input` / `tool_result` blocks have no clean 403 on a socket,
  so they drop the frame + kill the flow (Codex shows a stalled/failed turn).
  `tool_call` blocks are graceful — see "Graceful block" above. (HTTP protocols
  always get a proper 403/409 body.)

```bash
export HTTPS_PROXY=http://localhost:8080 HTTP_PROXY=http://localhost:8080
export SSL_CERT_FILE=~/.mitmproxy/combined-ca.pem   # system roots + mitmproxy CA
codex exec "…"                                       # traffic now flows through the proxy
```

### Codex (ChatGPT backend, HTTP+SSE)

`codex-cli` (the Rust binary) is not the only client on this URL. Third-party
agents built on the **openai SDK** and pointed at
`base_url="https://chatgpt.com/backend-api/codex"` (e.g.
[hermes-agent](https://github.com/nousresearch/hermes-agent)) call the
Responses API the SDK's normal way: a plain HTTPS `POST
/backend-api/codex/responses`, not a WebSocket. `protocols.is_codex_http` /
`OGRGateway._codex_http_request` / `_codex_http_response` handle that case —
same path as the WebSocket transport above, disambiguated by HTTP method (a
WS handshake is a `GET`; a Responses API call is always a `POST`) rather than
by URL.

The underlying Responses API objects are identical between the two
transports — a `response.output_item.done` tool-call frame parses the same
way whether it arrived as a WebSocket text frame or an SSE `data:` line — so
tool_call extraction reuses the exact same parser. Two things genuinely
differ from the WebSocket path, both because these clients typically set
`store: false` (no server-side history, so Codex never issues a
`previous_response_id` for them to thread on):

- **No per-connection state.** Every turn is its own HTTP connection (unlike
  the long-lived WebSocket), and the full turn history is resent in
  `input[]` on every request. The authz-envelope transcript is rebuilt fresh
  from that each time; only the tool_result dedup cache (so the same
  historical result isn't re-judged on every later turn) survives across
  requests, keyed by session id on the gateway instance.
- **Session id.** With no persistent connection to key off, the gateway reads
  the request body's `session_id` or `prompt_cache_key` (Hermes uses its own
  Session ID), plus standard provider conversation headers when available,
  before falling back to conversation-history reconstruction.

**Block UX** is HTTP-clean either way (a proper 403/409), which is simpler
than the WebSocket path's graceful-rewrite-or-drop-and-kill dance — but it
means a blocked `tool_call` discards the *entire* buffered response, not just
the offending item; there is no partial-forward. mitmproxy buffers the whole
response (streaming or not) before the `response` hook fires, so this is
still enforced before any byte reaches the client. **Streaming completion
text** (`stream=true` SSE) is not moderated yet, same limitation as the other
HTTP protocols above — `tool_call` gating is unaffected, it runs off the
buffered SSE body regardless.

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

**Want to watch the traffic?** Swap `mitmdump` for `mitmweb` — same addon, plus a
web UI that lists every flow (and every Codex WebSocket frame) so you can inspect
what was evaluated and blocked:

```bash
mitmweb -s run.py --listen-port 8080 \
        --web-host 127.0.0.1 --web-port 8081 --no-web-open-browser
# open http://127.0.0.1:8081  (over SSH: ssh -L 8081:127.0.0.1:8081 <host>)
```

Note the `[OGR]` verdict lines go to mitmweb's **Events** pane in the UI, not the
terminal; use `mitmdump` if you want them on stdout.

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
| `OGR_AGENT_ID` | — | operator override for `subject.agent_id`; unset (recommended) lets the runtime derive the Agent from the system prompt |
| `OGR_AGENT_TYPE` | — | optional `subject.agent_type` override |
| `OGR_INFER_LIFECYCLE` | `true` | infer Session/Run/Turn server-side when no `x-ogr-*` headers are present |
| `OGR_FAIL_MODE_CLOSED` | `true` | if the runtime is unreachable: block (`true`) or pass through (`false`) |
| `OGR_CHECK_RESPONSE` | `true` | also moderate the model completion |
| `OGR_WS_HOLD_TOOL_DELTAS` | `true` | withhold streamed tool-call fragments until the completed call is judged |
| `OGR_WS_BLOCK_REWRITE` | `true` | on a blocked Codex `tool_call`, rewrite it to a harmless notice (graceful) instead of dropping the frame + killing the socket |
| `OGR_EVAL_TIMEOUT` | `2.0` | seconds to wait on the PDP call — **raise it** (15–25s) when the policy calls an undistilled judge; a 27B LoRA takes 1–4s per call |

Session correlation is automatic. The gateway reads ordinary provider
conversation fields from headers/body and, for Hermes, reconstructs missing
boundaries from growing message history. A Run lasts from one external user
instruction through the final model response; each intervening model request is
a Turn and each tool call is an Action.

## Notes / limits (milestone)

- **Streaming responses** (`text/event-stream`) skip response-side moderation for
  now; request-side (`user_input`) moderation always applies. Disable streaming
  on the agent to moderate completions, or wait for the streaming follow-up.
  This affects the **HTTP** protocols only — the Codex WebSocket path moderates
  `tool_call` on the server→client side regardless.
- **The authz envelope is per socket.** `transcript` (user turns + executed
  `tool_use` projections) and `agent_system_prompt` are accumulated as the
  connection runs, so the scope judge sees what authorized an action. A verdict
  on the first tool call of a fresh connection has less context than a later one.
- The addon evaluates the **latest user turn** per request (the run's new input),
  not the entire history each time — that is what the runtime derives runs from.
- Blocking is synchronous and bounded by `OGR_EVAL_TIMEOUT`; the PDP call runs off
  the proxy event loop so throughput is not serialized on it.

## Test

```bash
pip install -e ".[test]" 2>/dev/null || pip install mitmproxy pytest
python -m pytest tests/ -q
```
