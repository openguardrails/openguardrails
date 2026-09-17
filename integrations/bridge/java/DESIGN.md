# What a bridge has to do to speak OGR

This document is for anyone putting OpenGuardrails AIRS beside a service their own
traffic already flows through — a Java reverse proxy, a Spring Boot gateway, a
sidecar, an API façade — as a standalone process that service posts messages to, or
as a library it embeds. The clients speak **OpenAI Chat Completions**, **OpenAI
Responses** or **Anthropic Messages**; AIRS speaks **OGR**. The work in between is
what this file describes, job by job, with the reason for each and the failure it
prevents.

That work is a **bridge** ([`integrations/bridge/`](../README.md)) — a plug adapter
between the two protocols, and the metaphor is the contract: an adapter changes the
shape of the plug and leaves the current alone.

It is written from a working implementation: [`core/`](core/) is the library and
[`server/`](server/) is the runnable bridge built on it (its inline proxy door is
the offline test bed for the streaming and span code, not the deployment shape). Where a rule below is
load-bearing, the code that keeps it is named.

> **The one-sentence version.** OGR conversion is *not* a schema translation. The
> provider body goes onto the wire **verbatim**, as `payload`, and the runtime
> classifies it. What the proxy owes is a small envelope around that body, two
> calls per model call, and the discipline to act on the answers.

---

## 1. The shape of the problem

One proxied model call is **one STEP**, reported as **two events** bound by one
`step_id`:

```
                    ┌──────────────── step/request ───────────────┐
  client ──────────▶│  proxy  ──── POST /v1/evaluate ───▶ AIRS     │──▶ provider
                    └─────────────────────────────────────────────┘
                    ┌──────────────── step/response ──────────────┐
  client ◀──────────│  proxy  ◀─── POST /v1/evaluate ──── AIRS     │◀── provider
                    └─────────────────────────────────────────────┘
```

Both calls go to the same endpoint, `POST /v1/evaluate`. There is no second event
channel, no batch form and no SDK. The full contract is
[`specification/runtime-api.md`](../../../specification/runtime-api.md); this file
is the proxy-builder's reading of it.

**Step 2 is the enforcement moment that matters most.** The model's tool calls,
held *before* execution, are the only copy of an action anyone can still refuse.
A proxy that reports requests and not replies is an audit log, not a control.

### Why the payload is not translated

The instinct is to normalize the three provider shapes into one internal model and
send that. Resist it:

- **A verdict's offsets index the body AS TRANSPORTED.** `modifications.spans`
  comes back as `{path, start, end, replacement}` against the payload you sent. If
  you sent a normalized copy, the path names a location that exists only inside
  your proxy, and the redaction the runtime asked for lands nowhere — or worse, on
  the wrong characters.
- **Normalization is lossy in a way nothing reports.** A `thinking` block, a
  `tool_result` marked `is_error`, an interleaved text/tool_use sequence — each has
  to be flattened into a shape with no field for it. A guardrail then cannot tell
  "the model said nothing" from "the renderer dropped it".
- **One protocol would have to win**, and `openai.chat` is the oldest of the three
  and the one OpenAI is moving off.

So: `payload` is the provider's own bytes, and `llm_protocol` says which dialect
they are. The proxy still needs per-protocol code, but only for the four things a
raw forwarder genuinely cannot avoid — detection, stream reassembly, refusal
rendering, and putting redacted values back. Those live in
[`core/…/protocol/`](core/src/main/java/com/openguardrails/ogr/protocol/), one
self-contained file per protocol.

---

## 2. The jobs

### Job 1 — Recognise the protocol, and never guess

Key on the **path** first (`/chat/completions`, `/responses`, `/messages`), then on
the **body shape** for a deployment that mounts a completion API somewhere else.

⚠️ **Return "unknown" rather than a guess.** A proxy that stamps `openai.chat` on
everything produces an event store where the field has stopped being evidence —
one deployment ended up with 693,197 events nobody could tell anything about. An
unrecognised request should be **relayed untouched**, not refused: a client's
`/v1/embeddings` call is not the guard's business, and answering 4xx to traffic you
merely do not understand turns a guardrail into an outage.

⚠️ Two traps that have each cost real coverage:

- **`openai.chat`'s body test is "has a `messages` array" — which every Anthropic
  body also passes.** Register it as a *fallback*, consulted only after the
  specific protocols decline. Otherwise every Anthropic request under an unfamiliar
  path is parsed as Chat Completions, and the symptom is a correctly-parsed-*looking*
  conversation with the system prompt missing and every `tool_use` block dropped.
- **Anthropic's `/v1/messages/count_tokens` must stop detection outright**, not
  merely be ignored: a count_tokens body *is* a valid messages body, so falling
  through to shape matching reports a model turn for a request that never reached a
  model.

`Protocols.detect` / `Protocols.isCompletionPath`.

### Job 2 — Mint a `step_id` per model call

A fresh random id, 32 hex characters, never reused. It is the **one coordinate on
the wire**, because concurrency makes pairing a call's two halves underivable
server-side.

⚠️ Use a CSPRNG, not a counter and not a timestamp. A per-process counter resets on
restart — which is exactly when several processes are minting at once — and a
collision **merges two different model calls into one step**, silently. `Ids.stepId()`.

### Job 3 — Resolve the identity four-tuple

Every event carries `agent_id`, `agent_type`, `agent_workspace`, `agent_user`, all
four always present, with `""` as the explicit *no assertion*. They are not four
spellings of one thing:

| field | what it answers | who asserts it |
|---|---|---|
| `agent_id` | WHICH agent — the inventory and policy key | **the proxy** — the authenticated caller IS the agent |
| `agent_type` | what KIND — a harness/product label | the client |
| `agent_workspace` | the agent GROUP = **one policy set** | **the proxy** |
| `agent_user` | who is using it right now | the client |

⚠️⚠️ **Strip the two proxy-asserted headers off inbound client requests, before your
own authentication runs.** An enforcement point cannot tell a header its own proxy
wrote from one a client sent, and authenticators do not generally overwrite a
caller-supplied consumer header. A valid credential plus a forged
`x-ogr-agent-workspace` chooses which policy set judges the traffic. Measured, and
then fixed, on a real gateway.

⚠️ **When nothing names the agent, fingerprint the client's own credential**
(`caller-<12 hex>`) rather than sending nothing. With an empty `agent_id` the
runtime falls back to the credential it can see — *your proxy's* API key — and every
caller behind the proxy collapses into one agent: one policy resolution, one owner
for everyone's traffic, one "move this agent" click that moves all of them. Measured
at **82.3% of 556k events misattributed** on one deployment. The fingerprint is a
floor, never a substitute for authenticating the caller.

`Headers.resolve` / `Headers.fingerprint`.

### Job 4 — Build the `step/request` event

Eight required fields, three optional, `additionalProperties: false`:

```json
{ "kind": "step/request", "step_id": "…",
  "agent_id": "…", "agent_type": "…", "agent_workspace": "…", "agent_user": "…",
  "llm_protocol": "openai.chat",
  "payload": { …the provider request body, verbatim… },
  "integration": "onesec/1.4.0", "connection": "…", "session_hint": "…" }
```

⚠️ **The strictness is a feature and it decides your release order.** Unknown keys
are a 400, so an integration one version *ahead* of the runtime is refused on every
event. Additive-optional keys are how the two ends roll forward independently — but
the runtime has to learn a new key first. **Deploy AIRS before the producer.**

⚠️ **The only edit permitted to the payload** is inserting a top-level `timing` key
by *byte insertion* right after the opening brace. Do not parse and re-serialize:
re-encoding reorders keys and re-escapes strings (`<` becomes `<` in several
libraries), and every offset in the verdict then indexes different characters than
the runtime counted. `RawJson.spliceTopLevel`.

⚠️ `timing.received_at` is **not** the event's timestamp, and the wire deliberately
has no such field. It is one END of a duration whose other end — the *previous*
step's `timing.completed_at` — the same process stamped, so the pair measures the
agent's tool-execution gap with clock skew cancelled out. A runtime that *ordered*
events by it would be ordering by a clock it cannot audit.

### Job 5 — Evaluate, and act on "no verdict"

`POST /v1/evaluate` with `Authorization: Bearer ogr_…`, inside a budget.

⚠️ **The budgets must be ORDERED, outermost longest**: your `timeout_ms` (5000) >
the runtime's own model timeout (4500) > the model gateway's (4000). Equal budgets
are a race, and when the outermost wins it nothing can name what was slow. Order the
chain by lowering the *inner* budgets, never by raising yours — 5 seconds is what a
person tolerates once, and it is not the proxy's to spend.

⚠️⚠️ **A 200 is not a verdict.** An empty body, an HTML error page from something in
front of the runtime, or a JSON document of another shape all parse without error and
answer `""` to every question — so every "did it stop?" test says no and the traffic
goes through as an **allow nobody made**. A fail mode does not cover this, because a
fail mode is consulted on non-200 and transport failures only. Test
`decision != ""` explicitly. `Verdict.usable()`.

**Fail mode** (`degraded-mode.md`): `open` is the default and the spec's — an
unanswered evaluate proceeds and is **counted**. The counter is the whole point:
a fail-open is *faster and quieter than success*, so nothing about the traffic will
tell you it happened. `closed` refuses instead — including on a **partial** verdict,
one whose `unjudged` names paths. That is the entire content of the promise: if we
could not look at it, it does not go through.

⚠️ Keep a policy block and a degraded refusal **distinguishable** at the HTTP layer
(a header, a distinct status). Answered identically, an operator cannot tell "we are
refusing traffic" from "the decision point is down" — opposite problems, opposite
remedies.

### Job 6 — Apply `modifications.spans` before sending

`allow` with a non-empty span list is not a contradiction: **redaction is not a
decision**. The two questions are independent.

The runtime deliberately returns **no plaintext** — a span carries offsets and a
replacement token, so no verdict store becomes a copy of the data it guards. The
process that already holds the plaintext (you) slices the span out of its own bytes,
which is also how the **token→value mapping** for restoring the reply is learned.

Four rules, each from a real failure:

1. ⚠️⚠️ **Offsets are CODE POINTS, not bytes and not UTF-16 units.** On Chinese text a
   byte splice lands a third of the way into the span, masks a fragment that matches
   nothing, and the value goes to the model untouched *while the log says "masked"*.
   In Java the equivalent trap is `String.substring`, which counts UTF-16 units: one
   emoji ahead of the span shifts everything by one. BMP text is identical under both
   counts, which is exactly why this survives every test written in one language.
2. ⚠️ **Highest offset first**, within each path, so an earlier splice cannot shift the
   offsets a later span was computed against.
3. ⚠️⚠️ **A span that does not resolve is DROPPED and COUNTED, never applied elsewhere.**
   Slicing one span's offsets out of a different text masks characters nobody detected
   while the real value travels on — and both failures look exactly like a healthy
   proxy. The count is the only thing that says otherwise; put it on the heartbeat.
4. ⚠️ **Learn `replacement → displaced text`** as you splice. That map is what Job 12
   needs.

`Spans.apply`.

### Job 7 — Forward upstream

Ordinary proxying, with two notes. **The client's own provider credential passes
through** — this design gives the guard no upstream key. And strip hop-by-hop headers
plus anything only the proxy may assert (Job 3).

### Job 8 — Read the reply

**Buffered**: forward the provider body verbatim as the `step/response` payload, with
`timing` spliced in the same way.

**Streamed**: there is no single raw body, so reassemble the frames and send the
**canonical shape** — `{text?, reasoning?, tool_calls?, model?, usage?, timing?}` —
with `llm_protocol` still naming the protocol the client spoke.

⚠️ **Reassembly is not a nicety.** A streaming reply is the ordinary shape of chat
traffic, and a proxy that only reports non-streaming replies makes the model's whole
output side invisible: one earlier connector left a **230:21** request-to-response
ratio in the event store.

⚠️ **Frame the stream in BYTES, decode per frame.** A network chunk boundary falls
wherever TCP put it, regularly mid-UTF-8-sequence. Decoding each chunk as it arrives
inserts a replacement character in the middle of a Chinese word — into the text a
guardrail judges *and* the bytes the client renders. `SseFrames`.

⚠️ **Keep reasoning separate from text**, and read **both spellings**. A reasoning
model's thinking arrives under `reasoning_content` (DeepSeek, vLLM) *or* under
`reasoning` (OpenRouter's normalisation, the qwen family) — a vendor sends one. A
reader that knows only one spelling reads a pure-reasoning reply as EMPTY: the whole
response half is counted unreadable, and under fail-closed it is REFUSED. Measured at
**9.5% of steps** on one deployment. Keep the spellings in **one list every reader
walks** — the parse, the stream accumulator, and both restore paths.

⚠️ **An empty reply and an unreadable one are different facts.** Count them apart. A
provider served as `application/octet-stream` fed the raw-JSON path, parsed to nothing,
and produced **100% response loss** for every consumer on that upstream — invisible
except as a counter.

⚠️ `arguments` in the canonical payload is the argument **object**, not a JSON string
of it. The runtime reads `arguments.command` to recover the bare command a shell action
carries; a string hands the judge `"{\"command\":\"rm -rf /\"}"` where it was trained
on `rm -rf /`.

### Job 9 — Streaming enforcement: release a bounded HEAD

A buffered reply can be refused before anyone sees it. A stream cannot — the first
token is on the wire before there is anything to judge. Judging every N characters was
tried and measured wrong: at 25% of the reply visible, false positives are an order of
magnitude worse than on the whole reply, all of it the answer that agrees on the
surface and corrects underneath. **Early judgement is a fit prefilter and an unfit
blocking criterion.**

So the answer is judged **once, whole, at end of stream**, and the only question left
is how much may be on the wire by then:

1. Forward at most `stream_head_release_bytes` of *client-visible content* (default
   **32**) and withhold everything after it.
2. At stream end, evaluate the reassembled reply.
3. `allow` → release everything held. `block` → drop it and end the stream.

⚠️⚠️ **Measured from the HEAD, and the direction is the whole design.** "Withhold the
last N bytes" guarantees only that N are withheld: what reaches the caller is
`total − N`, unbounded in the length of the answer. Measured, a ~900-byte answer to a
prohibited question was delivered essentially whole and then retracted. Bounding the
head makes exposure a **constant**, independent of both the answer's length and the
judge's latency.

⚠️ **A ceiling, not a floor**, and order-preserving: a frame that would carry the
caller past the bound is held *whole* (an SSE frame cut in half is not a frame), and
once anything is held, everything after it is held too. ⚠️ Count **content** bytes
only — text, reasoning, tool-call arguments — never framing, so the stream reads as
live from its first frame at any budget. ⚠️ `0` is a real value meaning *release
nothing*: a spinner until the judged answer arrives, and every block then a clean
refusal instead of a retraction.

⚠️ **Tool calls never execute before the verdict, whatever the budget is** — a
provider stream only completes tool calls at its end, so argument completions and the
terminal frames are always inside the held remainder.

`HeadHold`.

### Job 10 — Render the refusal in the CALLER's protocol

⚠️ **Per protocol, not one shared body.** A refused `/v1/messages` caller handed an
OpenAI `choices[]` document gets a parse error from its SDK, which its user reads as
the proxy being broken rather than as a policy decision — and many agent harnesses
**retry** a malformed reply, turning one refusal into a storm.

⚠️ **HTTP 200, not 4xx.** Every client renders an assistant message; a 4xx surfaces as
a generic transport failure that explains nothing to the person who typed the prompt.

**`continuation`** (optional, on `block` only) selects *which shape* the refusal takes.
⚠️⚠️ It never turns a refusal into an allow — the action still does not happen and
`decision` still says `block`. It exists because `finish_reason: "content_filter"` /
`stop_reason: "refusal"` is the single token every agent harness treats as TERMINAL:
one refused tool call ended a nine-step task. The three styles:

| style | half | what to do |
|---|---|---|
| `withhold` | **request** | replace the text at each path with the notice and **forward the request** — the turn continues |
| `drop_calls` | response | remove the named `tool_calls.N` elements, keep the rest, append the notice, correct the finish reason to match what SURVIVED |
| `answer` | either | the notice is the whole reply, on a normal stop |

⚠️ **Absent is the normal case and means "refuse as you always did".** Test for a style
you KNOW, never for "not empty" — an unrecognised style is a directive from a newer
runtime, and guessing at it is how an enforcement point forwards what it was told to
remove.

⚠️⚠️ **All or nothing.** If any path fails to resolve, fall back to the hard refusal. A
partial drop forwards some refused calls under a notice saying they were refused — the
failure that is worse than either honest answer, because it looks like it worked. And
delete **deepest index first**: dropping `tool_calls.0` then `tool_calls.2` removes the
refused call and then the *wrong* one.

⚠️ For a **stream**, what a refusal can be depends on one fact: whether **tool-call
bytes** were among what was released. With none out, a normal stop is safe and the loop
survives. Once a partial call is in the client's hands, a normal completion invites it
to run a call with truncated arguments — harnesses branch on `tool_calls` being
non-empty, not on the finish reason.

### Job 11 — Put the values back

Whatever Job 6 masked, the model may echo — and the caller must receive **its own data**,
not your placeholder. Restore into the reply's text, its reasoning (both spellings), and
⚠️ above all **tool-call arguments**: an unrestored line of prose is a cosmetic defect a
reader can see; an unrestored `{"to": "${OGR_EMAIL_1}"}` is an agent acting on a value
that names nothing, and nothing in the reply says so.

⚠️ On a **stream** a placeholder arrives in pieces, so a per-delta replace restores
nothing. Hold back only the suffix that could still become a token, and **flush whatever
is still held at end of stream** — a restorer that simply stops holding loses the
answer's last characters. `Restorer`.

⚠️⚠️ A `withhold` continuation's notice must **never** enter the restore map. A
redaction's replacement is a placeholder you put back; a withheld tool result must never
come back, or the model's own reply rehydrates the content you just removed — the control
inverted, silently, on the return path.

### Job 12 — Heartbeat and counters

`POST /v1/heartbeat` every ~30s, so the runtime can tell "agent idle" from "integration
went dark" — the one thing a silent proxy cannot say about itself.

⚠️ Send an `instance_id`: stable for the process, **not across restarts**. Without it
every replica overwrites the others' version and counters, and two replicas on an old
build plus one on a new one read as a single new build — naming the only instance sending
no traffic. Reusing the id across restarts splices two series and makes a monotonic
counter appear to go backwards.

Count at least: `events_sent`, `evaluate_errors`, **`unchecked`** (steps that went
through unjudged — the number to alert on), `unresolved_spans`, `unreadable`.

### Job 13 — The optional fields worth sending

| field | what it buys |
|---|---|
| `integration` | `name/version` on **every event** — which build produced this traffic, for triage. The heartbeat's copy is liveness; neither is redundant. |
| `connection` | the one session signal a client cannot strip: consecutive requests of one client process ride one keep-alive connection even when the body carries no session field. Attribution only. |
| `session_hint` | the producer's own name for the conversation, if it has one. A grouping HINT the runtime may decline — never a coordinate. |
| `llm_endpoint` | the host the agent **dialled**, before your routing. A request pointed at a host that is no known vendor and not the tenant's own is the one signal that names a RELAY on the model channel. |
| `initiator` | `"scheduled"` when the *client* declared a scheduled run. There is deliberately no `"human"` value — nothing can prove one. |
| `transport` | where the time went, so a first-token regression is attributable to a LAYER. ⚠️ **Every value is a duration measured inside ONE clock.** Stamping timestamps at both ends and subtracting the neighbours produced a steady **2.1 seconds** of fiction on 2,997 of 3,000 events. The network figure is your round trip minus the handler time the runtime reported — the NTP delay formula — and it does **not** split into outbound and inbound. |

⚠️ Every one of these is **self-declared**: a RECORD, never an input to authorization,
policy selection or trust. Nothing bounds what a caller names itself.

---

## 3. What a proxy must NOT do

- **Do not declare session, turn or step coordinates.** A proxy sees one stateless call at
  a time; the runtime derives the rest. Two implementations of one algorithm drift.
- **Do not order events by any clock.** Ordering is derived from `step_id`; a producer's
  clock cannot carry it and the receiving end cannot audit it.
- **Do not batch `/v1/evaluate`.** A batch on the decision path means the caller shattered
  a step into fragments, which is the decomposition this contract exists to prevent.
- **Do not rest a control on an optional key.** A runtime may not send `continuation`; a
  PEP may not implement it. Ignoring it is always the strict side.
- **Do not log request or response bodies, at any level.** A guard that logs the traffic it
  judges puts the user's prompt, the tool schema and the model's reply into the container
  log — twice per model call. One shipped gateway did exactly this from inside an HTTP
  client library, at `info`, and its own `log_level: quiet` could not suppress it.
- **Do not treat a missing `unjudged` as "nothing was judged"**, or a present one as a
  detail. Absent or empty asserts every routed text WAS judged; that is the only assertion
  fail-closed hangs on.

---

## 4. Two deployment shapes, and what each gives up

### Standalone (the bridge answers about a message)

The deployment shape of a bridge. The organization's service keeps its own provider
connection and posts each body to the bridge — the request before forwarding, the
reply after — and gets the decision back with the rewritten body when there is one.
This is what [`GuardApiHandler`](server/src/main/java/com/openguardrails/ogr/server/GuardApiHandler.java)
implements on `/guard/v1/step/request` and `/guard/v1/step/response`. Two things
are structurally weaker and should be said out loud to whoever operates it:

- **Streaming is the caller's problem.** There is no held head, so a streamed answer is
  either buffered by the caller before it asks — paying the whole time-to-first-token — or
  judged after the client has already seen it, which is a record and not a control.
- **The placeholder mapping has to travel.** Between a step's two halves the service must
  carry `token → value`, or the reply keeps the placeholders and the customer's application
  receives `${OGR_EMAIL_1}` where its own data belongs. This implementation returns the map
  on the request call and accepts it back on the response call, so a caller that
  load-balances the halves across replicas needs nothing from any one process's memory.

And one thing the caller owes: the request's spans are applied into the body the bridge
**returns**, so the service forwards that body, never its own copy — a copy is a body the
runtime believes was masked and was not. The door says which case it is in: `decision:
"allow"` comes with `body: "unchanged"` (use your copy; nothing is echoed back, so an
allow never doubles the request's bytes), `"redacted"` comes with the rewritten body
(use it), and `"block"` comes with the full content — a refusal in the caller's own
protocol, or, beside a `continuation`, the body to forward/deliver with the refused
part taken out. The runtime renders all of this itself when asked —
`POST /v1/evaluate?payload=true` adds a `payload` to the verdict — which is what this
bridge does by default; a service that can call the runtime needs no bridge.

### Inline (the code is in the byte path)

The full enforcement point. It can apply redaction spans itself — only the process holding
the body can, since the runtime returns offsets and never plaintext — and it can refuse
before the model sees anything, streaming included. This is what a
[gateway plugin](../../gateway/) does at a product that already is the byte path, and what
a service that embeds `core` can do in-process. The reference server's
[`InlineHandler`](server/src/main/java/com/openguardrails/ogr/server/InlineHandler.java)
implements it too — as the offline test bed for `core`'s streaming and span code, not as a
gateway to deploy: a standalone process that takes the `base_url` is one more gateway, which
is the job the products under `gateway/` already do.

Everything else — detection, the event envelope, the fail mode, span application, refusal
rendering, restoration — is the same code.

---

## 5. Checklist

Before calling an integration done:

- [ ] Two events per model call, one `step_id`, both halves sent even when the first was refused-and-continued.
- [ ] `payload` is byte-identical to the provider body, `timing` aside.
- [ ] All four identity fields present; the proxy-asserted two stripped from inbound requests.
- [ ] `decision != ""` gates every "did it stop?" test.
- [ ] Fail mode applied on timeout, 429, 5xx, socket error **and** a 200 that is not a verdict.
- [ ] `unjudged` non-empty refuses under `closed`.
- [ ] Spans applied in code points, descending, all-or-nothing, and counted when unresolved.
- [ ] Streamed replies reassembled and judged once, whole, behind a bounded head.
- [ ] Refusals rendered by the caller's own protocol and readable by its own parser.
- [ ] `continuation` honoured for styles you implement, hard-refusing for the rest.
- [ ] Placeholders restored into text, reasoning (both spellings) and tool arguments.
- [ ] Heartbeat with an `instance_id` and an `unchecked` counter somebody alerts on.
- [ ] No body of any kind in any log line.
