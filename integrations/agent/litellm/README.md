# openguardrails-litellm

**OpenGuardrails for [litellm](https://github.com/BerriAI/litellm) — a v0.8
agent-direct integration.**

This package implements **the one normative recipe of the v0.8
[Runtime API](../../../specification/runtime-api.md#the-recipe)** on
litellm's hook surface: per model call, two POSTs to `/v1/evaluate` —
`step/request` while litellm is holding what it is about to send,
`step/response` while it is holding the answer before anyone acts on it.
litellm normalizes every provider to the OpenAI chat shape, so events carry
`llm_protocol: "openai.chat"` and the payloads are exactly what litellm
holds: the request kwargs, the ModelResponse — forwarded raw (minus litellm's
own bookkeeping and credentials, which are not part of any provider body).

**No SDK.** The wire is two hand-rolled POSTs on `urllib.request` in
[`openguardrails_litellm/wire.py`](openguardrails_litellm/wire.py) — the core
has **zero dependencies** beyond the standard library.

One class, `OpenGuardrails`, works in both seats litellm offers — but they
are not equal, and this README says so plainly:

| Seat | Hooks that fire | Enforcement |
| --- | --- | --- |
| **litellm proxy** (callbacks in `config.yaml`) | `async_pre_call_hook`, `async_post_call_success_hook`, `async_post_call_streaming_iterator_hook` | **Full.** A `block` on the request means the model is never called; on the response, the client never receives it (HTTP 400 `blocked_by_openguardrails`); on a stream, the held stream is dropped and no tool call runs. |
| **litellm SDK** (`litellm.callbacks = [OpenGuardrails()]`) | `log_pre_api_call` / `log_success_event` (+ async variants) | **Observe-only.** litellm swallows exceptions raised from logging callbacks, so this seat cannot stop a call. Every step is still recorded and judged; a would-be block is logged loudly (`logging` channel `openguardrails`) and counted in `counters["blocks"]`. For SDK-side *enforcement*, run the loop through the proxy — or make the two `evaluate` calls yourself, which is [the whole recipe](../../../specification/runtime-api.md#the-minimal-integration-your-own-agent). |

## Quick start — proxy (enforcing)

`custom_callbacks.py`, next to your proxy `config.yaml`:

```python
from openguardrails_litellm import OpenGuardrails

guard = OpenGuardrails()          # reads OGR_* from the environment
```

`config.yaml`:

```yaml
litellm_settings:
  callbacks: custom_callbacks.guard
```

Environment:

```sh
OGR_RUNTIME_URL=https://ogr.example.com   # a mounted prefix belongs IN the URL
OGR_API_KEY=ogr_…                         # get one at openguardrails.com
```

No URL or no key = the integration is **off**, and says so once in the log.
`fail_mode` governs a runtime that stopped *answering*, never one that was
never configured.

## Quick start — SDK (observe-only)

```python
import litellm
from openguardrails_litellm import OpenGuardrails

litellm.callbacks = [OpenGuardrails(agent_id="invoice-bot",
                                    agent_user="u-8232")]

litellm.completion(model="gpt-4o", messages=[...])   # judged, recorded —
                                                     # not blockable here
```

## Configuration

Constructor arguments win; environment variables are the fallback; the
default is last.

| Argument | Env | Default | Meaning |
| --- | --- | --- | --- |
| `runtime_url` | `OGR_RUNTIME_URL` | — (off) | Base URL, joined with canonical `/v1/...` paths |
| `api_key` | `OGR_API_KEY` | — (off) | Organization API key (`Authorization: Bearer`) |
| `agent_id` | `OGR_AGENT_ID` | `""` | WHICH agent — e.g. `"invoice-bot"` |
| `agent_type` | `OGR_AGENT_TYPE` | `"litellm"` | What KIND — the harness label |
| `agent_workspace` | `OGR_AGENT_WORKSPACE` | `""` | Agent GROUP — one workspace, one policy set, e.g. `"finance-agents"` |
| `agent_user` | `OGR_AGENT_USER` | `""` | Who is USING it this session, e.g. `"u-8232"` |
| `fail_mode` | `OGR_FAIL_MODE` | `"open"` | `open` \| `closed` — see below |
| `timeout` | `OGR_TIMEOUT` | `5.0` | Per-evaluate timeout, seconds |

### The identity four-tuple

All four fields ride on **every** event; the empty string is the explicit
"no assertion", never an error. An all-empty four-tuple is still fully
attributable — the runtime derives the agent from the API key (the
[identity floor](../../../specification/guard-event.md#the-api-key-is-the-identity-floor)).
Each field you fill refines the picture: `agent_id` is what policy and the
inventory key on; `agent_workspace` picks the policy set; and
`agent_user` are accountability attributes, never policy boundaries.

## Degraded mode (`fail_mode`)

Per [the degraded-mode spec](../../../specification/degraded-mode.md), an
unanswered evaluate (timeout, 429, 5xx, network) is handled locally:

- **`open`** (default): the step proceeds; the gap is loud — a warning per
  step, `counters["evaluate_errors"]`, and the heartbeat carries the
  counters so the runtime can see the integration went dark.
- **`closed`**: the step is denied until the runtime answers again — and a
  verdict whose `unjudged` is non-empty is treated the same way ("could not
  look" is not "found nothing").

`send_heartbeat()` POSTs `/v1/heartbeat` with the build id and counters;
call it on a timer if you want fleet coverage to distinguish idle from dark.

## Streaming

A streamed response is judged **exactly once, whole, at stream end** —
never chunk-by-chunk. litellm's `async_post_call_streaming_iterator_hook`
wraps the entire stream, so from this seat the v0.8
[tail-hold](../../../specification/runtime-api.md#streaming-hold-the-tail-judge-once)
degenerates to **tail = ∞**: every chunk is buffered, the reassembled
response (litellm's own `stream_chunk_builder` when it can produce a raw
`openai.chat` body, the spec's `canonical` shape otherwise) gets the step's
one `step/response` evaluate, and then `allow` releases the buffer while
`block` aborts the stream — no chunk reached the client early, and no tool
call ran (a provider stream only completes tool calls at its end). The cost
is time-to-first-token for streaming clients; a shorter held tail is not
expressible from litellm's hook surface, which never lets the plugin release
a prefix while retaining the rest of a live stream.

Reassembled canonical payloads omit `usage` rather than report zeros — this
integration holds no tokenizer, and absence is the honest value.

## What is judged, exactly

Chat completions (`call_type` `completion` / `acompletion`). Embeddings,
image generation, transcription etc. pass through unjudged — they are not
the LLM-message plane this contract observes. `step_id` is litellm's own
`litellm_call_id` (the proxy mints it into the request before the pre-call
hook and the same id reaches every later hook); if a deployment somehow
omits it, one is minted and stashed in the request `metadata`, which litellm
carries to the other half. In the proxy, where litellm fires *both* the
enforcing hooks and the logging events for the same call, the enforcing
hooks claim the `step_id` first and the logging events stand down — one
step, two events, never four.

## Limitations

- **SDK seat cannot block** (litellm swallows logging-callback exceptions);
  it observes, records, and counts. Stated above, honestly.
- **Streaming holds the whole stream** (tail = ∞), not a partial tail — a
  litellm hook cannot release a prefix of a live stream and still refuse
  its end.
- **Older litellm** without `async_post_call_streaming_iterator_hook`
  leaves proxy streams unjudged (the per-chunk
  `async_post_call_streaming_hook` is deliberately not used: v0.8 removed
  chunk-by-chunk evaluates).
- Tool *results* need no call of their own — they travel in the next
  `step/request`, exactly as the recipe says.

## Tests

Fully offline: a stdlib `http.server` mock runtime that strictly validates
every event against the ten-field v0.8 GuardEvent shape, and a fake
`litellm` injected via `sys.modules` (litellm itself is never required).

```sh
python -m pytest integrations/agent/litellm   # from the repo root
```
