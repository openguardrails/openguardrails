# The example gateway: OGR v0.8 in one file

[`gateway.py`](gateway.py) is a runnable LLM gateway — OpenAI Chat
Completions and Anthropic Messages in, the real provider out — with the
**complete OGR v0.8 gateway integration** wrapped around both directions.
Stdlib only, no SDK (there is none in v0.8), no framework: its value is that
you can read it top to bottom and see the entire contract, including the part
every other write-up hand-waves — enforcing on a **streamed** reply.

```
   client ──HTTP──▶ gateway.py ──▶ OpenAI / Anthropic
                       │
                       └── GuardEvent → POST {OGR_URL}/v1/evaluate → Verdict
```

It is documentation that runs. The production-grade gateway integration is
the Higress WASM plugin ([`../higress`](../higress/)); the buffered-proxy
variant is the mitmproxy addon ([`../mitmproxy`](../mitmproxy/)). This file
is where to read the recipe.

## The whole protocol, per proxied call

From [`specification/runtime-api.md`](../../../specification/runtime-api.md),
"The recipe" — an integration is an API key, nine fields, and one endpoint:

1. **mint `step_id`** — a fresh random id; the one coordinate v0.8 kept,
   because concurrency makes pairing a call's two halves underivable.
2. **evaluate `step/request`** — the raw request body, verbatim. `block` →
   the caller gets a protocol-shaped 403 and the provider is never called;
   `modifications.spans` → applied in place before sending.
3. **forward upstream** (the client's own provider credentials pass through).
4. **evaluate `step/response`** — the raw response body plus `timing`
   (byte-spliced into the body's own bytes, never re-serialized); a streamed
   reply is reassembled and judged **once, whole**. `block` → the answer is
   withheld / the stream is cut; the tool calls held here are the only copy
   of an action anyone can still refuse.
5. **heartbeat** every 30 s — `{integration, interval_s, counters}`; the
   build id lives here in v0.8, not on events.

Nothing is decomposed client-side and nothing else is on the wire: no
`ogr_version`, no session/turn/step declarations, no timestamps, no
`/v1/ingest`, no `turn/end`.

## Streaming: hold the tail, judge once

The gateway forwards SSE frames as they arrive but withholds the final
`OGR_TAIL_HOLD` characters (default 200) of client-visible content — text,
reasoning, and tool-call argument fragments all count. At stream end the
whole reply is reassembled into the canonical shape
(`{text, reasoning?, tool_calls?, model?, usage?, timing}`) and evaluated
exactly once:

- **allow** → the held tail (including the terminal `[DONE]` /
  `message_stop` frame) is released and the stream completes.
- **block** → the tail is dropped and the connection closes. The stream never
  completes, so no tool call was ever deliverable before the verdict — a
  terminal frame carries zero visible characters and can never leave the
  hold early.

The accepted cost is that content *ahead* of the tail has already been seen;
a retraction, not a true block. A deployment that cannot accept any exposure
sets `OGR_TAIL_HOLD=inf`, which degenerates to buffering the whole reply
(what the mitmproxy addon always does), and pays the time-to-first-token.

## Run

```bash
export OGR_URL=https://ogr.example.com
export OGR_API_KEY=ogr_xxx
export OGR_AGENT_ID=my-gateway          # the four-tuple; see below
python3 gateway.py --port 8800
```

Point any client at it — the gateway forwards the client's own provider
credentials:

```bash
# OpenAI SDK: base_url=http://localhost:8800/v1
curl -s localhost:8800/v1/chat/completions \
  -H "authorization: Bearer $OPENAI_API_KEY" -H "content-type: application/json" \
  -d '{"model": "gpt-5", "messages": [{"role": "user", "content": "hello"}]}'

# Anthropic SDK: base_url=http://localhost:8800
curl -s localhost:8800/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model": "claude-sonnet-4-5", "max_tokens": 64,
       "messages": [{"role": "user", "content": "hello"}]}'
```

A block comes back as a 403 in the caller's protocol (OpenAI `error` object /
Anthropic `{"type": "error", ...}`), with `x-ogr-decision` and
`x-ogr-event-id` headers.

## Configuration (env)

| var | default | meaning |
|---|---|---|
| `OGR_URL` | `http://localhost:3000` | runtime base URL; canonical `/v1/*` paths joined onto it |
| `OGR_API_KEY` | — | organization API key (`Authorization: Bearer`) |
| `OGR_AGENT_ID` | `""` | four-tuple: WHICH agent this gateway fronts |
| `OGR_AGENT_TYPE` | `""` | four-tuple: what KIND (a label, never an identity) |
| `OGR_AGENT_WORKSPACE` | `""` | four-tuple: agent group = policy set |
| `OGR_AGENT_USER` | `""` | four-tuple: who is using it |
| `OGR_FAIL_MODE` | `open` | `closed` refuses when no verdict arrives — including a verdict whose `unjudged` names paths |
| `OGR_TAIL_HOLD` | `200` | held-back characters of a streamed reply; `inf` buffers the whole stream |
| `OGR_TIMEOUT` | `5.0` | evaluate budget (seconds) |
| `OGR_UPSTREAM_OPENAI` | `https://api.openai.com` | where `/v1/chat/completions` forwards |
| `OGR_UPSTREAM_ANTHROPIC` | `https://api.anthropic.com` | where `/v1/messages` forwards |

**The four-tuple** is required on every event, with `""` as the explicit "no
assertion" — every integrator answers the identity question; nobody falls
into the API-key floor by omission. A real gateway fills `agent_id` from its
own **caller authentication** (the authenticated caller IS the agent) and
`agent_workspace` from an operator-maintained consumer grouping. This example
authenticates nobody, so identity is env config — that per-caller lookup is
the one piece intentionally left out, and the Higress plugin's README shows
what doing it safely takes (strip inbound identity headers at the edge,
before authentication).

**Fail-open is the default** ([degraded-mode](../../../specification/degraded-mode.md)):
an unanswered evaluate — timeout, 429, 5xx, network, a 200 that is not a
verdict — proceeds and is counted (`unchecked`, the counter to alert on).
`OGR_FAIL_MODE=closed` refuses instead, with a 503 distinct from the 403 a
real block produces.

## Limitations (deliberate, for readability)

- **Two protocols.** `openai.chat` and `anthropic.messages`; no
  `openai.responses` route (the Higress plugin and the mitmproxy addon read
  it). Adding one is a `ROUTES` entry plus a reassembler.
- **A blocked stream is a cut, not an error object** — the 200 and the head
  of the reply are already gone; dropping the tail and closing is the
  refusal the spec defines. Clients see an incomplete stream.
- **Spans against a streamed reply** name the reassembled canonical payload
  and cannot be spliced into frames already forwarded; they are counted
  (`unresolved_spans`), never half-applied.
- **No usage opt-in for chat streams**: usage is transcribed when the
  provider reports it and omitted otherwise; the gateway does not inject
  `stream_options.include_usage` on the client's behalf.
- Threads and blocking I/O (`ThreadingHTTPServer`, `urllib`) — one thread per
  in-flight request. Fine for an example and modest traffic; a production
  gateway wants an event loop or a real proxy.

## Test

Fully offline — a mock runtime and a mock provider, both stdlib, with the
real gateway between them (the streamed tail-hold is tested on the actual
byte path a client sees):

```bash
python -m pytest integrations/gateway/openai-anthropic    # from the repo root
```
