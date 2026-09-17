# Integrations (the plugin layer)

Integrations are the **plugin layer** of OGR's API → Plugin stack: code at one
seat that observes steps, builds `GuardEvent`s and enforces `Verdict`s, speaking
the [Runtime API](../specification/runtime-api.md) (`/v1/evaluate`) directly.
There is no SDK layer: each integration implements
[the recipe](../specification/runtime-api.md#the-recipe) — one recipe for every
seat since v0.8.

Three categories, decided by one question: **what does the code hold, and whose
process is it in?**

| Category | Where the code runs | What it holds | What it is |
|---|---|---|---|
| [`gateway/`](gateway/) — **gateway plugins** | inside a product that IS the LLM byte path: an enterprise gateway (Higress), a local agent firewall (OpenAFW), a debugging proxy (mitmproxy) | the request and reply **bytes**, streaming included | A plugin for that product's extension point. Holding the stream is what lets it do the two things nothing else can: apply redaction spans in full, and refuse before the model sees anything — streaming included. Fills the four-tuple from the product's own caller authentication. |
| [`bridge/`](bridge/) — **standalone bridges** | its own process, beside a service the organization already runs | one **message** at a time — a request body, later the reply body (a streamed reply is one message too: relayed in, guarded frames out) — never the provider connection | A converter between a provider's LLM protocol and OGR. The organization's service posts the message, gets back the decision and the rewritten body, and keeps forwarding to the provider itself. Not a plugin: nothing here plugs into anyone's product, and no `base_url` moves. |
| [`agent/`](agent/) — **agent plugins** | inside the harness loop | the model call itself, or — at hook-based hosts — the tool call about to execute | Every harness exposes a different seam (a hook, an interceptor, a callback), so each plugin speaks OGR directly against whatever its host exposes; there is no shared conversion to factor out. Fills the four-tuple from its own config. Only this seat runs on the host the secret lives on, which is what [local redaction](../specification/local-redaction.md) needs. |

The first two share a vantage — the model channel: one proxied model call = one
step, provider bodies verbatim — and their OGR side is identical, which is why there
is one recipe and not three. They differ in what the code holds: a gateway plugin
holds the bytes and can enforce on a stream from inside the path; a bridge holds a
message and answers about it — including a streamed reply a service relays through it,
which is enforcement bought with a hop rather than with the byte path. A gateway plugin can always be built out of a bridge's conversion (the
Java bridge's `core` is written to be reused that way); the reverse is not true.

⚠️ **A bridge takes messages, never the `base_url`.** A standalone process that
clients are re-pointed at and that forwards bytes upstream to a provider is a
gateway — and building one more of those is the job the products in `gateway/`
already do, with their own I/O model, caller authentication and operations. A
bridge deliberately stops at the message so the organization's own proxy or façade
keeps all of that and gains the decision.

## Status (2026-09-17)

- **Gateway plugins** — [`gateway/higress`](gateway/higress/), the reference
  gateway plugin (Go/WASM, CI-covered); [`gateway/openafw`](gateway/openafw/), the
  OGR connection inside [OpenAFW](https://github.com/openguardrails/openafw), the
  local AI firewall for coding agents (Rust; the code lives in that repository, and
  it is the one gateway plugin that also does local redaction, because it is the one
  running on the host); [`gateway/mitmproxy`](gateway/mitmproxy/), a mitmproxy
  addon; [`gateway/openai-anthropic`](gateway/openai-anthropic/), the readable
  single-file reference of what a gateway plugin does — documentation that runs.
- **Standalone bridges** — [`bridge/java`](bridge/java/): a runnable bridge exposing
  the message door (`POST /guard/v1/step/request`, `POST /guard/v1/step/response`)
  for `openai.chat`, `openai.responses` and `anthropic.messages`, built on a
  zero-dependency `core` (CI-covered). Its [`DESIGN.md`](bridge/java/DESIGN.md) is
  the language-neutral write-up of what the conversion requires. **The runtime
  renders the result on request** — `POST /v1/evaluate?payload=true` adds a
  `payload` to the verdict (`"unchanged"`, the rewritten body, or the refusal in the
  caller's protocol) — so a service that can call the runtime directly needs no
  bridge process; the client guide is `openguardrails-airs/docs/evaluate-client-guide.md`.
- **Agent plugins** — [`agent/dsh`](agent/dsh/), the reference agent-direct plugin
  (npm workspace, CI-covered); [`agent/litellm`](agent/litellm/) (proxy enforcing,
  SDK observe-only); [`agent/langgraph`](agent/langgraph/),
  [`agent/hermes`](agent/hermes/), [`agent/claude-code`](agent/claude-code/),
  [`agent/codex`](agent/codex/), [`agent/openclaw`](agent/openclaw/),
  [`agent/opencode`](agent/opencode/). [Local redaction](../specification/local-redaction.md)
  (OGR 1.4): hermes 2.0, opencode 0.4, openclaw 0.4 in-process; Claude Code and
  Codex through the bundled [`agent/ogr-local`](agent/ogr-local/) loopback proxy.
  An enterprise gateway does not do it — the runtime masks on its behalf.
