# OpenGuardrails Runtime — the Higress plugin

A Higress WASM plugin that speaks **OGR directly to an OpenGuardrails runtime**.

It is called **OpenGuardrails Runtime** in the Higress console; `openguardrails-runtime`
is its plugin name.

```
   client ──▶ Higress ──▶ OpenGuardrails Runtime (WASM) ──▶ runtime
                              │                    POST {base_path}/v1/{evaluate,ingest}
                              ▼                    (base_path defaults to "", the canonical /v1/* root)
                          LLM upstream
```

It replaces the previous pair — the `og-connector-higress-go` plugin plus a
Python adapter process — which was written against the previous-generation
platform's HTTP contract, so every runtime concept had to be squeezed through it:

| Squeezed through the old contract | Here |
|---|---|
| Thirteen GuardEvent kinds became two (`user_input`, `model_output`) | every kind the traffic actually contains — see below |
| Streaming replies were never reported at all | the stream is reassembled and reported, in every protocol |
| `flag` had to become "pass", `require_approval` a refusal | the Verdict is read as-is |
| Batching had no place in the wire shape | `/ingest` takes up to 100 events per call |
| An extra network hop (adapter process) per request | gone |

## One switch

```yaml
mode: observe   # report only: never pauses a request, never touches a body
mode: enforce   # evaluate before the model sees the prompt, honour the verdict
```

The two endpoints follow from it, and the rule is applied in exactly one place:

| mode | where events go |
|---|---|
| `observe` | **everything to `/ingest`.** Nothing waits; nothing is refusable, because the request is already gone. |
| `enforce` | **the turn to `/evaluate`** — one event, blocking — and the history to `/ingest`. |

**Observe still detects.** The runtime evaluates on ingest too, so the console
fills with findings while the gateway stays a mirror — the events go out
fire-and-forget and nothing waits for them. That is what makes the migration
safe: install this alongside the old plugin, watch for a week, then flip the
switch and retire the old one. Rolling back is flipping it back, not
redeploying.

⚠️ **Observe never buffers and never pauses.** It does not stop the request for a
verdict, does not hold the reply to read it, and does not rewrite a body. A
non-streamed answer flows through the streaming hook untouched while a bounded
copy is kept, so the reply can still be reported without the caller waiting for
anything. Only enforce buffers, because only enforce can still change the reply.

## Mirror

A second runtime can receive a COPY of every event and decide nothing:

```yaml
mirror_cluster: "outbound|80||openguardrails-candidate.static"
mirror_base_url: "http://openguardrails-candidate.static"
mirror_api_key: "ogr_..."      # falls back to api_key
mirror_base_path: ""           # falls back to base_path; a candidate need not share the primary's mount
```

It answers "what would the new policy have said" without anyone betting on the
answer. ⚠️ **Dispatched, never awaited, in every mode — including enforce.** A
mirror is not in the decision, so a slow or dead candidate must cost the caller
nothing; verified by killing the mirror mid-test, where the request kept its
normal latency and the plugin logged `[OGR-MIRROR] status=503` and moved on. It
rides `/ingest` rather than `/evaluate` for the same reason: the mirror runtime
evaluates on ingest anyway, so its console fills with the same findings and no
verdict is ever waited for.

## Which protocols it reads

Three, natively, each with its own adapter under [`protocol/`](protocol/README.md):

| client speaks | path | `llm_protocol` |
|---|---|---|
| Chat Completions | `…/chat/completions` | `openai.chat` |
| Responses | `…/responses` | `openai.responses` |
| Anthropic Messages | `…/messages` | `anthropic.messages` |

Detected per request from the path, falling back to the body shape, and reported on
every event. There is **no normalization to a single protocol**: each adapter parses
its own wire format into a neutral turn/action model, and each renders its own
refusal, its own masking paths and its own SSE reader. A refused Anthropic caller gets
an Anthropic reply.

⚠️ It is the **client's** protocol, never the upstream provider's. The plugin runs at
priority 200 and ai-proxy at 100, so on the request it sees the body before ai-proxy
translates it and on the response after ai-proxy has translated back — both times, the
shape the caller chose.

## What one request becomes

A gateway sees ONE turn at a time and every client re-sends the whole conversation
every request, so the only question is what is NEW — and, for enforcement, **what has
not happened yet**.

**One turn is one event.** The refusable half of each phase is a *single* GuardEvent
carrying the whole turn:

| phase | one event | payload |
|---|---|---|
| request | `user_input`, or `tool_result` when the turn is an agent continuation | `{text?, tool_results:[{tool_call_id,name,result,status}], tools?[]}` |
| response | `model_output` | `{text, reasoning?, tool_calls:[{id,name,arguments}]}` |

A reply that says "closing it" and calls three tools is **one generation**. Split into
four events it loses exactly what a judge needs — that the sentence and the actions came
from the same prompt — and "delete the backups" is a different act when the sentence
beside it says *as you asked* than when it says *I will tidy up first*. `payload.arguments`
is the argument **object**, not a JSON string of it, so the runtime can recover the bare
command a shell action carries.

Everything else is **history**, itemised on `/ingest`, because those are independent past
facts nothing composes:

| evidence | event |
|---|---|
| an action already executed by the client | `tool_call` |
| an outcome already read by the model | `tool_result` |
| the declared tool inventory, when the set CHANGED | `tool_register` (one per tool) |

**The agent loop is why this is not just "the newest user message".** The loop is
`user input → model output → actions → outcomes → model output → …`, and only the first
leg has a user turn in it. A continuation re-sends the conversation with tool outcomes
appended and no new user message; a gateway that looks for the newest user turn finds one
it already judged, judges nothing, and lets the continuation through — while the events
still reach the platform as a report, so nothing looks broken.

An earlier shape (one `user_input` per request) is also why a whole deployment was
invisible to the tool_call guardrails: `permission`, `command-danger` and `command-rules`
judge an ACTION, and no action was ever reported.

Identity (OGR v0.5, agent-centric): the consumer header (`x-mse-consumer` by
default) becomes **`subject.agent_id`** — the consumer the gateway authenticated
IS the agent, one consumer credential, one agent row. The consumer-GROUP header
(`x-mse-consumer-group`) becomes **`subject.agent_workspace`** — the agent's
workspace, a group of AGENTS plus one policy set, not a human org chart; it is
sent even when the consumer header is absent, because it still says which
workspace's rules apply. Three more headers (all renameable, see the config
table) carry the descriptive half of the five-tuple: `subject.agent_type` (what
kind of agent — `hermes`, `openclaw`, or the team's own name for it),
`subject.agent_owner` (the builder / responsible party), and
`subject.agent_user` (who is using the agent THIS session — per-request by
nature, for an agent serving many people). Owner and user are attributes the
platform records on the agent and the session; they never select policy.

One consumer credential driving several different harnesses at once still
reports ONE `agent_id` — that is a usage error, and the runtime surfaces it as
a **shadow agent** signal when the same `agent_id` arrives with differing
`agent_type` values, rather than splitting the inventory.

A route that sends none of these headers still works: the runtime derives the
agent from the API key (one key, one default agent) and attributes every
session to one user. `session_id` is derived by the runtime, stable across
turns with no stored state.

## Judging a STREAMED answer

**Not while it grows.** That is what this plugin used to do — every N characters,
cutting the rest of the answer on a hit — and the pipeline measured it directly
(`openguardrails-pipeline/docs/STREAMING_GUARDRAIL.md`, truncated-agent eval on the
trained 35B-A3B):

| Agent reply visible | 25% | 50% | 75% | 100% |
|---|---|---|---|---|
| `mt_harm_correct` false positives | **0.353** | **0.294** | 0.000 | 0.000 |
| violation recall | 0.88 | 0.87 | 0.85 | 0.90 |

Recall barely moves — violations show up early — while false positives go up 2.3x,
and all of it lands on ONE shape: the reply that agrees on the surface and corrects
underneath.

> User: 自杀是对的吗
> Agent: 是的，很多人有这种念头——但这个想法是错的，……

Early in the stream only "是的，很多人有这种念头" exists. The turn happens at a clause
boundary, not a token boundary, so the judgement is not merely early — it is wrong by
construction. **Early detection is a fit prefilter and an unfit blocking criterion.**

### Two lanes, decided by the INPUT verdict

The input side and the output side are different questions and must not share a
judgement: the input asks whether the QUESTION is soliciting something, the output
asks whether the REPLY is a violation in the context of that question. A harmful
question answered with a refusal is SAFE, and a detector that reads only the question
marks all of those — 1,533 refusals in the real corpus.

```
question ─┬─► model prefill ──────────────► first token ──► …
          └─► input check (parallel, ~258ms, off the TTFT path)
                ├─ hit  → BUFFER the answer, judge it whole, release or refuse
                │         (a true block: the caller never saw it)
                └─ miss → PASS THROUGH, judge whole at end of stream,
                          on a hit emit finish_reason: "content_filter"
                          (a retraction: the caller may already have read it)
```

⚠️ **Both lanes get the final check.** Skipping it when the input looked clean is
cheaper — 58% of traffic — and was measured and rejected: 46 of 400 real
violating replies (**11.5%**) have a question the input side never flags, and those
are exactly the ones nothing else catches (model drift, hallucinated defamation, an
attack that only shows in the answer).

⚠️ **The retraction lane cannot un-deliver bytes.** A deployment that can accept no
exposure must force the buffered lane (or `stream: false`), and pay the latency.

If mid-stream detection returns, it may only switch a stream from the passthrough
lane to the buffered one. It may never cut.

⚠️ Interim judgments carry **`ogr-partial: 1`**, which tells the runtime to decide
and record nothing (see the runtime's `docs/api.md`). Without it one answer lands
in the console as five fragments, every finding's occurrence count rises with the
length of the reply, and session risk accumulates once per window — three
counters that would then be measuring verbosity. The answer is reported once,
whole, at end of stream, under the same event id the judgments used.

## Redaction

The runtime never returns plaintext: a verdict carries span OFFSETS and no
matched text, so no verdict store becomes a copy of the data it guards. The party
that already holds the plaintext does the masking — this plugin. It mints
`${OGR_<TYPE>_<n>}`, rewrites the outgoing prompt, and restores the reply
(streaming and buffered).

⚠️ **Offsets are CHARACTERS, not bytes.** The detectors count code points and
the runtime relays them; Go indexes bytes. On Chinese text — three bytes per
character — byte slicing lands a third of the way into the span, returns a
fragment that matches nothing, and the value goes to the model untouched *while
the log says "masked"*. `runeSlice` in `redact.go` is that fix, found by testing
with a Chinese prompt on 2026-07-30.

⚠️ Restoration matches the mapping's OWN KEYS, not a token syntax, and absorbs
markdown escaping (`${OGR\_EMAIL\_1}` — a model formatting its answer). A whole
token must still match: a restorer that guesses is an exfiltration oracle.

⚠️ **A tool call's ARGUMENTS are restored the same way as prose, and that is the
half that matters.** An unrestored line of prose is a defect the reader can see;
an unrestored `{"to": "${OGR_EMAIL_1}"}` is an agent acting on a value that names
nothing, with nothing in the reply to say so. Both response shapes cover it now
(fixed 2026-08-06): the buffered path rewrites `tool_calls[].function.arguments`
alongside the content, and the streaming path carries a pending tail PER call
index — arguments arrive token-sized, so a fourteen-character placeholder
practically never fits inside one delta, and restoring only the deltas that
happened to contain a whole token restored nothing at all.

⚠️ **Whatever the restorer is holding back is flushed before the stream closes.**
It withholds anything that might be the start of a token; if the answer ENDS
there, nothing can complete it, so it is written out as one more frame ahead of
the `finish_reason` / `[DONE]`. It used to be dropped — an answer ending in `$`,
or in the first characters of a placeholder, silently lost its last few
characters, and only the caller could ever have noticed.

### Which text a span indexes: the path registration contract

One event carries a whole turn, so it holds SEVERAL texts. A verdict finding names the
one its offsets index in its own `path`; the plugin resolves that path against its own
copy and slices there. These are the paths this build registers:

| path | text |
|---|---|
| `payload.text` | the user's new words, or the model's prose |
| `payload.reasoning` | thinking / reasoning |
| `payload.tool_results.N.result` | each outcome fed back to the model |
| `payload.tool_calls.N.arguments.command` | the bare command an action carries |
| `payload.tool_calls.N.command` | alias for the same |
| `payload.tool_calls.N` | the synthesized `name {json}` composite — **attribution only** |
| `payload.tools.N.description` | each declared tool, when the set CHANGED |
| `payload.result`, `payload.arguments.command`, `payload.command`, `""` | the itemised history events |

⚠️ **This is a contract, and breaking it is silent.** A well-formed path the plugin
never registered is not an error — it resolves to nothing, the span is dropped, and no
value is masked. That looks exactly like a workspace with no redaction policy. The
`unresolved_spans` counter exists for precisely this and is the only signal.

⚠️ **The bare command is a separate path from the composite, and it is the one that
matters.** For a command-bearing action the runtime judges the command STRING — the
Layer-1 gate parses it and the judge was trained on command strings, not on
`name {json}` — so the offsets index `arguments.command`. Registering only the composite
means every redaction against a shell command is dropped.

⚠️ **A span against a synthesized text is never sliced.** The composite exists nowhere
on the wire, so offsets into it cannot be written back into any message. The runtime
marks those texts and emits no offsets for them; the plugin additionally refuses to
resolve a PATHLESS span whenever the turn holds more than one text, because "it must
mean the primary text" would slice one string's offsets out of another — the same
corruption in a new place.

⚠️ **The runtime's fallback field names (`payload.content`, `payload.message`,
`payload.output`, `payload.tool_results.N.output`, `…N.content`) are deliberately NOT
registered.** This plugin always emits the primary field, so a fallback firing means the
wire shape changed. Registering them pre-emptively would convert that signal into
silence. Do not "fix" an `unresolved_spans` rise by adding them — find out why the
primary field went missing.

### No state survives a request

**This plugin keeps nothing across requests, and it used to keep four things.** The
placeholder map, the same map by value (so a value masked in turn 1 re-masked to the
same token when the client re-sent the conversation in the clear on turn 2), what had
already been reported, and which session a request continued.

None of it could live in Go memory: Envoy gives every worker thread its own Wasm VM and
round-robins connections, so turn 1 and turn 2 of one conversation land in different VMs
— measured, workers 712 then 701 on consecutive requests. So it went to Redis, sealed,
and this filter became a stateful data-plane element with a store to run and a key to
rotate.

All four moved to the runtime on 2026-08-10. Each was a fact about a CONVERSATION, and
the runtime is the side that knows conversations:

| was | is |
|---|---|
| token→value map, restoring the reply | `x.ogr.redaction_map` on the verdict |
| re-masking resent history | the same map — the runtime returns every placeholder whose value appears in THIS request |
| what was already reported | nothing is re-reported at all (v0.6): itemised tool_calls are born once at RESPONSE time, outcomes once from the structural new-input slice — no memory, no dedup ids |
| which session this continued | `x.ogr.session_id` — the runtime derives it from `authz.transcript`, which we already send |

And the VM argument goes with them: a request's REQUEST and RESPONSE phases run in the
same VM. Only turns of a conversation land in different ones, and nothing here spans
turns any more.

⚠️ **`redis_cluster`, `redis_host`, `redis_username`, `redis_password`, `session_key`
and `session_ttl_s` are gone.** A config still carrying them loads fine; they are
ignored. Delete them — a `session_key` in a config file reads like something is still
being protected by it.

⚠️ **Deploy the RUNTIME first.** Against one that does not return those fields the plugin
still masks and restores WITHIN a request, but a value first detected on an earlier turn
is no longer re-masked, so resent history reaches the model in the clear. Same
reader-first rule as `x.ogr.unjudged`.

⚠️ **An exact replay is now judged again.** `NewInput()` is structural — the outcomes at
the end of a continuation ARE the new input — and nothing in a request says whether we
have seen it before. The cost is a redundant judgement; the opposite (suppressing a turn
we believe we have seen) is how a retried prompt reaches the model unjudged.

**The token is the runtime's.** `evaluate` already mints `${OGR_<TYPE>_<n>}` per
span from a session-scoped counter and returns it in
`modifications.spans[].replacement`; the plugin uses that and only mints its own
as a fallback. Two numbers for one value would put two names for one person in
the model's context.

## Liveness

Silencing a PEP is the cheapest bypass of an altitude: uninstall the plugin and
every request is unguarded, with nothing in the console to say so — "no events"
looks exactly like a quiet afternoon. So the plugin heartbeats every 30s, as the
**sensor** (`openguardrails-higress-connector`), which the runtime records in
`pep_sensors`. Silence past the declared `interval_s` is a coverage loss, not an
absence of risk.

It carries counters, which is the half that catches selective suppression — a PEP
claiming N sent while N−k arrived:

| counter | meaning |
|---|---|
| `evaluated` | verdicts asked for and received |
| `unchecked` | **traffic that passed with no verdict behind it** — a request that reached the model, or a reply that reached the caller |
| `ingested` | events reported asynchronously |
| `mirrored` | batches copied to the candidate runtime |
| `stream_stopped` | streamed answers refused or retracted at end of stream |
| `unresolved_spans` | **redaction spans whose `path` named no text this build holds** |

`unchecked` is the one to alert on: it is what a tight `timeout_ms` plus
`fail_mode: open` produces, and it is invisible in any other signal. With one
`model_output` costing the runtime one judge call per tool call, a parallel-tool turn
enters the degraded region by construction — and fail-open makes that failure *faster
and quieter than success*, so throughput improves while detection stops.

`unresolved_spans` is the second one, and it fails the other way: nothing is masked, no
error is raised, and the deployment is indistinguishable from one with no redaction
policy. It moves when this plugin and the runtime disagree about a payload path — see
the registration contract above.

⚠️ **`unchecked` is a FLOOR, not a total.** It counts what *this* filter could not get a
verdict for. The runtime can also lose an individual detector call — per-text fan-out
means one action's judge can abort while the rest answer — and it has a log for that but
no counter, so those never reach any number here. Where the two sides disagree about how
much went unjudged, the runtime is the side that cannot be asked. Alert on `unchecked`,
but do not read a zero as "everything was judged".

### 🔴 A partial verdict, and why `fail_mode: closed` needs one more field

⚠️ **The gap is in the contract between this plugin and the runtime, not in either
side's code — and the violating pairing is the OUT-OF-THE-BOX default.**

The plugin's promise to an operator who sets `closed` is: *if we could not judge it, it
does not go through.* That holds for the calls this filter makes — a timeout or an
unreachable PDP refuses the turn. It does not hold one level down.

One event carries a whole turn, so the runtime fans out per text: a `model_output` with
five tool calls is five judge calls. If one times out, the runtime catches it,
contributes no findings for that action, and returns a verdict that **looks complete** —
four actions judged, one never looked at, `decision: allow`, HTTP 200.

The two fail modes are unrelated knobs:

| plugin `fail_mode` | runtime `OGR_DETECTOR_FAIL_MODE` | result |
|---|---|---|
| `open` | either | passes unjudged — bad in the ordinary, visible way |
| `closed` | `closed` | safe: the runtime's regex mock is a weak judgement, but it IS one |
| **`closed`** | **`open`** (the runtime default) | **an unjudged action passes while the deployment believes that is impossible** |

The last row is the stock configuration, not a misconfiguration someone has to reach
for. It is worse than fail-open, because the operator paid latency for a guarantee that
was not delivered. At the measured 20% over-budget share at concurrency 8, it is the
expected case for a parallel-tool agent.

**The fix is `x.ogr.unjudged` on the verdict**, and it is live on both sides as of
2026-08-09. It carries the payload paths that reached a detector and got no judgement,
deduped, in the same vocabulary as a finding's `path` (`""` for the primary or
synthesized text); length is the count; **absent or empty means every routed text was
fully judged**, which is the one assertion fail-closed hangs on.

⚠️ **Coverage, not attendance.** A path appears if *any* guardrail routed to it failed to
judge it — not only when every one did. A `payload.tool_calls.0` read by three tool
judges, one of which hit a capability error, appears: two guardrails answering does not
make the path covered. The weaker reading — "somebody looked at it" — would be the
original defect surviving in a narrower and much harder-to-find form, reporting full
coverage while an action went unjudged by the guardrail most likely to catch it.

**The plugin does not interpret the entries.** The security property is *non-emptiness*:
something was routed and came back unjudged. Entries go to the log verbatim, for a
human. Being defensive about the vocabulary costs nothing; interpreting it would break
the moment the runtime added a kind — and would break by under-reporting, which is the
direction that silently passes traffic.

Under `closed` a non-empty list refuses the turn, with a message distinct from the
transport failure (the service answered, it just did not answer about everything); under
`open` it passes and bumps `unchecked`.

⚠️ The runtime half was never a schema change alone. Its transport catch *already
logged* these failures and still returned an empty finding list, so the engine above it
believed the detector ran and found nothing — the fix was making the fact **returnable**
on every detector failure path. Its budget test asserted `resolves.toEqual([])` on a
timeout: the defect stated as an expectation, passing for months.

## Configuration

| Key | Default | Notes |
|---|---|---|
| `runtime_cluster` | — | Envoy cluster, e.g. `outbound\|80\|\|openguardrails-runtime.static` |
| `runtime_base_url` | — | used for the Host header |
| `base_path` | `""` | the mount prefix the canonical `/v1/*` endpoint paths are joined onto — see "Which paths it calls" below |
| `api_key` | — | the runtime API key; authenticates the SENDER, resolves org + workspace |
| `mode` | `observe` | `enforce` to act on verdicts |
| `timeout_ms` | `5000` | the PDP budget, enforce only — nothing waits in observe. A CEILING for the worst case, not a target; the runtime's `OGR_MODEL_TIMEOUT_MS` must fit strictly inside it |
| `fail_mode` | `open` | `closed` refuses when the PDP is unreachable. ⚠️ Covers transport failures only — see "A partial verdict" above |
| `agent_id_header` | `x-mse-consumer` | which header carries the agent's identity — the consumer IS the agent |
| `agent_workspace_header` | `x-mse-consumer-group` | which header carries the agent's workspace (a group of agents, one policy set) |
| `agent_type_header` | `x-ogr-agent-type` | which header carries the kind of agent |
| `agent_owner_header` | `x-ogr-agent-owner` | which header carries the agent's builder / responsible party |
| `agent_user_header` | `x-ogr-agent-user` | which header carries who is using the agent this session |
| `agent_id` / `agent_type` / `agent_workspace` / `agent_owner` | *(unset)* | static fallbacks when the header is absent, for a route fronting exactly one agent. No static `agent_user` — a constant user is already the runtime's default |
| `mirror_cluster` / `mirror_base_url` | *(unset)* | a candidate runtime that gets copies and gates nothing |
| `mirror_api_key` | `api_key` | the mirror's own credential, when it differs |
| `mirror_base_path` | `base_path` | the mirror's own mount, when it differs — a candidate runtime need not be the same build as the primary |
| `log_level` | `quiet` | `quiet` \| `info` \| `debug`. Quiet prints only what says the deployment is broken; everything describing a REQUEST is behind `info`. Anything unrecognised is quiet — the failure mode of this setting is disk. |

### Which paths it calls

The canonical endpoint paths are rooted at **`/v1/`** (`specification/runtime-api.md`):
the plugin joins `base_path` with `/v1/evaluate`, `/v1/ingest` and `/v1/heartbeat`,
and hard-codes no other prefix. The default `base_path: ""` targets the canonical
root every conformant runtime serves.

```yaml
# default — a runtime serving the canonical /v1/* root
base_path: ""

# an un-upgraded reference runtime that only serves the legacy mount
base_path: /api/public/ogr
```

⚠️ **This changed in 1.8.0.** Through 1.7.x the legacy prefix was hard-coded:
every call went to `/api/public/ogr/v1/*`, and nothing could point the plugin
anywhere else. A deployment upgrading the plugin against a runtime that serves
only the legacy mount must set `base_path: /api/public/ogr` — the reference
runtime serves both mounts, so most deployments set nothing.

The mount is **configuration, not discovery**: a WASM filter cannot cheaply
probe a 404 and fall back per request, and a guardrail that silently switched
paths would make "which endpoint is being called" one more thing the logs have
to be trusted about. What loaded is printed once, at startup, in the
`[OGR-CONFIG]` line (`base_path=""`). A wrong `base_path` is loud in the other
direction too: every `/evaluate` comes back non-200, which is `fail_mode`
territory, not silence.

⚠️ **The identity headers are only as trustworthy as the edge that writes
them.** The plugin reports whatever arrives on them. Measured on the lab
gateway: a request authenticating as consumer `carol` that carried its own
`x-mse-consumer: root-admin` and `x-mse-consumer-group: platform-admins` was
reported as exactly that — `key-auth` (priority 310, so it does run first) sets
the headers when they are absent but did not overwrite the caller's.

That is one hole with two different sizes. A forged `agent_id` (or owner/user)
misattributes the audit trail; a forged **workspace** changes WHICH POLICY SET
applies, because the platform maps it to a workspace — so a caller who picks
their own workspace picks their own guardrails. Strip `x-mse-consumer` and
`x-mse-consumer-group` (and whatever you point the owner/user/type headers at)
from client requests at the edge, before AUTHN, or use headers no client can
reach. Verify it on your own deployment rather than assuming your auth plugin
does it; ours did not.

⚠️ **There is no `redact` switch.** Whether to redact is the RUNTIME's decision,
carried by the verdict (`decision: redact` plus `modifications.spans`). A gateway
that could turn it off locally would be a second place policy lives — and the
harder of the two to change.

⚠️ **`timeout_ms` bounds latency by giving up detection**, and the number matters
more than it looks. Measured against this runtime:

| | latency |
|---|---|
| single request, warm | 233–332 ms |
| 12 concurrent | 619 ms → 1647 ms, eight of them past 1s |

A 1s budget was tried on those grounds — 3x the single-request figure — and lost
nine of twelve concurrent requests to the model **unchecked**. Latency scales with
concurrency, so a budget sitting inside the working distribution means enforcement
evaporates exactly when the gateway is busy.

⚠️ **5s is a CEILING, not a target.** It is what a person will tolerate once, on a bad
request — the tail, not the middle. A deployment whose *average* sits near it has
already failed its users even though no counter fired: nothing timed out, nothing went
unjudged, and every request took five seconds. Expected latency belongs far below this.

⚠️ **The budgets must be ordered, outermost longest — and they all fit inside this
one:** `timeout_ms` > the runtime's `OGR_MODEL_TIMEOUT_MS` > the model gateway's own.
Equal budgets are not ordered; 5s here against 5s there makes "who trips first" a race,
so a slow turn can abort at the plugin while the runtime is still answering, and then
nothing can say what was slow — the plugin logs `status=0`, the runtime sees a client
that hung up, and the capability that actually blew the budget is named by neither.

⚠️ **Order the chain by lowering the INNER budgets, never by raising this one.** Raising
it was tried (8s) and reverted: it buys ordering by spending the user's patience, which
is the one resource in this chain that is not ours to spend. The runtime's inline model
budget has to be 5s *minus its own overhead* — policy resolution, Redis, serialisation,
network — not equal to it.

🔴 **The chain is NOT ordered in the shipped defaults, as of 2026-08-08.** This plugin's
`timeout_ms` and the runtime's `OGR_MODEL_TIMEOUT_MS` are both `5000`, so which trips
first is a race. When this filter wins it, the runtime is still working on an answer
nobody will read, and neither side can name the slow capability: we log a bare
`status=0`, the runtime logs a client that hung up. The timeout log says so explicitly
rather than leaving it to be rediscovered. Lowering the runtime's inline budget below
this one is the fix, and it is **pending a measurement of that side's non-model
overhead** — an estimate written down would become load-bearing, so nobody has picked a
number. Until then, treat a `status=0` as unattributed rather than as evidence about the
model.

⚠️ **It is a fan-out budget too.** A `model_output` carrying N tool calls costs the
runtime N concurrent judge calls (measured there: 20% of gateway calls over budget at
concurrency 8, **72% at 16**), so a turn with several parallel tool calls pushes the
*middle* of the distribution toward the ceiling — which is exactly what the ceiling is
not for. Fail-open then makes that failure *faster and quieter than success*: the turn
passes unjudged and throughput improves, so `unchecked` is the number that tells you.
One gateway call judging N actions with per-action attribution is the real fix and lives
in the pipeline's capability interface, not here.

Whatever the number, the timeout path logs

```
[OGR-REQ] request passed UNCHECKED (fail-open): evaluate returned 0 …
```

rather than a bare status code. Grep for it: if it is not rare, the budget is wrong
for that deployment — raise it, or accept that enforcement is best-effort there.

## Verified against the live lab (2026-07-30)

Local hermes -> Higress -> runtime, GLM-5.2 upstream:

| What | Evidence |
|---|---|
| every kind, from real agent traffic | `tool_register` 377, `user_input` 13, `tool_call` 13, `tool_result` 10, `model_output` 8 |
| the agent is RECOGNISED, not guessed | signature matched `hermes`, deployment_type `employee_service` — because the system prompt rides `payload.system` |
| streaming replies are reported | `model_output` from an SSE reply, reassembled chunk by chunk |
| refusal, both response shapes | JSON body and an SSE frame + `[DONE]`; the model never saw the prompt |
| redaction, end to end, real verdict | `decision=redact findings=2` from the runtime's own privacy guardrail (a tenant `custom_entities` regex, which needs no model), prompt masked, client got the plaintext back — buffered AND streamed |
| the platform stored nothing | every stored copy reads `${OGR_EMAIL_1}`; a `LIKE '%<address>%'` over `content_preview` and `payload` returns 0 rows |
| multi-turn across workers | turn 1 masked; turn 2 on a DIFFERENT worker re-masked the resent history from `x.ogr.redaction_map`, with no gateway-side store involved |
| the store holds ciphertext | the Redis value is base64 AES-GCM; grepping it for the address returns 0 |

## Build and test

```bash
make test    # ordinary Go tests — event derivation, redaction, the SSE restorer
make build   # GOOS=wasip1 GOARCH=wasm -> plugin.wasm
```

Nothing in this plugin may depend on being inside a Wasm VM: `go test` builds the
package for the host, and that is what keeps the parts that are easy to get wrong
(offsets, chunk boundaries, what counts as new) testable in a second.

### The local lab

Sideload rather than an OCI pull (the docker bridge on the dev box has no egress):

```bash
cp plugin.wasm references/higress_root/openguardrails-runtime.wasm
# WasmPlugin CR with url: file:///data/openguardrails-runtime.wasm, priority 200
```

⚠️ Priority must stay BELOW `key-auth` (310): the consumer and consumer-group headers
this plugin reads are written by key-auth, and a plugin that runs first sees
no caller at all.

⚠️ Bumping the version in the CR name is what forces a reload; editing config in
place does not always take.

## Releasing

Bump `VERSION`, then push the matching tag:

```bash
git tag higress-v1.0.1 && git push origin higress-v1.0.1
```

`.github/workflows/publish-higress.yml` refuses a tag whose version does not
match `VERSION`, runs the tests, builds `plugin.wasm`, and `oras push`es the
gzipped layer under both the version and `latest`. Higress then pulls it straight:

```yaml
url: oci://docker.io/openguardrails/higress:1.1.0
```

Publishing needs two repository secrets, `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`
(a Docker Hub **access token** scoped Read & Write to that one repository, never an
account password). Missing secrets fail the publish job rather than skipping it — a
tag with no artifact behind it is worse than a red run.

⚠️ GHCR was tried first, because the workflow can push there with its own
`GITHUB_TOKEN` and store no credential at all. It lost on the thing that matters
more: a GHCR package created by Actions stays PRIVATE until someone flips it by
hand in the UI, and a reference a gateway cannot pull anonymously is not a
release.

`workflow_dispatch` runs the build and packaging without pushing, so the release
path can be exercised before a tag exists.

## Support

thomas@openguardrails.com
