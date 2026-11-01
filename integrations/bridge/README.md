# Standalone bridges

A **bridge** is a standalone process that converts between a provider's LLM
protocol and OGR, for a service the organization already runs. That service — a
Java reverse proxy somebody's platform team wrote, a Spring Boot façade, an API
sidecar, a service-mesh filter — keeps terminating its clients and calling the
provider exactly as it does today. It posts each **message** to the bridge and gets
back the decision and the rewritten body:

```
  client ──▶ your service ─────────────────────────────▶ provider
                 │   ▲
    request body │   │ decision + rewritten body        (the reply goes the same way)
                 ▼   │
               bridge ── GuardEvent → POST {OGR_URL}/v1/evaluate → Verdict
```

Two calls per model call, bound by the `step_id` the bridge mints:

| call | in | out |
|---|---|---|
| `POST /guard/v1/step/request` | `llm_protocol`, the four-tuple, `session_hint`, the provider request body | `decision`, `step_id`, `body`, `placeholders` |
| `POST /guard/v1/step/response` | `step_id`, `placeholders`, the provider reply body | `decision`, `body` |

Three decisions, and `body` means what the decision says: **`allow`** — nothing
changed, `body` is the literal `"unchanged"` and the caller uses its own copy;
**`redacted`** — the body was rewritten (spans applied on the way out, placeholders
restored on the way back) and the caller must use the returned one; **`block`** — the
full content the caller needs: a refusal rendered in the caller's own protocol, or,
with a `continuation`, the body to forward/deliver with the refused part removed.

> ⚠️ **All of that is the bridge's own work, from the plain decision call.** One
> `POST /v1/evaluate` per half, one ordinary verdict back, and the bridge carries it
> out: spans applied at code-point offsets, placeholders put back, the refusal
> rendered in the caller's protocol, a continuation executed, a streamed reply held
> behind its bounded head. Nothing here depends on an optional extension of the
> decision path, so a bridge keeps working against a runtime older or newer than
> itself — and the same list is exactly what a bridge in another language has to do.

| Target | Source |
|---|---|
| Java — a runnable bridge, plus the zero-dependency `core` it is built from | [`java/`](java/) |

## What a bridge is not

**Not a gateway plugin.** A [gateway plugin](../gateway/) runs inside a product that
is the byte path — Higress, OpenAFW, mitmproxy — through an extension point that
already exists. A bridge has no product to plug into: the code around it is code
this project will never see, which is why it carries no framework, forces no JSON
library on anyone, and has to state the rules it cannot enforce.

**Not a gateway.** A bridge does not take the `base_url`. Nothing is re-pointed at it
and it forwards nothing to any provider. The moment it did, it would be one more
gateway — and the products in `gateway/` already do that job with their own I/O model,
their own caller authentication and their own operations. The bridge stops at the
message so the organization's service keeps all of that.

⚠️ **The line is the provider connection, not the bytes.** A streamed reply IS one
message, so a service may relay the provider's frames through the bridge and get the
guarded frames back — which is the only way an end-of-stream decision is still an
enforcement rather than a record. The bridge still dials nobody: the service keeps its
own provider connection, and what it hands over is a reply it already holds.

**What that costs, said out loud.** Streamed enforcement costs a hop — the reply bytes
pass through the bridge — and a service that will not pay it gets a record instead: a
streamed reply judged after delivery, or reassembled and posted as one body. And the
request's redaction spans are applied by the bridge into the body it returns, so the
service must forward the returned body and not its own copy. Both are stated in the
Java bridge's
[DESIGN.md §4](java/DESIGN.md#4-two-deployment-shapes-and-what-each-gives-up).

⚠️ The Java reference server also answers as an inline proxy on `/v1/*`. That door
exists so `core`'s streaming and span code is tested through a real byte path — a
mock runtime, a mock provider, the real server between them — and it is the test
bed, not the deployment shape of a bridge.

## Why "bridge", and the one thing it must not be called

⚠️ **Not "adapter".** In this repository an *adapter* is a per-protocol reader — one
class that knows how `openai.chat` shapes a reply — and there are three of them
inside the Java bridge alone. A category with the same name would give the word two
referents in one sentence, which is how documentation stops being readable. The
[Runtime API](../../specification/runtime-api.md)'s own worked example already names
this shape: `"integration": "acme-bridge/1.0.0"`.

The metaphor is a plug adapter, and it is load-bearing rather than decorative:
**an adapter changes the shape of the plug and leaves the current alone.** That is
exactly the contract —

> The provider body goes on the wire **verbatim**, as `payload`. Only the envelope
> around it is ours.

— and it is not a stylistic preference. A verdict's `modifications.spans` carry
offsets into the payload *as transported*, so a bridge that parsed the body and
re-serialized it would have reordered its keys and re-escaped its strings, and every
redaction the runtime asked for would land on characters it never counted, while the
log said "masked". A bridge that translates is a bridge that is silently wrong.

## Building one

[`java/DESIGN.md`](java/DESIGN.md) is the language-neutral write-up: what a bridge
has to do, job by job, each rule carrying the failure it prevents. Read it before
building one in any language — most of it is not about Java and most of the failures
it names were measured, not imagined.
