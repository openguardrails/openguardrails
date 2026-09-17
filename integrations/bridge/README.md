# Bridge integrations

A **bridge** converts between a provider's LLM protocol and OGR, inside a service
the organization already runs.

It is the third seat, and it is not a plugin for a product this project supports —
it is the conversion itself, for a host nobody here has seen: a Java reverse proxy
somebody's platform team wrote, a Spring Boot façade, an API sidecar, a service
mesh filter. The organization's traffic already flows through it; what it lacks is
the envelope.

| Target | Source |
|---|---|
| Java — a library to embed, plus a runnable reference proxy | [`java/`](java/) |

## Why this is not `gateway/`

A [gateway integration](../gateway/) is a plugin for a **named product** — Higress,
mitmproxy — whose extension point, configuration surface and lifecycle are somebody
else's and already exist. Writing one means learning that product.

A bridge has no product. It is a library plus a documented recipe, and the thing it
plugs into is whatever the customer built. That difference decides almost everything
about how it is written: it can carry no framework, must not force a JSON library on
its host, and has to state the rules it cannot enforce — because the code around it
is code this project will never see.

They share a vantage. A bridge and a gateway both sit on the model channel and both
see one proxied model call as one step; the OGR side is identical, which is why
there is one recipe and not three.

## Why "bridge", and the one thing it must not be called

⚠️ **Not "adapter".** In this repository an *adapter* is a per-protocol reader — one
class that knows how `openai.chat` shapes a reply — and there are three of them
inside the Java bridge alone. A category with the same name would give the word two
referents in one sentence, which is how documentation stops being readable. The
[Runtime API](../../specification/runtime-api.md)'s own worked example already names
this shape: `"integration": "acme-bridge/1.0.0"`.

The metaphor is a plug adapter, and it is load-bearing rather than decorative:
**an adapter changes the shape of the plug and leaves the current alone.** That is exactly the contract —

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
