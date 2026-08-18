# mitmproxy gateway integration (OGR v0.8)

A single-file [mitmproxy](https://mitmproxy.org) addon that speaks **OGR v0.8
directly to an OpenGuardrails runtime**. It implements the gateway side of the
one normative recipe in
[`specification/runtime-api.md`](../../../specification/runtime-api.md):
two POSTs to `/v1/evaluate` per proxied model call, raw provider bodies,
nothing decomposed client-side.

```
   agent  ──HTTPS──▶  mitmproxy (addon.py)  ──▶  LLM provider
                          │
                          └── GuardEvent → POST {OGR_URL}/v1/evaluate → Verdict
```

One proxied model call is one **step**, reported as two events sharing an
addon-minted `step_id`:

| hook | event | payload | on `block` |
|---|---|---|---|
| `request` | `step/request` | the provider request body, **verbatim** | a protocol-shaped 403 — the model is never called |
| `response` | `step/response` | the provider response body verbatim + byte-spliced `timing`; a streamed reply reassembled, judged once, whole | the answer is withheld — the agent never sees the prose or the tool calls |

The addon is a pure PEP: it holds bytes and enforces verdicts. All policy —
including session/turn derivation, conversation classification, and judging
the tool inventory from the `tools` array where it already travels — lives in
the runtime. The v0.8 event is exactly nine fields; there is no SDK (the two
HTTP calls are hand-rolled stdlib `urllib`), no declared coordinates, no
`/v1/ingest`, no `turn/end`.

## Recognized traffic

`llm_protocol` is detected from the request path and stated on every event:

| path suffix | `llm_protocol` |
|---|---|
| `…/chat/completions` | `openai.chat` |
| `…/responses` | `openai.responses` |
| `…/messages` | `anthropic.messages` |

A refusal is rendered in the **caller's** protocol — an Anthropic caller gets
an Anthropic-shaped error, an OpenAI caller an OpenAI-shaped one. Everything
else on the proxy passes through untouched.

## Streaming: buffered whole (tail = ∞)

mitmproxy buffers a response in full before the `response` hook fires, and
this addon never opts into streaming pass-through. That is the spec's
tail-hold with **tail = ∞**: the streamed answer is reassembled and judged
exactly once, whole, and the client sees **nothing** until the verdict allows
it. The trade against a finite tail-hold (see the
[`openai-anthropic`](../openai-anthropic/) example, which implements one) is
time-to-first-token, not exposure — the safest end of the dial, at the cost
of streaming UX behind the proxy.

Reassembly per protocol: an `openai.responses` stream ends with a
`response.completed` frame carrying the complete raw response object, which
travels as-is under `openai.responses`; chat and messages streams have no
such body and reassemble into the **canonical** shape
(`{text, reasoning?, tool_calls?, model?, usage?, timing}`) with the
provider's usage counters transcribed — and omitted, never zeroed, when the
provider reported nothing.

## Run

```bash
pip install mitmproxy            # the addon itself is stdlib-only
export OGR_URL=https://ogr.example.com
export OGR_API_KEY=ogr_xxx
mitmdump -s addon.py --listen-port 8080
```

`addon.py` is self-contained — load it directly (there is no `run.py` and no
package to install). Swap `mitmdump` for `mitmweb` to watch flows in a UI.

Route the agent through the proxy as usual:

```bash
export HTTPS_PROXY=http://localhost:8080
export SSL_CERT_FILE=~/.mitmproxy/mitmproxy-ca-cert.pem   # trust the proxy CA once
```

A blocked request comes back as:

```json
{"error": {"type": "ogr_policy_block", "code": "guardrails_blocked",
           "message": "Blocked by OpenGuardrails policy: security.prompt_injection"}}
```

with `x-ogr-decision: block` and `x-ogr-event-id` headers (the event id is
runtime-assigned — the addon never mints identifiers beyond `step_id`).

## Configuration

Every knob is an environment variable **and** a mitmproxy option
(`--set ogr_fail_mode=closed` wins over the env default):

| option | env | default | meaning |
|---|---|---|---|
| `ogr_url` | `OGR_URL` | `http://localhost:3000` | runtime base URL; the canonical `/v1/*` paths are joined onto it — a deployment prefix belongs IN the URL |
| `ogr_api_key` | `OGR_API_KEY` | — | organization API key (`Authorization: Bearer`) |
| `ogr_agent_id` | `OGR_AGENT_ID` | `""` | four-tuple: WHICH agent fronts this proxy |
| `ogr_agent_type` | `OGR_AGENT_TYPE` | `""` | four-tuple: what KIND of agent (a label, never an identity) |
| `ogr_agent_workspace` | `OGR_AGENT_WORKSPACE` | `""` | four-tuple: agent group = policy set |
| `ogr_agent_user` | `OGR_AGENT_USER` | `""` | four-tuple: who uses the agent behind this proxy |
| `ogr_fail_mode` | `OGR_FAIL_MODE` | `open` | what an unanswered evaluate means — see below |
| `ogr_timeout` | `OGR_TIMEOUT` | `5.0` | evaluate budget (seconds); a ceiling for the worst case, not a target |

**The four-tuple.** All four fields are sent on every event; the empty string
is the explicit "no assertion", never an omission. A gateway normally fills
`agent_id` from its own caller authentication — the authenticated caller IS
the agent — but a forward proxy authenticates nobody, so here the four-tuple
is operator config and the API key is the identity floor beneath it: five
empty strings are still fully attributable to the key. A multi-tenant
deployment that needs per-caller attribution wants a gateway that
authenticates (see the Higress plugin), not a forward proxy.

**Fail mode.** The default is **open**, per the
[degraded-mode spec](../../../specification/degraded-mode.md): a step whose
evaluate got no answer (timeout, 429, 5xx, network, non-verdict body)
proceeds and is *counted* (`unchecked`). `closed` refuses it with a 503 — and
holds one level deeper: a verdict whose `unjudged` names paths is "could not
look", which is not "found nothing", and is refused too. The addon heartbeats
its counters (`evaluated`, `refused`, `unchecked`, `unreadable`,
`unresolved_spans`) to `/v1/heartbeat` every 30 s, which is also where the
integration build id lives in v0.8.

**Redaction.** `modifications.spans` are applied in place before the body
proceeds — highest offset first per string, character offsets, unresolvable
spans dropped and counted (`unresolved_spans`), never applied somewhere else.

## Limitations

- **Streaming UX**: streamed replies are buffered whole before delivery (see
  above). Deliberate; use a tail-holding gateway if TTFT matters.
- **Spans on streamed replies** name the reassembled canonical payload, which
  cannot be spliced back into the original SSE frames; they are counted
  unresolved rather than half-applied.
- **Unreadable bodies** on a recognized LLM path pass unjudged but counted
  (`unreadable`) — silence is indistinguishable from health.
- **WebSocket transports are not covered.** v0.6's Codex-over-WebSocket
  support was removed with the v0.8 rewrite; the v0.8 wire is defined over
  request/response bodies. Codex traffic over plain HTTP+SSE to a
  `…/responses` path is still judged like any Responses call.
- A forward proxy is evadable from outside the process (an agent pointed at a
  different endpoint is simply never seen); it is an enforcement point for
  traffic you route through it, not a containment boundary.

## Test

Fully offline — no runtime, no upstream, and no mitmproxy needed (the tests
drive the hook logic with fabricated flow objects against a stdlib mock
runtime; one optional test uses real mitmproxy types and skips when it is not
installed):

```bash
python -m pytest integrations/gateway/mitmproxy    # from the repo root
```
