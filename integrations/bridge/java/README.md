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

### A streamed reply: the same door, the frames as the body

A streamed reply has no single body to put in `body`, and by the time it has one the
client has already read it. So the response door takes the **frames**, and answers with
the frames to forward:

```bash
curl -sN localhost:8800/guard/v1/step/response \
  -H 'content-type: text/event-stream' \
  -H 'ogr-step-id: <the one the request half minted>' \
  -H 'ogr-llm-protocol: openai.chat' \
  -H 'ogr-head-release-bytes: 32' \
  --data-binary @provider-reply.sse
# → text/event-stream: at most 32 bytes of client-visible content released LIVE, the
#   rest held until the verdict, placeholders restored frame by frame, then either the
#   held remainder or a refusal in the caller's own protocol — and a last line
#   : ogr {"decision":"allow","step_id":"…","event_id":"…","llm_protocol":"openai.chat"}
```

Relay what comes back to your client and forward nothing else. The trailing `: ogr` line
is an SSE **comment**, which every parser ignores by definition, so it may be relayed
along with the frames; it also carries `degraded`, `unjudged` and `unreadable` when they
apply. The envelope's other fields ride headers — `ogr-agent-id`, `ogr-agent-type`,
`ogr-agent-workspace`, `ogr-agent-user`, `ogr-session-hint`, `ogr-connection`,
`ogr-llm-endpoint`, `ogr-initiator` — and `ogr-placeholders` (a compact JSON object)
carries the request half's mapping when the two halves land on different replicas.

⚠️ **`ogr-step-id` is required here**, unlike the JSON call: the mapping a streamed reply
must restore frame by frame is found by it, and a stream that cannot restore delivers
`${OGR_EMAIL_1}` to the client. ⚠️ **A request half cannot be streamed** (`400`): a
request is one body, judged before anything is sent. ⚠️ **The price is a hop** — your
reply bytes now pass through the bridge. `?verdict_only=true` judges the same uploaded
stream and answers a plain JSON verdict with no frames back: a record rather than a
control, for a caller that will not pay the hop but still wants the model's output side
to exist in the event store.

⚠️ There is no `ogr-fail-mode`: the fail mode is the operator's setting
(`OGR_FAIL_MODE`), and a caller that could choose fail-open per stream could opt out of
the policy by asking. The headers are spelled `ogr-*` rather than `x-ogr-*` because they
are this envelope's own fields carried as headers — the same four the JSON call names in
its body — and not the
[gateway header table](../../../specification/runtime-api.md#at-a-gateway-the-four-tuple-arrives-as-headers),
whose entries are claims a proxy reads off someone else's request and must strip first.

⚠️⚠️ **The whole door is built on the plain decision call**, and that is deliberate: one
`POST /v1/evaluate` per half, one ordinary verdict back, and this process does everything
the verdict asks for — applies the spans at their code-point offsets, learns and restores
the placeholders (frame by frame on a stream), renders the refusal in the caller's
protocol, carries out a `withhold` or `drop_calls`, bounds the streamed head. Nothing is
asked of the runtime beyond the one endpoint the specification requires, so the bridge
runs against any conformant runtime at any version, with no optional extension switched
on and nothing to negotiate. A service that would rather do all of that itself can call
the runtime directly and needs no bridge — the client guide for that is
`openguardrails-airs/docs/evaluate-client-guide.md`.

`body` may be the provider body inline (as above) or a string containing it; the
inline form is taken as its raw character range and never re-serialized.

⚠️ **What a bridge asks of you**, and it belongs in whatever runbook describes it: the
`placeholders` map has to travel between the two calls or the reply keeps its
placeholders. The map is returned by the first call and accepted by the second so
a service that load-balances the halves across replicas needs nothing from any one
process's memory. And a streamed reply posted as one reassembled body is a **record,
not a control** — nothing can be withheld from an answer already delivered; use the
streamed transport above for the other case. Both are explained in
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
| `OGR_STREAM_HEAD_RELEASE_BYTES` | `32` | client-visible content a streamed answer may deliver BEFORE the end-of-stream verdict, on both streaming lanes. `0` releases nothing; a message-door caller may override per stream with `ogr-head-release-bytes` |
| `OGR_UPSTREAM_OPENAI` | `https://api.openai.com` | inline door only: where `/v1/chat/completions` and `/v1/responses` forward |
| `OGR_UPSTREAM_ANTHROPIC` | `https://api.anthropic.com` | inline door only: where `/v1/messages` forwards |
| `OGR_PROXY_PORT` | `8800` | listen port |

## Deliberate limitations

- **Three protocols.** `openai.chat`, `openai.responses`, `anthropic.messages`.
  Adding one is a new file implementing `Protocol`, a line in `Protocols`, and a row
  in the conformance test.
- **A streamed `drop_calls` degrades to a retraction.** The frames are already written;
  rendering surviving calls mid-stream is expressible but not implemented here, and
  falling back to the strict side is the correct default.
- **Spans against a streamed reply cannot be spliced into frames already forwarded.**
  They are counted, never half-applied.
- **No keepalive timer on the streamed door.** One `: keepalive` comment goes out as the
  judge starts, which is the moment the lane goes quiet; the pause is bounded by
  `OGR_TIMEOUT_MS`, and a thread per in-flight stream would buy less than it costs.
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
mvn test                # 74 tests, fully offline
```

The tests are offline by construction: a mock runtime and a mock provider, both
stdlib, with the **real server between them** — the message door exercised as a
service would call it (its streamed transport over a raw socket, because the JDK's own
HTTP client will not surface a response before it has finished sending the request body,
and a test written with it could not tell a live head from a buffered one), and the
inline door so the streamed byte path is exercised as a client actually sees it. `ConformanceTest` is one conversation written three
times, and adding a protocol means adding a row to it.
