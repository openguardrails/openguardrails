# The Java bridge

OGR for a service you already run. A **library** a Java service embeds, and a
**runnable reference proxy** built on it.

A [bridge](../README.md) is the conversion between a provider's LLM protocol and
OGR, living inside somebody else's service — not a plugin for a product this
project supports. The metaphor is a plug adapter, and it is the contract rather than
decoration: **it changes the shape of the plug and leaves the current alone.** The provider body goes on the wire verbatim; only the envelope is ours.

```
   client ──HTTP──▶  your service (ogr-bridge-core)  ──▶ OpenAI / Anthropic
                            │
                            └── GuardEvent → POST {OGR_URL}/v1/evaluate → Verdict
```

Clients speak **OpenAI Chat Completions**, **OpenAI Responses** or **Anthropic
Messages**; AIRS speaks OGR. The conversion, the enforcement recipe around it, and
every trap worth knowing are written up in **[DESIGN.md](DESIGN.md)** — read that
first if you are building this into a proxy of your own.

| module | what it is |
|---|---|
| [`core/`](core/) | the library: protocol adapters, the GuardEvent builder, the `/v1/evaluate` client, the span applier, the streaming head-hold. **Zero dependencies** — the JDK and nothing else. |
| [`server/`](server/) | a runnable proxy on the JDK's own HTTP server. Documentation that runs, and the offline test bed for `core`. |

A Spring Boot / Netty / Vert.x service takes **`core` alone**; taking `server` too
would drag in an HTTP stack it already has.

> **Why no JSON dependency.** This code is meant to be embedded in someone else's
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
OGR_AGENT_ID=my-proxy \
OGR_AGENT_WORKSPACE=line-a \
java -jar server/target/ogr-bridge-server-1.0.0.jar
```

Point any client at it — the proxy forwards the client's own provider credentials:

```bash
# OpenAI SDK: base_url=http://localhost:8800/v1
curl -s localhost:8800/v1/chat/completions \
  -H "authorization: Bearer $OPENAI_API_KEY" -H "content-type: application/json" \
  -d '{"model":"gpt-5","messages":[{"role":"user","content":"hello"}]}'

# Anthropic SDK: base_url=http://localhost:8800
curl -s localhost:8800/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-4-5","max_tokens":64,
       "messages":[{"role":"user","content":"hello"}]}'
```

A block comes back as **HTTP 200 in the caller's own protocol** with
`x-ogr-decision: block` — not a 4xx, because every client renders an assistant
message while a 4xx surfaces as a transport failure that explains nothing, and many
agent harnesses retry it.

## Embed it

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

Streaming is the same two calls with a `HeadHold` between them; see
[`InlineHandler.streamed`](server/src/main/java/com/openguardrails/ogr/server/InlineHandler.java).

## The out-of-band door

For a proxy that already holds both bodies and wants a decision rather than a byte
path:

```bash
curl -s localhost:8800/guard/v1/step/request -H 'content-type: application/json' -d '{
  "llm_protocol": "openai.chat",
  "agent_id": "line-a-bot", "session_hint": "conv-123",
  "body": {"model":"gpt-5","messages":[{"role":"user","content":"hello"}]}
}'
# → {"decision":"allow","step_id":"…","body":{…rewritten…},"placeholders":{…}}

curl -s localhost:8800/guard/v1/step/response -H 'content-type: application/json' -d '{
  "step_id": "…", "placeholders": {…}, "body": {…the provider reply…}
}'
# → {"decision":"block","refusal":{…in the caller's own protocol…}}
```

`body` may be the provider body inline (as above) or a string containing it; the
inline form is taken as its raw character range and never re-serialized.

⚠️ **Two things this lane gives up**, and they belong in whatever runbook describes
it: streaming enforcement is the caller's problem, and the `placeholders` map has to
travel between the two calls or the reply keeps its placeholders. Both are explained
in [DESIGN.md §4](DESIGN.md#4-two-deployment-shapes-and-what-each-gives-up).

## Configuration

| variable | default | meaning |
|---|---|---|
| `OGR_URL` | `http://localhost:3000` | runtime base URL; canonical `/v1/*` paths are joined onto it |
| `OGR_BASE_PATH` | `""` | mount prefix, when the runtime serves `/v1/*` under one |
| `OGR_API_KEY` | — | organization API key; authenticates the SENDER and resolves the org |
| `OGR_MODE` | `observe` | `enforce` to act on verdicts. Observe reports and never waits, so it adds no latency |
| `OGR_FAIL_MODE` | `open` | `closed` refuses when no verdict arrives — including a verdict whose `unjudged` names paths |
| `OGR_TIMEOUT_MS` | `5000` | the evaluate budget. A CEILING for the worst case, not a target; the runtime's own model timeout must fit strictly inside it |
| `OGR_STREAM_HEAD_RELEASE_BYTES` | `32` | client-visible content a streamed answer may deliver BEFORE the end-of-stream verdict. `0` releases nothing |
| `OGR_AGENT_ID` / `OGR_AGENT_TYPE` / `OGR_AGENT_WORKSPACE` | `""` | static four-tuple values for a route fronting exactly one agent. There is no static `agent_user` — a constant user is already what the identity floor gives you |
| `OGR_CALLER_FALLBACK` | `true` | when nothing names the agent, fingerprint the client's own credential into `caller-<hash>` |
| `OGR_UPSTREAM_OPENAI` | `https://api.openai.com` | where `/v1/chat/completions` and `/v1/responses` forward |
| `OGR_UPSTREAM_ANTHROPIC` | `https://api.anthropic.com` | where `/v1/messages` forwards |
| `OGR_PROXY_PORT` | `8800` | listen port |

**The four-tuple** is required on every event with `""` as the explicit "no
assertion". A real proxy fills `agent_id` from its own **caller authentication** (the
authenticated caller IS the agent) and `agent_workspace` from an operator-maintained
grouping — and must **strip both from inbound client requests before authenticating**,
or a client picks which policy set judges it. See
[DESIGN.md §2 Job 3](DESIGN.md#job-3--resolve-the-identity-four-tuple).

## Deliberate limitations

- **Three protocols.** `openai.chat`, `openai.responses`, `anthropic.messages`.
  Adding one is a new file implementing `Protocol`, a line in `Protocols`, and a row
  in the conformance test.
- **A streamed `drop_calls` degrades to a retraction.** The frames are already
  written; rendering surviving calls mid-stream is expressible but not implemented
  here, and falling back to the strict side is the correct default.
- **Spans against a streamed reply cannot be spliced into frames already forwarded.**
  They are counted, never half-applied.
- **`openai.chat` stream usage is transcribed, not requested.**
  `OpenAiChat.ensureStreamUsage` exists and the reference server does not call it: a
  proxy that injects `stream_options.include_usage` on the client's behalf then owes
  the client a stream without the extra frame it never asked for.
- **The reference server is one thread per in-flight request** (`HttpServer`,
  blocking I/O). Fine for the example and modest traffic; a production proxy brings
  its own I/O model, which is why `core` has none.

## Build and test

```bash
mvn -q install          # both modules
mvn test                # 64 tests, fully offline
```

The tests are offline by construction: a mock runtime and a mock provider, both
stdlib, with the **real proxy between them** — so the streamed byte path is exercised
as a client actually sees it. `ConformanceTest` is one conversation written three
times, and adding a protocol means adding a row to it.
