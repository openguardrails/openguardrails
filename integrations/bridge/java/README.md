# The Java bridge

OGR for a service you already run. A **standalone bridge** your service posts
messages to, and the **zero-dependency `core`** it is built from.

A [bridge](../README.md) is the conversion between a provider's LLM protocol and
OGR, running beside somebody else's service — not a plugin for a product this
project supports, and not a gateway: nothing is re-pointed at it and it forwards
nothing. The metaphor is a plug adapter, and it is the contract rather than
decoration: **it changes the shape of the plug and leaves the current alone.** The
provider body goes on the wire verbatim; only the envelope is ours.

```
   client ──HTTP──▶  your service  ──────────────────────▶ OpenAI / Anthropic
                         │  ▲
            request body │  │ decision + rewritten body    (the reply the same way)
                         ▼  │
                    ogr-bridge-server ── GuardEvent → POST {OGR_URL}/v1/evaluate → Verdict
```

Clients speak **OpenAI Chat Completions**, **OpenAI Responses** or **Anthropic
Messages**; AIRS speaks OGR. The conversion, the enforcement recipe around it, and
every trap worth knowing are written up in **[DESIGN.md](DESIGN.md)** — read that
first, whether you run this server or build the same thing in another language.

| module | what it is |
|---|---|
| [`server/`](server/) | the runnable bridge, on the JDK's own HTTP server: the message door (`/guard/v1/step/*`), plus an inline proxy door kept as the offline test bed for `core`. |
| [`core/`](core/) | the library underneath: protocol adapters, the GuardEvent builder, the `/v1/evaluate` client, the span applier, the placeholder restorer, the streaming head-hold. **Zero dependencies** — the JDK and nothing else — so a Spring Boot / Netty / Vert.x service can embed the conversion in-process instead of running the server beside it. |

> **Why no JSON dependency.** `core` is meant to be embedded in someone else's
> service, and a guardrail that forces a Jackson version onto its host is a
> guardrail an operator has a reason to remove. The second reason is stricter: a
> body that is about to be forwarded must never go through a parse-and-re-serialize
> round trip, because re-encoding reorders keys and re-escapes strings, and every
> offset in a verdict then indexes characters the runtime never counted. Reading and
> rewriting are separate classes here so that rule stays visible.

## Run it

```bash
mvn -q install
OGR_URL=https://ogr.example.com \
OGR_API_KEY=ogr_xxx \
OGR_MODE=enforce \
OGR_AGENT_WORKSPACE=line-a \
java -jar server/target/ogr-bridge-server-1.0.0.jar
```

Your service keeps its own provider connection and asks the bridge about each
message. Two calls per model call, bound by the `step_id` the first one mints:

```bash
# 1. before the provider is called: the request body, verbatim
curl -s localhost:8800/guard/v1/step/request -H 'content-type: application/json' -d '{
  "llm_protocol": "openai.chat",
  "agent_id": "line-a-bot", "session_hint": "conv-123",
  "body": {"model":"gpt-5","messages":[{"role":"user","content":"hello"}]}
}'
# → {"decision":"allow","step_id":"…","body":"unchanged"}
#   nothing changed: forward your own copy.
# → {"decision":"redacted","step_id":"…","body":{…spans applied…},"placeholders":{…}}
#   forward "body" — the returned one — not your copy.
# → {"decision":"block","step_id":"…","body":{…a refusal in the caller's own protocol…}}
#   do not call the provider; answer the client with "body" ("refusal_is_stream": true
#   means it is SSE text). With "continuation":"withhold", "body" is the request to
#   FORWARD instead — the refused content replaced by a notice, the turn continues.

# 2. after the provider answered: the reply body, verbatim
curl -s localhost:8800/guard/v1/step/response -H 'content-type: application/json' -d '{
  "step_id": "…", "placeholders": {…}, "body": {…the provider reply…}
}'
# → {"decision":"allow","body":"unchanged"}            deliver your own copy
# → {"decision":"redacted","body":{…placeholders restored…}}   deliver this one
# → {"decision":"block","body":{…a refusal in the caller's own protocol…}}
#   with "continuation":"drop_calls", "body" is the reply to DELIVER — the refused
#   calls removed, the notice appended, the survivors may run.
```

By default the bridge calls `POST /v1/evaluate?payload=true`
(`OGR_PAYLOAD_FROM_RUNTIME`), so the runtime applies the spans, restores the
placeholders, renders the refusal and carries out the continuation, and the verdict's
`payload` is what the door hands on; against a runtime that answers without one the
bridge applies the verdict locally as before. A service that can call the runtime
itself needs no bridge — and for a streamed reply the runtime takes the
provider's SSE straight in (`Content-Type: text/event-stream` on
`/v1/evaluate`, fields in `ogr-*` headers) and, with `?payload=true`, streams
the guarded frames back behind the same bounded head this bridge's inline door
uses. The full client guide is `openguardrails-airs/docs/evaluate-client-guide.md`.

`body` may be the provider body inline (as above) or a string containing it; the
inline form is taken as its raw character range and never re-serialized.

⚠️ **Two things a bridge gives up**, and they belong in whatever runbook describes
it: streaming enforcement is your service's problem (buffer the reply before asking,
or accept that a judged-after-delivery stream is a record and not a control), and
the `placeholders` map has to travel between the two calls or the reply keeps its
placeholders. The map is returned by the first call and accepted by the second so
a service that load-balances the halves across replicas needs nothing from any one
process's memory. Both are explained in
[DESIGN.md §4](DESIGN.md#4-two-deployment-shapes-and-what-each-gives-up).

**The four-tuple** is required on every event with `""` as the explicit "no
assertion". A real service fills `agent_id` from its own **caller authentication**
(the authenticated caller IS the agent) and `agent_workspace` from an
operator-maintained grouping — and must **strip both from inbound client requests
before authenticating**, or a client picks which policy set judges it. See
[DESIGN.md §2 Job 3](DESIGN.md#job-3--resolve-the-identity-four-tuple).

## Embed `core` instead

A service that would rather not run a second process takes `core` alone (taking
`server` too would drag in an HTTP stack it already has):

```java
OgrConfig config = OgrConfig.builder()
    .baseUrl("https://ogr.example.com")
    .apiKey(System.getenv("OGR_API_KEY"))
    .mode(Mode.ENFORCE)
    .failMode(FailMode.OPEN)
    .build();
OgrGuard guard = new OgrGuard(config).startHeartbeat();   // one per process

// ── per proxied model call ──────────────────────────────────────────────
Protocol protocol = Protocols.detect(path, Json.parseOrNull(rawRequestBody));
if (protocol == null) {
    return forwardUntouched();        // not a completion we can read
}
StepGuard step = guard.newStep(identity, sessionHint, connectionId, dialledHost, "");

RequestOutcome request = step.guardRequest(protocol, rawRequestBody);
if (!request.forwards()) {
    return respond(200, request.refusal);          // the model is never called
}
String rawReply = callProvider(request.body);      // spans already applied

ResponseOutcome reply = step.guardBufferedResponse(rawReply, sentAt, Instant.now());
return respond(200, reply.delivers() ? reply.body : reply.refusal);
```

A service embedding `core` holds the bytes, so it can also do what the message door
cannot: streaming is the same two calls with a `HeadHold` between them — see
[`InlineHandler.streamed`](server/src/main/java/com/openguardrails/ogr/server/InlineHandler.java).

## The inline door (the test bed)

The reference server also answers `/v1/chat/completions`, `/v1/responses` and
`/v1/messages` as a proxy — clients pointed at it, the client's own provider
credentials passed through, spans applied, streamed heads bounded, refusals
rendered in-stream. It is there so that `core`'s streaming and span code is
exercised through a real byte path by the offline tests, and it is documentation
that runs. **It is not the deployment shape of a bridge**: a standalone process
that takes the `base_url` is a gateway, which is the job the products under
[`../../gateway/`](../../gateway/) already do.

```bash
# OpenAI SDK: base_url=http://localhost:8800/v1
curl -s localhost:8800/v1/chat/completions \
  -H "authorization: Bearer $OPENAI_API_KEY" -H "content-type: application/json" \
  -d '{"model":"gpt-5","messages":[{"role":"user","content":"hello"}]}'
```

A block comes back as **HTTP 200 in the caller's own protocol** with
`x-ogr-decision: block` — not a 4xx, because every client renders an assistant
message while a 4xx surfaces as a transport failure that explains nothing, and many
agent harnesses retry it.

## Configuration

| variable | default | meaning |
|---|---|---|
| `OGR_URL` | `http://localhost:3000` | runtime base URL; canonical `/v1/*` paths are joined onto it |
| `OGR_BASE_PATH` | `""` | mount prefix, when the runtime serves `/v1/*` under one |
| `OGR_API_KEY` | — | organization API key; authenticates the SENDER and resolves the org |
| `OGR_MODE` | `observe` | `enforce` to act on verdicts. Observe reports and never waits, so it adds no latency |
| `OGR_FAIL_MODE` | `open` | `closed` refuses when no verdict arrives — including a verdict whose `unjudged` names paths |
| `OGR_TIMEOUT_MS` | `5000` | the evaluate budget. A CEILING for the worst case, not a target; the runtime's own model timeout must fit strictly inside it |
| `OGR_AGENT_ID` / `OGR_AGENT_TYPE` / `OGR_AGENT_WORKSPACE` | `""` | static four-tuple values for a bridge fronting exactly one agent; a message may carry its own. There is no static `agent_user` — a constant user is already what the identity floor gives you |
| `OGR_CALLER_FALLBACK` | `true` | inline door only: when nothing names the agent, fingerprint the client's own credential into `caller-<hash>` |
| `OGR_PAYLOAD_FROM_RUNTIME` | `true` | ask the runtime for the rewritten body (`?payload=true`) and hand it on; `false` applies every verdict locally |
| `OGR_STREAM_HEAD_RELEASE_BYTES` | `32` | inline door only: client-visible content a streamed answer may deliver BEFORE the end-of-stream verdict. `0` releases nothing |
| `OGR_UPSTREAM_OPENAI` | `https://api.openai.com` | inline door only: where `/v1/chat/completions` and `/v1/responses` forward |
| `OGR_UPSTREAM_ANTHROPIC` | `https://api.anthropic.com` | inline door only: where `/v1/messages` forwards |
| `OGR_PROXY_PORT` | `8800` | listen port |

## Deliberate limitations

- **Three protocols.** `openai.chat`, `openai.responses`, `anthropic.messages`.
  Adding one is a new file implementing `Protocol`, a line in `Protocols`, and a row
  in the conformance test.
- **The message door judges whole bodies.** A streamed reply is your service's to
  reassemble before it asks; the bridge never sees frames.
- **A streamed `drop_calls` degrades to a retraction** (inline door). The frames are
  already written; rendering surviving calls mid-stream is expressible but not
  implemented here, and falling back to the strict side is the correct default.
- **Spans against a streamed reply cannot be spliced into frames already forwarded**
  (inline door). They are counted, never half-applied.
- **`openai.chat` stream usage is transcribed, not requested.**
  `OpenAiChat.ensureStreamUsage` exists and the reference server does not call it: a
  proxy that injects `stream_options.include_usage` on the client's behalf then owes
  the client a stream without the extra frame it never asked for.
- **The reference server is one thread per in-flight request** (`HttpServer`,
  blocking I/O). Fine for the example and modest traffic; a production service
  brings its own I/O model, which is why `core` has none.

## Build and test

```bash
mvn -q install          # both modules
mvn test                # 64 tests, fully offline
```

The tests are offline by construction: a mock runtime and a mock provider, both
stdlib, with the **real server between them** — the message door exercised as a
service would call it, and the inline door so the streamed byte path is exercised as
a client actually sees it. `ConformanceTest` is one conversation written three
times, and adding a protocol means adding a row to it.
