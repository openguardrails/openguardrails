# OpenGuardrails Runtime — the Higress plugin

A Higress WASM plugin that speaks **OGR v0.8 directly to an OpenGuardrails
runtime**. It implements **the recipe of the v0.8 Runtime API**
([`specification/runtime-api.md`](../../../specification/runtime-api.md)) —
one recipe now, the same two POSTs per model call whether the integration is a
gateway or a developer's own agent loop.

It is called **OpenGuardrails Runtime** in the Higress console;
`openguardrails-runtime` is its plugin name.

```
   client ──▶ Higress ──▶ OpenGuardrails Runtime (WASM) ──▶ runtime
                              │                    POST {base_path}/v1/evaluate  (+ heartbeat)
                              ▼                    (base_path defaults to "", the canonical /v1/* root)
                          LLM upstream
```

## The v0.8 shape: a raw forwarder, nine fields + the build id

One proxied model call is one **step**, reported as two `/v1/evaluate` events:

| flow | event | payload |
|---|---|---|
| request | `step/request` | the provider request body, **verbatim** |
| response | `step/response` | the provider response body verbatim (plus a byte-inserted top-level `timing`); for a streamed reply, the canonical `{text, reasoning?, tool_calls?, model?, usage?, timing?}` shape reassembled from the SSE frames |

Both carry a plugin-minted `step_id` — a fresh opaque id per proxied call,
never reused, and never taken from `x-request-id` (a client retry could repeat
that). It is the one coordinate v0.8 kept, because concurrency makes it
underivable; everything above it is derived server-side, always. The event is
nine required fields — `kind`, `step_id`, the identity four-tuple (empty string
= explicit "no assertion"), `llm_protocol`, `payload` — plus `integration`, the
one optional one. No `ogr_version` (the runtime adapts), no `timestamp` (receive
time), no declared coordinates and no coordinate echo on the verdict.

`integration` is this plugin's own `name/version` (e.g. `ogr-higress/3.2.0`),
stamped on every event since **3.2.0**. It was heartbeat-only in 3.0.0–3.1.0,
which turned out to answer coverage but not triage: a runtime keys its liveness
row on the integration NAME, so this gateway's replicas and any other
`ogr-higress` under the same tenant collapse into ONE row whose version is
whoever beat last — and a beat can go quiet on its own precisely when a bad
rollout is what you are naming. Per-event, the build travels with the traffic it
produced and nothing can overwrite it.

**Nothing is decomposed client-side.** Earlier versions classified the
conversation into turns, actions and outcomes, itemised history, fingerprinted
the tool set, and carried a transcript envelope — roughly 900 lines of the
plugin doing the runtime's job, twice. All of it moved runtime-side; what
remains here is what only the thing in the byte path can do: hold the bytes,
enforce the verdict, splice the redactions, reassemble and time the stream, and
render a refusal in the caller's own protocol.

**Unreadable traffic is counted, not fabricated.** A completion body whose
protocol this plugin cannot name, or a stream no decoder reassembles, produces
NO event — `llm_protocol` is a required closed enum and inventing a value (or a
payload) would make the guardrails judge a fiction. The gap stays visible the
way the spec keeps every lost observation visible: the heartbeat's `unreadable`
counter plus a log line. (v0.7's `{"unparsed": true}` diagnostic event had no
schema-legal home left.) In enforce mode with `fail_mode: closed`, an
unreadable *reply* is refused outright — a reply we could not read is a reply
we could not judge.

## One switch

```yaml
mode: observe   # report only: never pauses a request, never touches a body
mode: enforce   # evaluate each step half before it proceeds, honour the verdict
```

| mode | dispatch |
|---|---|
| `observe` | **fire-and-forget `/evaluate`** — the verdict is discarded unread; nothing waits, nothing is refusable, because the request is already gone. |
| `enforce` | **awaited `/evaluate`** — one event, blocking, verdict honoured. |

**Observe still detects.** Evaluate records and judges everything it receives
(it is the observation channel — v0.8 removed `/ingest`), so the console fills
with findings while the gateway stays a mirror. That is what makes the
migration safe: watch for a week, then flip the switch. Rolling back is
flipping it back, not redeploying.

⚠️ **The two modes compute events identically; only the dispatch differs.**
⚠️ **Observe never buffers and never pauses.** Only enforce buffers, because
only enforce can still change the reply.

## Mirror

A second runtime can receive a COPY of every event and decide nothing:

```yaml
mirror_cluster: "outbound|80||openguardrails-candidate.static"
mirror_base_url: "http://openguardrails-candidate.static"
mirror_api_key: "ogr_..."      # falls back to api_key
mirror_base_path: ""           # falls back to base_path
```

⚠️ **Dispatched, never awaited, in every mode — including enforce.** A mirror is
not in the decision, so a slow or dead candidate must cost the caller nothing.
It rides `/evaluate` like everything else; its verdicts are never read.

## Which protocols it reads

Three, natively, each with its own adapter under
[`protocol/`](protocol/README.md):

| client speaks | path | `llm_protocol` |
|---|---|---|
| Chat Completions | `…/chat/completions` | `openai.chat` |
| Responses | `…/responses` | `openai.responses` |
| Anthropic Messages | `…/messages` | `anthropic.messages` |

Detected per request from the path, falling back to the body shape, and
reported on every event. Each adapter renders its own refusal, its own SSE
reader and its own restore paths — a refused Anthropic caller gets an Anthropic
reply.

⚠️ It is the **client's** protocol, never the upstream provider's. The plugin
runs at priority 200 and ai-proxy at 100, so on the request it sees the body
before ai-proxy translates it and on the response after ai-proxy has translated
back — both times, the shape the caller chose.

## Identity

The agent-id header becomes **`agent_id`** — the consumer the gateway
authenticated IS the agent. The workspace header becomes **`agent_workspace`**
— a group of agents plus one policy set. Both are header CHAINS, first
non-empty wins: the OGR spelling first (`x-ogr-agent-id` /
`x-ogr-agent-workspace`), then the MSE compatibility spelling
(`x-mse-consumer` / `x-mse-consumer-group`). The two MSE headers arrive
differently: `x-mse-consumer` is written by the AUTHENTICATOR (higress
`key-auth`, on every authenticated request), while `x-mse-consumer-group` is
an **admin-configured** header — no authenticator writes it; the operator
decides it (on MSE, by assigning consumers to groups in the console; on a
self-hosted gateway, by a header-injection rule on the route). Three more
renameable headers carry `agent_type`, `agent_user`. The user is
user are attributes; they never select policy.

### The default headers

Nothing has to be configured for identity to work. Each field is read from a
header (a CHAIN for id and workspace — first non-empty wins), falling back to
a static config value, and `agent_id` falls back once more to the credential
fingerprint floor:

| field | default header(s) | static fallback | rename with | asserted by |
|---|---|---|---|---|
| `agent_id` | `x-ogr-agent-id` → `x-mse-consumer` | `agent_id`, then `caller-<hash>` | `agent_id_header` | **the gateway** |
| `agent_type` | `x-ogr-agent-type` | `agent_type` | `agent_type_header` | the client |
| `agent_workspace` | `x-ogr-agent-workspace` → `x-mse-consumer-group` | `agent_workspace` | `agent_workspace_header` | **the gateway** |
| `agent_user` | `x-ogr-agent-user` | *(none — per-session by nature)* | `agent_user_header` | the client |

⚠️ **Configuring a `*_header` REPLACES the whole chain** with that one header;
it does not extend it. A field that resolves to nothing is sent as the empty
string — the spec's explicit "no assertion", never an error — and the runtime
falls back to what the API key says. The spec's cross-gateway version of this
table is [Runtime API § at a gateway](../../../specification/runtime-api.md#at-a-gateway-the-four-tuple-arrives-as-headers).

### Who gets to say what (2.1.0)

The five identity fields split in two, and the split is the security model:

| field | asserted by | why |
|---|---|---|
| `agent_id` | **the gateway** | names the party; a client that could set it would pick its own audit trail |
| `agent_workspace` | **the gateway** | selects the POLICY SET — the one field a caller must never choose |
| `agent_type` | the client | which harness is running; only the client knows, and it selects nothing |
| `agent_user` | the client | changes per request; only the client knows |

⚠️ **There is deliberately no consumer map in this plugin** — no
credential→name list, no consumer→workspace list. The gateway's authenticator
is the one source of the consumer name: higress `key-auth` writes
`X-Mse-Consumer` on every authenticated request and this filter reads it
through the chain above, with no plugin configuration at all. A 2.1.0
pre-release briefly carried a duplicate credential list here, justified by a
measurement that key-auth's header "does not reach a later WasmPlugin" — the
measurement was wrong (see the strip warning below for how), and the list was
two places to revoke a key plus a second copy of every secret. For a gateway
that cannot write a group header (open-source higress has no consumer groups),
the runtime console owns agent→workspace placement.

⚠️ **Strip the gateway-side headers at the edge** (`x-ogr-agent-id`,
`x-ogr-agent-workspace`, `x-ogr-agent-owner`, `x-mse-consumer`,
`x-mse-consumer-group`) — and strip them **before the authenticator runs**.
This filter cannot tell a header the gateway wrote from one the client sent,
and key-auth does NOT overwrite a client-supplied consumer header — a valid
credential plus a forged `x-mse-consumer` is attributed to the forgery.
Verified in the lab.

⚠️ **"Before" is a PHASE question, not a priority one.** Istio orders wasm
filters by phase first (`AUTHN` before `UNSPECIFIED_PHASE`), priority only
within a phase — so a strip transformer at `phase: UNSPECIFIED_PHASE,
priority: 400` runs AFTER key-auth at `phase: AUTHN, priority: 310` and
deletes the authenticated header it exists to protect. That mis-phasing is
exactly what produced the wrong measurement above: every caller degraded to
`caller-<hash>` and it read as "the header never propagates". Put the
stripper at `phase: AUTHN` with a priority above key-auth's: strip, then
authenticate, then report.

### When nothing names the agent (2.1.0)

A route that sends no consumer header and configures no static `agent_id` still
reports an agent — the plugin fingerprints the credential the CLIENT presented
(`Authorization: Bearer …`, `x-api-key` or `api-key`, first non-empty wins) and
sends `agent_id: "caller-<12 hex of sha256>"`.

⚠️ **This exists because the alternative was one agent per GATEWAY.** With no
`agent_id` on the event the runtime falls back to the credential it can see —
the gateway's own OGR API key — and since one gateway has one key, every
consumer behind it collapses into a single inventory row: one policy
resolution, one blast radius for every "move this agent" click, one owner for
traffic that had many. Different callers hold different keys, so fingerprinting
theirs is the true statement where the gateway's key was a false one.

⚠️ **The credential never leaves the gateway** — only its truncated hash does.
48 bits, so a collision (which would silently merge two callers) is negligible
at any real consumer count.

⚠️ **It is a FLOOR, not a substitute for key-auth.** It says "these requests
came from one credential", never whose. Two honest limits, both removed by
authenticating properly: a credential shared by a team is one caller here, and
rotating a credential mints a new agent row. The `caller-` prefix is there so
nobody reads a fingerprint as an authenticated identity.

Set `caller_fallback: false` to switch it off; the runtime's key-derived
`key-<…>` agent is then the last resort again.

The build id (`ogr-higress/<version>`) rides the **heartbeat**, not the event —
v0.8 moved it there, and fleet coverage / bad-rollout triage read it from the
heartbeat row.

⚠️ **The identity headers are only as trustworthy as the edge that writes
them.** The plugin reports whatever arrives. A forged `agent_id` misattributes
the audit trail; a forged **workspace** changes WHICH POLICY SET applies. Strip
the consumer headers from client requests at the edge, before AUTHN, or use
headers no client can reach — and verify it on your own deployment; ours did
not.

## Judging a STREAMED answer: hold the tail, judge once

**Not while it grows.** The pipeline measured mid-stream judgement directly: at
25% of the reply visible, false positives on `mt_harm_correct` are 0.353
against 0.000 on the whole reply — all of it the answer that agrees on the
surface and corrects underneath ("是的，很多人有这种念头——但这个想法是错的").
Early detection is a fit prefilter and an unfit blocking criterion. v0.8
codified the alternative (and deleted the `ogr-partial` interim evaluates and
the `output_mode` lane switch that preceded it):

```
first token ──► … stream flows to the caller … ──► last stream_tail_chars WITHHELD
                                                        │
                                    stream ends: reassemble the WHOLE answer,
                                    ONE step/response evaluate (canonical shape,
                                    transcribed usage + observed timing)
                                                        │
                                        allow ─► release the held tail
                                        block ─► drop the tail, CUT the stream
```

- The withheld tail is `stream_tail_chars` of client-visible content (default
  200, counted in UTF-8 bytes of text/reasoning/tool-arguments — never SSE
  framing; on multi-byte text the same setting withholds fewer *characters*,
  so set it higher if that matters). Release granularity is the chunk, so the
  hold is a floor, not an exact figure.
- **Tool calls never execute before the verdict**, whatever the tail setting: a
  provider stream only completes tool calls at its end, so argument
  completions, `finish_reason` and `[DONE]` are always inside the held tail —
  and the final chunk is never released by arithmetic, only by the verdict.
- **A block cuts the stream so the answer never completes as sent.** If nothing
  was released yet (short answer, non-SSE reply, tail larger than the answer)
  the caller gets a true refusal in its own protocol; otherwise the stream ends
  with the protocol's retraction frame (`content_filter` / `refusal` stop) —
  the head has been read and cannot be un-delivered, which is the accepted,
  spec-stated cost of streaming.
- **TTFT is unchanged** — the evaluate round-trip delays only the tail. A
  deployment that can accept no exposure at all sets the tail huge (the spec's
  `tail = ∞` limit case degenerates to buffering) or `stream: false`.
- A response the client streams but the provider answers whole (non-SSE) is
  held whole: partial JSON is useless to a client, so there is nothing to
  release early.
- **The final check always runs** — 11.5% of real violating replies have a
  question the input side never flags — and it runs even when the *request*
  evaluate failed open: the two step halves are judged independently.

## Token usage and timing (2.2.0)

Every `step/response` now carries the two per-step facts the trajectory view
reads — **`timing`** and **`usage`** — from whichever side of the four-way
split (buffered/streamed × observe/enforce) the reply took:

- **`timing`** = `{started_at, first_token_at?, completed_at}`. `started_at`
  is stamped when the request is RELEASED upstream (after the input verdict,
  in enforce), so TTFT measures the provider, not this filter's wait. A
  buffered reply omits `first_token_at` — buffering is exactly the mode that
  hides it. On the canonical (stream-reassembled) payload it is the ordinary
  field; on a buffered RAW body it is spliced in as a top-level `timing` key
  **by byte insertion, never re-serialization** — span offsets index the
  strings as transported, and Go's encoder would re-escape them.
- **`usage`** is transcription, never estimation — the gateway holds no
  tokenizer, and a provider that reported nothing yields NO field, not zeros.
  A raw buffered body already carries the provider's own `usage` untouched.
  A reassembled stream reports the canonical five counters (`input_tokens`,
  `output_tokens`, `reasoning_tokens`, `cache_read_tokens`,
  `cache_write_tokens`), captured per protocol: `anthropic.messages` splits
  them across `message_start`/`message_delta` (merged, either half never
  zeroing the other), `openai.responses` repeats them on the terminal event,
  and `openai.chat` omits them from streams entirely unless the request opts
  in — so:
- ⚠️ **In ENFORCE mode the plugin opts `openai.chat` streams into
  `stream_options.include_usage` itself** (after span application, so
  offsets were resolved against the body the runtime counted) **and swallows
  the resulting usage-only frame** — a client that never asked must not have
  to parse it; a frame that also carries `choices` is part of the answer and
  always passes, and a client that opted in itself keeps its frame. OBSERVE
  mode injects nothing — observe never touches a body — so chat streams
  under observe report usage only when the client opted in. That coverage
  gap is the price of the observe contract, stated rather than papered over.

## Redaction: applying the verdict's spans

The runtime never returns plaintext: a verdict carries
`modifications.spans[] = {path, start, end, replacement}` — offsets and a
token, never the matched text. The party that already holds the plaintext does
the splicing — this plugin, before the body is forwarded.

The applier is **generic**. A span's `path` names a location in the body we
sent (`payload.messages.3.content`, bracket form accepted), and the runtime —
which holds the session — returns spans for everything in the body that must
not reach the model: this turn's findings AND values bound on earlier turns
that the client re-sent in the clear. There is no registration table, no
protocol-specific mask paths and no gateway-side session store: the whole
conversation is in the body, so the spans cover it.

- Spans on one string apply **highest offset first**, so a splice cannot shift
  the offsets a later span was computed against.
- **Offsets are CHARACTERS, not bytes.** The detectors count code points and Go
  indexes bytes; on Chinese text a byte splice masks a fragment that matches
  nothing while the value travels on. Found live 2026-07-30.
- What each splice displaced becomes the token→value map that **restores the
  reply** (buffered and streamed — the SSE restorer handles tokens split
  across deltas and markdown-escaped tokens, and flushes its pending tail
  before the stream closes).
- ⚠️ A span that does not resolve — an unknown path, a non-string, offsets out
  of range — is **dropped and counted** (`unresolved_spans`), never applied
  somewhere else. Silent, that disagreement looks exactly like a workspace
  with no redaction policy; the counter is the only signal.
- ⚠️ Spans against a streamed reply's canonical payload cannot be spliced into
  SSE frames the caller already received; they are counted unresolved rather
  than half-applied.

## No state survives a request

The plugin keeps nothing across requests — no Redis, no session store, no
"already reported" marks. Each request re-derives everything from the bytes it
carries; the runtime holds the session, numbers the placeholders, and answers
each request with the spans that apply to it. An exact replay is judged again,
which is the safe direction: the opposite (suppressing a turn we believe we
have seen) is how a retried blocked prompt reaches the model unjudged.

## Liveness

Silencing a PEP is the cheapest bypass: uninstall the plugin and every request
is unguarded, with nothing in the console to say so. So the plugin heartbeats
every 30s as its **integration** (`{integration, interval_s, counters}`).
Silence past `interval_s` is a coverage loss, not an absence of risk.

| counter | meaning |
|---|---|
| `evaluated` | verdicts asked for and received |
| `unchecked` | **traffic that passed with no verdict behind it** |
| `reported` | events posted fire-and-forget (observe mode), verdict discarded |
| `mirrored` | events copied to the candidate runtime |
| `stream_stopped` | streamed answers refused or cut at end of stream — an overlay on `refused`, not an alternative to it |
| `unresolved_spans` | **modification spans that named nothing this body holds** |
| `unreadable` | bodies recognised but not parseable — NOT judged, and NOT reported as events (v0.8 leaves them no honest shape); this counter is the record |
| `refused` | **everything this filter refused** — a blocked request, a blocked REPLY (buffered or streamed), fail-closed, partial-closed, an unreadable reply under `closed`. A streamed refusal bumps `stream_stopped` too |

`unchecked` is the one to alert on: it is what a tight `timeout_ms` plus
`fail_mode: open` produces, and it is invisible in any other signal.
`unresolved_spans` is the second, and it fails the other way — nothing masked,
no error, indistinguishable from a deployment with no redaction policy.

### Partial verdicts, and what `fail_mode: closed` really promises

The promise to an operator who sets `closed` is: *if we could not judge it, it
does not go through.* That must hold one level deeper than transport. The
runtime fans out per text — a reply with five tool calls is five judge calls —
and one failing under the runtime's OWN fail-open produces a verdict that
looks complete: four actions judged, one never looked at, `decision: allow`,
HTTP 200.

**`unjudged` on the verdict** is what separates those: the payload paths that
reached a detector and got no judgement. Absent or
empty means everything routed was judged — the one assertion fail-closed hangs
on. Coverage, not attendance: a path appears if ANY guardrail routed to it
failed. The plugin does not interpret the entries — the security property is
non-emptiness, and entries go to the log verbatim.

Under `closed` a non-empty list refuses the event (with a message distinct
from the transport-failure one — the service answered, it just did not answer
about everything); under `open` it passes and bumps `unchecked`.

Also treated as failures, never as allows: a non-200, a timeout, a 429, and **a
200 whose body is not a verdict** (an empty body, an HTML error page — found
live by pointing the plugin at a cluster with nothing behind it and watching
the traffic pass with `decision=` empty).

## Configuration

| Key | Default | Notes |
|---|---|---|
| `runtime_cluster` | — | Envoy cluster, e.g. `outbound\|80\|\|openguardrails-runtime.static` |
| `runtime_base_url` | — | used for the Host header |
| `base_path` | `""` | the mount prefix the canonical `/v1/*` endpoint paths are joined onto |
| `api_key` | — | the runtime API key; authenticates the SENDER, resolves the org |
| `mode` | `observe` | `enforce` to act on verdicts |
| `timeout_ms` | `5000` | the PDP budget, enforce only. A CEILING for the worst case, not a target; the runtime's `OGR_MODEL_TIMEOUT_MS` must fit strictly inside it |
| `fail_mode` | `open` | **open is the spec's default** (an unanswered evaluate proceeds, counted `unchecked`); `closed` refuses when the PDP is unreachable, answers garbage, reports unjudged paths, or the reply itself is unreadable |
| `stream_tail_chars` | `200` | how much client-visible content a streamed answer withholds until the end-of-stream verdict (UTF-8 bytes; the spec's reference default). `0` still gates stream completion on the verdict; a huge value degenerates to buffering |
| `agent_id_header` | `x-ogr-agent-id`, else `x-mse-consumer` | which header carries the agent's identity; configuring one replaces the whole chain |
| `agent_workspace_header` | `x-ogr-agent-workspace`, else `x-mse-consumer-group` | which header carries the agent's workspace; configuring one replaces the whole chain |
| `agent_type_header` | `x-ogr-agent-type` | which header carries the kind of agent |
| `agent_user_header` | `x-ogr-agent-user` | which header carries who is using the agent this session |
| `agent_id` / `agent_type` / `agent_workspace` | *(unset)* | static fallbacks for a route fronting exactly one agent. No static `agent_user` — a constant user is already the runtime's default |
| `caller_fallback` | `true` | when nothing above names the agent, fingerprint the client's own credential into `caller-<hash>` rather than letting every consumer behind this gateway become one agent (see Identity) |
| `caller_key_headers` | `authorization`, `x-api-key`, `api-key` | which headers may carry that credential, first non-empty wins |
| `mirror_cluster` / `mirror_base_url` | *(unset)* | a candidate runtime that gets copies and gates nothing |
| `mirror_api_key` | `api_key` | the mirror's own credential, when it differs |
| `mirror_base_path` | `base_path` | the mirror's own mount, when it differs |
| `log_level` | `quiet` | `quiet` \| `info` \| `debug`. Quiet prints only what says the deployment is broken. Anything unrecognised is quiet — the failure mode of this setting is disk. |

### Which paths it calls

The canonical endpoint paths are rooted at **`/v1/`**: the plugin joins
`base_path` with `/v1/evaluate` and `/v1/heartbeat` (the whole v0.8 surface —
`/v1/ingest` no longer exists), and hard-codes no other prefix. The mount is **configuration, not discovery** — a
WASM filter cannot cheaply probe-and-fall-back, and a wrong `base_path` is
loud (every `/evaluate` comes back non-200, which is `fail_mode` territory,
not silence). What loaded is printed once, at startup, in the `[OGR-CONFIG]`
line.

### The budget, and why it is ordered

⚠️ **5s is a CEILING, not a target** — what a person tolerates once, on a bad
request. A 1s budget was tried and measured wrong: latency scales with
concurrency (12 concurrent: 619→1647ms), so a budget inside the working
distribution makes enforcement evaporate exactly when the gateway is busy.

⚠️ **The budgets must be ordered, outermost longest**: `timeout_ms` > the
runtime's `OGR_MODEL_TIMEOUT_MS` > the model gateway's own. Equal budgets are
a race, and when this filter wins it nothing can name what was slow. Order the
chain by lowering the INNER budgets, never by raising this one — that spends
the user's patience, which is the one resource in this chain that is not ours.

⚠️ **It is a fan-out budget too.** A response carrying N tool calls costs the
runtime N judge calls; fail-open then makes that failure *faster and quieter
than success*. `unchecked` is the number that tells you.

## Build and test

```bash
make test    # ordinary Go tests — the span applier, the SSE restorer, wire shapes
make build   # GOOS=wasip1 GOARCH=wasm -> plugin.wasm
```

Nothing in this plugin may depend on being inside a Wasm VM: `go test` builds
the package for the host, which is what keeps the parts that are easy to get
wrong (offsets, chunk boundaries, verdict reading) testable in a second.

### The local lab

Sideload rather than an OCI pull (the docker bridge on the dev box has no
egress):

```bash
cp plugin.wasm references/higress_root/openguardrails-runtime.wasm
# WasmPlugin CR with url: file:///data/openguardrails-runtime.wasm, priority 200
```

⚠️ Priority must stay BELOW `key-auth` (310): the consumer headers this plugin
reads are written by key-auth, and a plugin that runs first sees no caller at
all.
⚠️ Bumping the version in the CR name is what forces a reload; editing config
in place does not always take.

## Releasing

Bump `VERSION`, then push the matching tag:

```bash
git tag higress-v3.0.0 && git push origin higress-v3.0.0
```

`.github/workflows/publish-higress.yml` refuses a tag whose version does not
match `VERSION`, runs the tests, builds `plugin.wasm`, and `oras push`es the
gzipped layer under both the version and `latest`:

```yaml
url: oci://docker.io/openguardrails/higress:3.0.0
```

Publishing needs `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` (a Docker Hub
**access token** scoped to that one repository). Missing secrets fail the
publish job rather than skipping it — a tag with no artifact behind it is
worse than a red run. (GHCR was tried first and lost: a GHCR package created
by Actions stays private until someone flips it by hand, and a reference a
gateway cannot pull anonymously is not a release.)

## Support

thomas@openguardrails.com
