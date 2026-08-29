# Changelog

All notable changes to the OpenGuardrails **protocol** are recorded here. This
tracks the wire (schemas, verdict semantics, provenance, composition, taxonomy),
not implementations. Downstream SDKs and adapters pin a protocol version.

The format follows [Keep a Changelog](https://keepachangelog.com/). The protocol
version is independent of any implementation's package version.

## [Unreleased]

### Added
- **Local secrets redaction, the TypeScript half (OGR 1.4 —
  `specification/local-redaction.md`, design in the AIRS repo).** A new shared
  package `integrations/agent/local-redaction/` (`@openguardrails/local-redaction`,
  zero runtime deps): `loadRuleset` (`GET /v1/rules`, `If-None-Match`/304, a 0600
  cache under `~/.openguardrails/`), `compileRuleset` (runs every rule's own
  `examples` in this engine and DISABLES a failing rule by id), the per-session
  value↔token `SessionMap` (in memory, bound 256, `${OGR_SECRET_X}` over the bound),
  `mask` with the §4.1 procedure (zero-width normalisation with an index map back,
  known values first, served order, longest-wins overlap, never inside a token),
  `maskRequest` over every string leaf, `restore` (whole-token, markdown-escape
  tolerant, never fuzzy) and `UNRESTORABLE_NOTICE`, plus the conformance corpus
  `conformance/local-redaction.json` the Python reference will share.
- **`@openguardrails/opencode-auto-mode` 0.4.0** — masks the messages sent to the
  model on `experimental.chat.messages.transform` (verified against
  `@opencode-ai/plugin` 1.14.28; a host without it gets no masking and no
  `redaction` field), tokenises `tool.execute.after` output before it enters
  history, restores `args` in `tool.execute.before` AFTER the guard's judge call (an
  unresolved token throws the notice), sends `redaction: { ruleset, masked }` on
  every event and `ruleset` on the heartbeat, and refetches when the heartbeat reply's
  `rules.id` moves. Options `localRedaction.{enabled,cachePath,tiers}`; env
  `OGR_LOCAL_REDACTION`, `OGR_RULES_CACHE`, `OGR_LOCAL_REDACTION_TIERS`.
- **`openguardrails-instrumentation-openclaw` 0.4.0** — the INGRESS model, since
  `llm_input` is observer-only: masks at `tool_result_persist` and
  `before_message_write` (both synchronous), restores `params` in a second
  `before_tool_call` handler at priority 10 (below the guard's 50, so judgement sees
  placeholders), same `redaction` report, same heartbeat `ruleset`, same options. The
  system prompt is NOT covered — `before_prompt_build`'s event carries no system
  prompt and its `systemPrompt` result is an override — and the README says so.

### Changed
- **Streaming enforcement is bounded from the HEAD of the answer, not its tail
  ([runtime-api.md § streaming](specification/runtime-api.md#streaming-release-a-bounded-head-judge-once)).**
  The recipe said "withhold the final `tail` characters (reference default 200)".
  That rule guarantees only that 200 bytes are withheld — it says NOTHING about
  exposure, because what reaches the client is `total − 200`, unbounded in the
  length of the answer. Measured on the reference gateway: a ~900-byte reply to a
  prohibited question was delivered essentially whole and then retracted, since the
  verdict cannot exist before the last token. The bound is now the FIRST `head`
  bytes of client-visible content (reference default **32**), which makes exposure a
  CONSTANT, independent of both the answer's length and the judge's latency.
  ⚠️ **Normative, and a CEILING**: a chunk that would carry the client past the
  bound is withheld whole rather than truncated, and `head = 0` is valid and
  releases nothing. Counted in UTF-8 bytes of text/reasoning/tool-arguments, never
  transport framing — so contentless frames still flow and a stream reads as live
  from its first frame.
  ⚠️ **Nothing about enforcement changed.** The answer is still judged exactly once,
  whole, at stream end; tool calls still never execute before the verdict, because a
  provider stream only completes them at its end and the terminal frames are always
  inside the held remainder.
  ⚠️ **What it gives up, stated rather than hidden**: under the tail rule an answer
  SHORTER than the tail released nothing, so a model refusing an unsafe question in
  one sentence produced a clean refusal by arithmetic. A head budget spends itself on
  the first bytes, so that answer now leaks its opening fragment and a block is a
  retraction. The tail bought that property by delivering the whole of every longer
  answer; `head = 0` buys it back honestly.
  The reference gateway implements this as `stream_head_release_bytes` in
  **higress 3.10.0**, which accepts, IGNORES and warns about the old
  `stream_tail_chars`.

### Removed
- **`findings[].action`** — the per-finding `flag` | `redact` | `block`
  contribution. No runtime ever emitted it, so every consumer branching on
  it matched nothing and silently fell back (the reference LangGraph
  integration built its block message from `action == "block"` and always got
  an empty set). What it claimed to add is already carried, twice over: an
  `allow` with findings IS "flagged", and `modifications.spans` names every
  text that must be rewritten, by path. A field that only ever reads as
  absent is worse than no field — it invites logic that cannot work.
  ⚠️ `findings[]` has `additionalProperties: false`, so a runtime that DID
  emit `action` now fails validation and must stop sending it. This is the
  one deliberate exception to 1.x's additive-only rule, taken while the
  release is days old and no such runtime is known to exist.

### Added
- **Local redaction (1.4) — the secret never leaves the host
  ([local-redaction.md](specification/local-redaction.md),
  [GuardEvent § `redaction`](specification/guard-event.md#redaction),
  [Runtime API § `GET /v1/rules`](specification/runtime-api.md#get-v1rules),
  [schema/ruleset.schema.json](schema/ruleset.schema.json))** — the client-side
  contract for an integration standing INSIDE the agent's process: mask every
  secret in the outbound provider request ON THE HOST, before it leaves, and
  restore the value into a tool's arguments only after the call has been judged
  and approved. Today every `sk-…`, every `.env` an agent reads and every
  `Authorization:` header it composes reaches the provider verbatim, and a
  runtime sees it AFTERWARDS, as a finding, from a copy that has already left;
  an in-process integration is the one vantage where "the secret does not leave
  the machine" can be true, so that is where masking goes. The placeholder is
  the existing `${OGR_SECRET_n}` shape, session-scoped and value-stable, held in
  memory and never on disk. Three pieces, all additive-optional: a fourth
  OPTIONAL GuardEvent field, `redaction: {ruleset, masked[]}` — the tokens
  MINTED in this step and the rule that minted each, never values; a rule feed,
  `GET /v1/rules` with `ETag`/`If-None-Match` → `304`, so an open-source
  integration ships NO patterns and the organization's set is served, with the
  current id advertised on the heartbeat response as `rules.id` and reported
  back on the heartbeat request as `ruleset`; and a regex dialect, `ogr-re-1`,
  the intersection of the engines the rules run in, with every rule carrying
  `examples` an integration MUST run at load, disabling by id what fails rather
  than running it wrong.
  ⚠️ **Not a decision, and nothing on the gateway path.** `decision` is
  untouched, the report takes no part in composition, and a gateway keeps the
  `modifications.spans` contract it has — at a gateway the secret has already
  left the host, and the runtime masks on its behalf.
  ⚠️ **The OGR client is an egress too**: every event sent to the runtime passes
  through the same map, or the feature protects the secret from the provider
  and hands it to us. A consequence the runtime relies on: it judges TOKENS,
  and `${OGR_SECRET_1}` in a `curl -H "Authorization: …"` still says a
  credential is flowing to that host.
  ⚠️ **Restore is whole-token exact match, into tool arguments only, after every
  judgement and approval, and never into user-facing or channel-delivered text
  by default.** A restorer that guesses — prefix, fuzzy, positional — is an
  exfiltration oracle; an unrestorable token BLOCKS the call with a notice the
  model can act on, because a shell expands the literal to nothing and the call
  fails downstream with nothing naming why.
  ⚠️ **`redaction` is a CLAIM, per the `integration` rule** — self-declared,
  never an input to a decision; the runtime verifies each reported token
  occurs in the body before counting it. A token in traffic is a SUCCESS
  record and raises nothing; a secret the runtime still finds on a step
  carrying the report is a finding WITH a diagnosis — stale ruleset, missed
  rule, or uncovered shape — where before it was a mystery.
  ⚠️ **`pii` is excluded, on purpose.** A secret is opaque, so masking it is
  lossless for the model and can be done blind; a PII value has semantics and
  masking it changes what the model can do. PII stays a judged, runtime-side
  redaction.
  ⚠️ **A fetch that failed means UNKNOWN, never "no rules"** — cache, then fail
  mode — and absent `rules` on a heartbeat never means empty. Optional in both
  directions, as `limits` is: an integration that never fetched masks nothing
  and is judged exactly as before.
  This is not v0.4's local-redaction specification returning: that one
  specified a redactor SERVICE and a wire field describing what it had done,
  and v0.7 deleted it; this one specifies a client behaviour and a rule feed,
  and the transported body is judged as an ordinary event. Reference
  integrations: hermes 2.0, opencode 0.4, openclaw 0.4 (in progress).
- **`verdict.continuation` — how to say no to an agent
  ([verdict.md](specification/verdict.md#continuation--how-to-say-no-to-an-agent-13))**
  — an OPTIONAL rendering directive beside a `block`, saying which SHAPE the refusal
  should take for a caller that is an agent loop: `drop_calls` (remove the refused
  tool calls, keep the rest), `withhold` (replace a tool result with a notice and
  forward the request), `answer` (render the notice as the whole reply).
  ⚠️⚠️ **It changes nothing about what is enforced.** The refused action still does
  not proceed and `decision` still says `block`; only the token the turn ends on
  moves. It exists because the obvious rendering — `finish_reason: "content_filter"`
  / `stop_reason: "refusal"` — is a TERMINAL condition in every agent harness
  measured: not retried, no reason given to the model, the whole run abandoned. One
  refused step ended a nine-step task, and the decision was right while the rendering
  threw away the agent's remaining work.
  ⚠️ **Optional in BOTH directions.** A runtime may omit it; a PEP that ignores it
  refuses exactly as it did before, which is the strict side — ignoring this key can
  never let something through. So the two ends roll forward independently.
  ⚠️ **The style follows the POSITION of the blocking findings, not the guardrail**:
  only a tool call can be dropped, only a tool result withheld, and a runtime must not
  emit a positional style whose paths it cannot name. A partial rendering that
  forwards some refused calls under a notice claiming they were refused is worse than
  refusing the turn whole.
  ⚠️ **`withhold` is not a redaction** — its replacement must never enter the PEP's
  restore map, or the model's reply rehydrates the content that was withheld. And on a
  stream a PEP must not end on a normal completion once tool-call bytes have reached
  the client: harnesses act on tool calls being present rather than on the finish
  reason, so it would run a call with truncated arguments.
- **Mandate — the authorization envelope ([mandate.md](specification/mandate.md),
  [schema/mandate.schema.json](schema/mandate.schema.json))** — the operator's
  declaration of what one workspace's agents may do, judged against the tool
  calls they actually make. It closes the one gap every other control leaves
  open: an action that is not dangerous in itself and not dangerous for every
  agent — `place_order(NVDA, 5000)`, `nmap 203.0.113.5` — where the only thing
  that makes it a violation is *what this agent was authorized to do*. This is
  the failure mode operators call **drift**, and it is invisible to content
  judgment by construction. Additive-optional and CONFIGURATION-ONLY: the wire
  is unchanged and a violation arrives as an ordinary `finding`.
  ⚠️ **A mandate is NEVER on the wire.** It is resolved by `agent_workspace` from
  the runtime's own config; a runtime MUST NOT accept one from a producer, because
  the process that would exceed an envelope is the last one that should supply it.
  ⚠️ **A missing mandate is no envelope, not an empty one** — a runtime MUST NOT
  refuse the actions of an unconfigured agent.
  ⚠️ **It judges CALLS (L2), not EXECS (L1).** A mandate is not a pre-trade risk
  control and not a firewall; it cannot recall an order or a packet a process
  holding the credential already sent. Where a regime requires controls at the
  point of access (SEC Rule 15c3-5, MiFID II RTS 6) they belong at the broker/OMS,
  and a mandate complements them by seeing the reasoning and instruction flow.
  ⚠️ **It reports what it cannot read.** An unbound tool, an absent field, or any
  dimension needing state outside the payload is `unjudged`, never assumed clean.

- **Action-integrity taxonomy ids ([taxonomy.md](specification/taxonomy.md))** —
  the neutral `security.*` ids the two action-first verticals need, none of them a
  vertical sibling: `security.mandate_violation` (+ `.scope` / `.capability` /
  `.limit` / `.window` / `.irreversible`), `security.market_manipulation`
  (+ pattern subcategories), `security.restricted_information` (MNPI and the like),
  and `security.persistence`. With two informative mapping sections mirroring the
  healthcare one — **agentic-trading** and **security-operations** — that map each
  vertical's failure modes onto the shared ids (and, for security work, onto MITRE
  ATT&CK tactics), plus executable category-expectation corpora
  (`benchmarks/suites/security/mandate_violation_{trading,secops}.jsonl`) and a
  runnable mandate at [`examples/mandate-agent/`](examples/mandate-agent/).
  ⚠️ **There is no `offensive.*` domain and there will not be one.** An id meaning
  "this was an attack" would have to be decided from intent, which no detector
  observes; a defender's agent and an attacker's agent raise every one of these
  questions identically, and the only thing that separates them is the envelope the
  operator declared in advance.

- **The Artifact Scan API ([artifact-scan.md](specification/artifact-scan.md))** —
  the SIBLING contract a scanner implements, so an obligation can name a
  scanner without naming a vendor. `POST /v1/analyze` with
  `kind: file|package|url|text`, a three-state `clean|suspicious|malicious`
  verdict, and a **hash-first, range-negotiated** upload: the client sends
  sha256 + size + declared type + the first 4 KiB, a known hash answers with no
  upload at all, and otherwise the SERVER names the byte ranges it wants.
  ⚠️ **A runtime MUST NOT proxy artifact bytes** — whoever holds them calls the
  scanner, and the credential lives with that caller. A verdict never carries an
  address or a credential.
  ⚠️ **The verdict is a DETECTION, not an outcome**: `suspicious` is an answer,
  and whether it stops the action is the calling policy's decision.
  ⚠️ **A client MUST NOT manufacture a pass.** An unpolled `202`, a non-2xx, an
  unparseable body and an unknown verdict are all failures — converting any of
  them to `clean` is the one error here that cannot be detected afterwards.
  ⚠️ **`kind: package` MUST be ecosystem-qualified** (`npm:`, `pypi:`, …):
  `left-pad` names different things on npm and PyPI.
  ⚠️ Range negotiation is OPTIONAL for a SERVER — an adapter in front of a
  signature scanner answers "send everything" — because making it mandatory
  would exclude exactly the on-premise scanners this pluggability admits.

- **Obligations — `verdict.obligations[]` and `GuardEvent.obligation_results[]`
  ([Obligations](specification/obligations.md))** — something the enforcement
  point MUST DO before the action proceeds, carried BESIDE a decision that is
  still `allow`. The first and only type is `scan_artifact`: a tool call names
  a file, package or URL it is about to open, the bytes are on the agent's host
  where no decision point in the model path can reach them, and the runtime
  requires an answer it cannot produce itself. Additive-optional, so every 1.0
  and 1.1 implementation is unaffected.
  ⚠️ **An obligation is not a decision** — `decision` stays `allow`/`block` and
  obligations take no part in composition.
  ⚠️ **A runtime MUST NOT rest a control on one being fulfilled.** The key is
  optional and a conformant PEP may ignore it; what an ignored obligation buys
  is MEASUREMENT (the fraction that go unfulfilled is how real this control is
  in a deployment), never assurance.
  ⚠️ **No endpoint and no credential in the verdict.** `provider_hint` is a
  non-secret NAME; a PEP MUST NOT treat it as an address. Whoever makes the
  scan call holds the scan credential — a verdict frequently crosses into a
  different trust zone from the console that set the policy.
  ⚠️ **A locator is the AGENT's string** — `./report.xlsm` means whatever its
  working directory makes it mean. A runtime MUST NOT resolve or normalise it.
  ⚠️ **`declared_type` is a CLAIM**, taken from the name alone. Its value is
  that the bytes can contradict it: a 300 MB executable wearing an `.mp4` name
  is exactly that disagreement.
  ⚠️ **A fulfilment report is SELF-DECLARED** — a PEP that called no scanner and
  reported `clean` is byte-identical to one that called and was told `clean`.
  A runtime MUST NOT treat it as verified nor make it an input to
  authorization. Same rule as `integration`.
  Results ride the NEXT `step/request`, beside the `tool_results` for the same
  calls — no extra round trip and no second endpoint on the hot path.

- **`GET /v1/limits`, and the same object on the heartbeat response
  ([Runtime API § GET /v1/limits](specification/runtime-api.md#get-v1limits))** —
  what a caller may send: `max_request_bytes`, a per-KIND cap on inline
  attachments (`media.image`, `.audio`, `.video`, `.document`, `.file`) and
  `media_parts_max`. A runtime MAY bound these per organization; this is how a
  producer learns the numbers at configuration time instead of discovering them
  as `413`s in production. Additive-optional in both directions.
  ⚠️ **An unaccepted attachment MUST NOT fail the request.** `media[kind] = 0`
  means the kind is not accepted, and the runtime records what arrived and
  reports the part's path in the verdict's `unjudged` list. A decision point
  that refused a whole turn because it will not store a screenshot would force
  every gateway in front of it to choose between breaking the turn and failing
  open — and failing open leaves no record at all.
  ⚠️ **Advisory to a producer, authoritative at the runtime.** A producer MUST
  remain correct having never fetched them, and one that also holds a local cap
  MUST use `min(local, advertised)`: learning a larger cap does not license
  exceeding an operator's own bandwidth decision.
  ⚠️ **Absent is not zero.** No `limits` on the response means UNKNOWN — a
  producer falls back to its configured behaviour rather than treating every
  kind as refused. This is what keeps a 3.x reporter working against a runtime
  that serves no limits at all.
  ⚠️ Over `max_request_bytes` is the one HARD refusal:
  `413 {"error": "payload_too_large", "limit_bytes", "received_bytes"}`, and the
  runtime SHOULD refuse before reading the body — the cost is holding the bytes,
  not answering.
  Implemented in the higress plugin as of **3.8.0**, which folds the advertised
  caps into its own `media_max_bytes` per kind. ⚠️ The two `0`s are opposite
  there: `media_max_bytes: 0` means *send everything*, an advertised `0` means
  *refused*.

- **Media parts, and `payload._ogr_media`
  ([GuardEvent § Media parts](specification/guard-event.md#media-parts-ogr-11))** —
  a payload's images, audio, video and documents are named as what they are:
  UNJUDGED content, in the provider's own shapes, that no guardrail in this
  specification reads. Additive-optional, so every 1.0 producer stays
  conformant.
  An integration MAY elide an oversized inline part rather than send it — a
  short video is tens of megabytes, and in an enforcing deployment the caller
  waits while all of them cross the wire to be not-read — and when it does it
  replaces the value IN PLACE with `ogr-media:elided` and describes it in a
  top-level `_ogr_media` array (`path` · `kind` · `media_type` · `bytes`).
  ⚠️ In place, never removed: dropping the element shifts every later array
  index, and a verdict span behind it still resolves — onto the wrong string.
  ⚠️ Base64 only, never text: the payload IS the judged input, so a producer
  that shortened a prompt would blind the detectors on the largest requests.
  ⚠️ Every field is a producer CLAIM about what it saw; a runtime must not
  accept a storage locator from it.
  The forwarded body is untouched — eliding is a property of the report.
  Implemented in the higress plugin as `media_max_bytes` (3.7.0, default
  4 MiB).
- **[Runtime API § a complete exchange](specification/runtime-api.md#a-complete-exchange)** —
  both halves of one model call written out whole: every field a producer may
  send (the eight required plus all three optional), the raw provider bodies,
  and the verdict each half returns — an `allow` carrying redaction spans,
  then a `block` on the tool call. It also states the offsets rule an
  integrator hits first: a finding carries `start`/`end` only where the judged
  text is a verbatim string leaf of the transported body, which is why an
  OpenAI tool call's JSON-encoded `arguments` yields a path and no offsets.
- The [protocols FAQ](https://openguardrails.com/api/docs/faq/) — what
  `llm_protocol` accepts, what "different models mean different payloads"
  costs an integrator (nothing: forward the raw body), and what to send when
  the protocol is your own. Linked from the README.
- **The layer model in harness vocabularies** ([overview.md](specification/overview.md)
  § The layer model in harness vocabularies, with the comparison table also in
  the [README](README.md#the-same-six-layers-in-five-other-vocabularies) and
  mirrored at
  [the layer model](https://openguardrails.com/api/docs/concepts/layer-model/#your-harness-already-has-words-for-this)
  and in the FAQ) — one table putting the six layers beside the
  OSI/TCP-IP stack and the four vocabularies a harness already has for the
  same traffic: OpenTelemetry's GenAI semantic conventions (and OpenInference's
  span kinds), the **OpenAI Agents SDK**, the **Claude Agent SDK**, and
  **LangGraph**, each with the wiring notes that follow from it. **Informative, not normative**: no
  part of the wire contract depends on it. The anchor is L4 — the inference
  span (`chat {model}`, `generation_span`, one loop round trip, one model-node
  execution) is a step, exactly 1:1 — so a harness SHOULD mint `step_id` from
  that span's id, which covers both halves of the step and makes every guard
  row joinable to its trace. Session comes from `gen_ai.conversation.id` /
  `SQLiteSession` id / `session_id` / `thread_id`, all of them `session_hint`;
  turn is one `Runner.run()` / `query()` prompt / graph `invoke()`; call is
  `execute_tool` / `function_span` / a `tool_use` block / a `ToolNode` call.
  ⚠️ **"Turn" means this stack's STEP in both the OpenAI Agents SDK and the
  Claude Agent SDK** — there a turn is one iteration of the agent loop and is
  what `max_turns` counts, while an OGR turn is the user-instruction episode
  containing those iterations. Same word, one layer apart; an integrator
  reading either SDK's docs will hit this first.
  The OSI column is exact through L4 — exec/call/event/step on
  physical/link/network/transport, the packet at L3 in both — and deliberately
  empty above it: turn and session are this domain's own L5 and L6, not OSI's
  session and presentation layers.
  ⚠️ **A span is an interval, a GuardEvent is a half**, and telemetry is
  sampled where enforcement is not — spans are written when an operation ends
  and cannot refuse anything, which is why exporting spans to a collector is
  not an integration. An SDK HOOK (`PreToolUse`, `wrap_tool_call`) is the
  opposite: it can refuse, which is where the agent-direct plugins sit.
  ⚠️ Two unrelated meanings of one word: a tracing span is not a verdict's
  `modifications.spans` (character offsets in a text).

### Fixed
- Examples across the specification, the skill and the reference integrations
  cited `security.cmd.data_exfiltration`, which is not a taxonomy id. The
  category is `security.data_exfiltration`.
- `runtime-api.openapi.yaml` typed `invalid_event`'s `details` entries as
  strings; they are objects naming the field that failed.
- The `fail_mode` examples keyed on `security.cmd.*`, which is not a taxonomy
  prefix either — nothing would ever have matched it. They name real ids now
  (`security.malicious_command`, `security.data_exfiltration`) and demonstrate
  the trailing `.*` on a subtree that exists (`security.secret_leak.*`).

## [v1.0] — 2026-08-19 — the first stable release

**The wire is v0.8's, unchanged, declared stable**: eight required fields,
three optional (`integration`, `connection`, `session_hint`), two kinds, one
endpoint. Within 1.x every change is additive-optional
(`additionalProperties: false` rejects unknown keys, not absent ones, so both
ends roll forward independently); anything breaking is a new major version.

### Added
- **The layer model is the protocol's normative foundational concept**
  ([overview.md](specification/overview.md) § The layer model, and the README
  front page). Two axes, the two a firewall has: an **entity axis** — tenant
  (the API key) → workspace (security zone, one policy set) → agent
  (host/endpoint, addressed by the identity four-tuple; an entity, never a
  layer) — and a **six-layer traffic stack**, numbered like the network stack
  it mirrors: **L6 session · L5 turn · L4 step · L3 event · L2 call ·
  L1 exec**. The event is the packet — the only layer on the wire; everything
  above it is derived by the runtime, everything below it is parsed from the
  payload (calls) or inferred (exec — named by the model, deliberately not
  carried by the contract). The correspondence follows the pragmatic TCP/IP
  cut, not OSI's seven: turn and session are this domain's own layers, defined
  here rather than mapped onto OSI's vestigial session/presentation layers.

### Changed
- Schema `$id`s move from `…/schema/0.8/…` to `…/schema/1.0/…`, and the
  OpenAPI document's version reads 1.0. No wire change rides the bump — a
  validator pinning the 0.8 `$id` validates byte-identical events.

## [v0.8] — the minimum API (unreleased — shipped as v1.0)

Everything a runtime can derive leaves the wire; everything only the
producer can know becomes required. An integration is an API key, eight required
fields, and one endpoint — the same recipe for a developer's own agent loop
and for a gateway. The minimal integration example ships in the spec, the
README, and `examples/minimal-agent/`.

### Changed (breaking)
- **The GuardEvent is eight required fields plus two optional.** Required:
  `kind`, `step_id`, the identity four-tuple (`agent_id`, `agent_type`,
  `agent_workspace`, `agent_user`), `llm_protocol`, `payload` — and the
  four identity fields are required *with the empty string as the explicit
  "no assertion"*, so every integrator answers the identity question instead
  of falling into the API-key floor by omission (the floor itself is
  unchanged). Optional: `integration`, `connection`, `session_hint`.

  ⚠️ Both of those numbers MOVED INSIDE v0.8, before release, and each has
  its own entry below — this bullet states where they landed, not where they
  started. The tuple opened as a FIVE-tuple (`agent_owner` removed); the
  event opened with ZERO optional fields (`integration` restored first,
  `connection` and `session_hint` added 2026-08-19). A producer built
  against an early v0.8 draft must read those entries, because
  `additionalProperties: false` rejects the extra key outright rather than
  ignoring it.
- **All coordinates are derived, always.** `session_id` / `turn` / `step` /
  `parent_session_id` leave the wire; the runtime chains sessions by
  conversation prefix (re-attaching across context compaction), closes
  turns by instruction boundary / `finish_reason` / idle timeout, and
  numbers steps by arrival. `step_id` is the one coordinate kept: the
  producer-minted id pairing one model call's two events, which concurrency
  makes underivable. The Verdict's `attribution` and coordinate echo go
  with them — there is no declared/derived distinction left.
- **`llm_protocol` is required and gains `canonical`.** The producer states
  the payload shape (`openai.chat` | `openai.responses` |
  `anthropic.messages` | `canonical`); the runtime may verify against the
  body. Raw-body forwarding is the norm; the canonical shape remains for
  integrations holding no provider body (own-format harnesses, stream
  reassembly).
- **Streaming: hold the tail, judge once.** A streamed response is judged
  exactly once, whole, after reassembly, while the integration withholds
  the stream's tail; `allow` releases the tail, `block` cuts the stream.
  Replaces v0.7's `ogr-partial` interim evaluates (a round-trip per
  chunk-batch) — and with it, `output_mode` leaves the Verdict.
- **Fail-open is the default.** An unanswered evaluate proceeds and is
  recorded as unjudged; `fail_mode: closed` remains the explicit opt-in for
  deployments gating dangerous categories (degraded-mode spec rewritten
  accordingly).
- **`findings[].subject` carries the detected value**, as the producer sent
  it. It was specified as a masked display form, which was theatre: the
  enforcement point supplied the very text being judged, so withholding it
  from the answer protected nothing from the only party reading it — while
  making "which value did this fire on" unanswerable in a console. The
  prohibition it sat beside is unchanged and now stated on its own: findings
  MUST NOT echo matched text per span. `subject` is the one bounded
  exception, at most one per finding, and it is what a false-positive
  exception keys on.

### Removed
- **`/v1/ingest`.** Evaluate records every event it judges; with `turn/end`
  and partial-stream reporting gone, a second channel had nothing left to
  carry. Buffered replay goes with it; the heartbeat's counters are how an
  outage-induced observability gap stays visible.
- **Kind `turn/end`.** The runtime closes turns itself (next-instruction
  boundary, `finish_reason`, idle timeout). The accepted cost: "completed"
  vs "aborted" is invisible from outside.
- **`ogr_version`** (the runtime adapts to what it receives; producers
  never version-gate) and **`timestamp`** (receive time).

### Changed (breaking, within v0.8)
- **The identity five-tuple is a FOUR-TUPLE: `agent_owner` is removed.** Who is
  ACCOUNTABLE for an agent is not something a producer can assert, and the field
  was failing in both directions at once — a per-request self-declared string that
  a runtime could not safely trust, and therefore one no runtime read.

  Ownership is a console concept with console consequences: it decides who may
  READ an agent's traffic. A permission cannot rest on a claim the caller makes
  about itself, and a route's header-injection mistake must not be able to flip
  it. So it becomes a link from the agent to an ACCOUNT the runtime already knows,
  assigned by an administrator — nothing about which belongs on this wire.

  The remaining four are exactly the fields only a producer can know AND a runtime
  uses: `agent_id` (identity, and what policy resolution hangs off),
  `agent_type` (label), `agent_workspace` (selects the policy set), `agent_user`
  (who a session serves, changing per request). `agent_owner` was the one that fit
  neither test.

  ⚠️ A CLEAN CUT, no deprecation window: `additionalProperties: false` means a
  producer still sending `agent_owner` is rejected outright. That is deliberate
  while v0.8 is unreleased — a field accepted-and-ignored teaches integrators it
  still means something. All ten shipped integrations, their strict mock runtimes
  and the gateway header contract move in this change; higress ships it as 3.4.0.
  ⚠️ Gateways also stop stripping `x-ogr-agent-owner` at the edge — one fewer
  forgery surface, and one fewer header a deployment has to get right.

### Reverted within v0.8
- **`integration` is back on the event, as the one OPTIONAL field.** v0.8 had
  moved the build id to the heartbeat alone. That reasoning holds for COVERAGE
  and fails for TRIAGE, in two ways that are both silent. A runtime keys its
  liveness record on the integration NAME — it must, so that a rollout updates
  its row instead of minting a second and reporting the old build as dark —
  which folds every deployment of one integration under a tenant into a single
  row whose version is whichever beat landed last: two gateway replicas on
  `ogr-higress/3.0.2` plus one lab instance on `3.1.0` produced one row reading
  `3.1.0`, naming the only instance that was sending no traffic at all. And the
  beat is a separate channel that can go quiet on its own (blocked egress, a
  misconfigured plugin, a tick that never fires) exactly when a bad rollout is
  what you are trying to name.

  On the event neither can happen: the build travels with the traffic it
  produced, no other reporter can overwrite it, and stored events can be split
  by build to compare behaviour across a rollout. The heartbeat's copy stays the
  LIVENESS signal; the event's copy is the TRIAGE signal.

  Integrations SHOULD send it; runtimes MUST accept an event that omits it. That
  asymmetry is what lets the two ends of a deployment roll forward
  independently — requiring it would reject every build already in the field.
  It remains a self-declared label: as trustworthy as the credential that
  carried it, and never an input to authorization or policy selection.

  **Every shipped integration now sends it** — higress, mitmproxy, the
  openai/anthropic example gateway, claude-code, codex, dsh, hermes, langgraph,
  litellm, openclaw and opencode. Each stamps it at its single send seam rather
  than at each construction site: a second construction path is how a build id
  goes missing on one kind of event only, which reads as "that half of the
  traffic came from an unknown build" and is worse than sending nothing.

### Added
- **`instance_id` on the heartbeat**, optional, opaque, minted by the reporter
  and stable for its process's life but NOT across restarts (a restarted process
  has fresh counters; reusing the id would splice two series and make a monotonic
  counter appear to go backwards).

  A runtime MUST key the INTEGRATION record on the NAME — otherwise a rollout
  mints a second row and reports the old build as dark — which makes `version`
  and `counters` properties of an INSTANCE that were being stored on the
  integration. So every replica silently overwrote the others: the record showed
  whichever beat landed last. Runtimes MUST now record `version` and `counters`
  per `(integration, instance_id)`, and MUST treat a beat without one as a single
  unnamed instance, which reproduces the old collapse for older reporters but as
  a row that says so rather than as a scalar being overwritten.

- **`connection` on the GuardEvent** — optional, opaque: the reporter's own
  downstream-flow id (e.g. `<instance>#<connection ordinal>` for a gateway),
  stable for the life of one client connection, never reused across processes.
  It exists because both content-level session signals were measured failing at
  once in production (2026-08-19): a harness that tail-trims its history
  rewrites every conversation prefix a runtime could chain on, and a bridge in
  front of the model strips every session field the client asserted — while the
  keep-alive connection under them never changed. A runtime MAY use it only as
  a corroborated last-resort grouping signal (a connection names a PROCESS —
  possibly several concurrent conversations, possibly an L4 balancer's pool)
  and MUST NOT derive trust, authorization or policy selection from it. Same
  additive-optional discipline as `integration`: `additionalProperties: false`
  rejects unknown keys, not absent ones, so both ends roll forward
  independently. Shipped by higress 3.5.0.

- **`session_hint` on the GuardEvent** — optional, opaque: the producer's own
  name for the conversation this step belongs to, sent on every event of the
  session including side calls and subagents. NOT v0.7's declared coordinates
  returning: a hint is a grouping signal the runtime may decline, never
  authority — turns, steps and ordering stay derived, and trust/authorization
  never rest on it. It exists because content-derivation measurably fails on
  real harness behaviour (compacted and tail-trimmed histories rewrite every
  prefix a runtime can chain on, 2026-08-19) while the producer holds the fact
  the whole time — the agent-direct integrations literally had the session id
  in hand and no field to say it in. Same additive-optional discipline as
  `integration`/`connection`.

- **`timing.received_at` on `step/request`** — when the integration SAW the
  request, alongside the `timing` a `step/response` already carries. It is
  the far end of a duration whose near end is the previous step's
  `completed_at`, so a runtime can measure the agent's own tool-execution gap
  from two instants **one process stamped** instead of subtracting a producer's
  clock from its own.
  This is not `timestamp` coming back, and the spec now says so where the
  fields are defined: `timing` is a set of DURATION ENDPOINTS and a runtime
  MUST NOT order events by it. Ordering stays derived from `step_id`, because
  nothing bounds how wrong a producer's clock is and the receiving end cannot
  audit it. Optional and additive — a `.strict()` validator rejects unknown
  keys, not absent ones, so producers and runtimes roll forward
  independently. higress ships it as **3.5.0**.

## [v0.7] — the ledger model

The protocol adopts the vocabulary agent harnesses themselves use — **Session
/ Turn / Step / Call** — and collapses to the one plane both real integration
points observe: LLM messages. One step (one model call) is two events; a turn
closes with a reason. Full design rationale:
`openguardrails-runtime/docs/v0.7-ledger-redesign.md`.

### Changed (breaking)
- **Kinds: 10 → 3.** `step/request`, `step/response`, `turn/end`.
  `llm_request`/`llm_response`/`user_input`/`model_output` were four names
  for the two step halves; `tool_call`/`tool_result` ride inside the step
  bodies (there is no kind left to shatter a step into);
  `exec`/`network`/`file`/`agent_spawn` go with the execution plane.
  `turn/start` deliberately does not exist (derivable); `turn/end` carries
  the close reason (`completed | max_tokens | blocked | aborted | error`).
- **Coordinates are first-class and 1-based.** `session_id` / `turn` /
  `step` declared by loop-owning integrations, derived by the runtime
  otherwise; the verdict echoes them with `attribution: declared | derived`.
  Declared always wins. `guard_id` → `step_id` (binding the two events of
  one model call is the only correlation job left). `parent_agent_id` +
  `delegation_chain` + `agent_spawn` → `parent_session_id` (sessions form a
  tree; each subagent reports its own session).
- **Verdict decisions: 5 → 2.** `allow | block`. Redaction is an `allow`
  with `modifications.spans`; "flag" is an `allow` with findings;
  `require_approval` is deleted outright (nothing produced it — a real
  hold-and-ask mechanism re-enters as new design). `reasons[]` and
  `categories[]` are removed (both restated `findings`); findings gain
  `severity`, `action`, `fp` (whitelist fingerprint), `whitelisted`, and a
  masked `subject`; `unjudged` and `output_mode` are promoted from
  `x.ogr.*` extensions to first-class fields.
- **Canonical response payloads carry `usage` and `timing`** (tokens,
  started/first-token/completed) — both vantage points have them for free,
  and they power per-step cost and latency analytics.

### Removed
- **The three-altitude model** (`observation_point`, the sensor evadability
  ladder `sensor_id`/`sensor_type`/`sensor_version` → one `integration`
  string, `sandbox_id`, cross-altitude correlation). The execution plane
  returns, if ever, as a future major version.
- **Attestation and enrollment** (`attestation`, `/v1/enroll`, Ed25519
  detached-JWS request signing, approval receipts, `/v1/approvals`,
  `approval-receipt.schema.json`, the attestation and
  enrollment-and-receipts specifications). The org API key remains the
  tenant boundary and identity floor.
- **The wire `provenance` array and local redaction**
  (`content_encoding`, `redactions[]`, the local-redaction specification).
  Provenance zones are derived runtime-side from payload structure.
- **The SDK layer.** `packages/python` (`openguardrails` on PyPI) and
  `packages/javascript` (`@openguardrails/core` on npm) are retired along
  with their publish workflows. The API is the integration surface; the two
  normative integration recipes live in the Runtime API binding.
- **The eBPF sensor and sandbox integration categories** (execution plane).

## [v0.6] — draft revision (in progress)

Protocol minimalism: identifiers are born at the runtime, the MUST set
shrinks to `kind` + `payload`, and everything nothing consumed is gone.

### Changed (breaking)
- **`event_id` leaves the request.** The runtime assigns a unique,
  time-ordered id at ingress and returns it — on the Verdict for
  `/v1/evaluate`, in the ordered `results` rows for `/v1/ingest`. Client-
  minted ids existed to make retries deduplicable, a transport concern that
  never belonged in the data model; **request deduplication is removed**
  (a retried timeout MAY duplicate a record — observability data tolerates
  it; exactly-once is future work for an optional idempotency HTTP header).
- **`guard_id` drops to MAY** — a correlation hint sent only by deployments
  that actually propagate a guard-context. Absent, the runtime assigns
  `guard_id = event_id` and SHOULD correlate altitudes **server-side** by
  (agent, time window, canonical payload projection digest — the same
  projections approval receipts bind). Rationale: the propagation token
  rides through the process OGR distrusts; a correlation that only works
  when the agent cooperates is a courtesy, not a correlation.
- **The GuardEvent MUST set is `kind` + `payload`.** `timestamp` (absent =
  receive time), `observation_point` (absent = defaulted from `kind`) and
  `ogr_version` (absent = current) all become optional. The minimal
  conformant integration is an API key and two fields.
- **Verdict loses `evidence` and `confidence`** — the former duplicated
  `findings` and nothing consumed it; the latter duplicated
  `categories[].score`. The WHY of a verdict is exactly three layers:
  `categories` (taxonomy), `findings` (structure), `reasons` (prose).
- **`GET /v1/config` is removed.** No integration ever called it; every PEP's
  degraded-mode policy is local configuration, with `x.ogr.on_unreachable`
  on verdicts available as a push channel.
- **`context_refs` is removed** — never consumed; `provenance[].ref` already
  carries the relationship with trust semantics attached.
- **Raw LLM traffic becomes the developer path**: two new kinds,
  **`llm_request`** (the untouched provider request body, sent BEFORE it
  goes to the model) and **`llm_response`** (the untouched provider
  response, sent BEFORE the agent acts on it). The RUNTIME derives the
  classification — new user words, fed-back tool outcomes, the model's
  prose and tool calls, the declared tool inventory — which through v0.5
  was every PEP's private burden (the reference gateway alone carried ~800
  lines of it). A developer integration is now: forward the request, act on
  the verdict, forward the response, act on the verdict.
- **Four kinds leave the wire**: `tool_register`, `mcp_connect`,
  `skill_load` (their facts ride the `tools` array and the system prompt of
  `llm_request`, where the runtime classifies them; no integration ever
  emitted the standalone kinds) and `config_change` (never emitted). The
  wire vocabulary is 10 kinds, of which a developer needs exactly two.
  Approval-receipt bindings shrink to the four enforceable projections
  (`tool_call`, `exec`, `network`, `file`).
- **`subject` and `sensor` are flattened into top-level scalar fields** —
  `agent_id`, `agent_type`, `agent_workspace`, `agent_owner`, `agent_user`,
  `sandbox_id`, `parent_agent_id`, `delegation_chain`, `attestation`,
  `sensor_id`, `sensor_type`, `sensor_version`. The `agent_`/`sensor_`
  prefixes already namespace the fields, so the envelope objects said the
  same thing twice; identity/attribution fields as flat top-level strings is
  also the shape the industry ships (OpenAI: `user`, `safety_identifier` —
  objects only for inherently structured data, which for OGR means
  `payload`, `provenance`, `redactions`). **`sensor_class` is renamed
  `sensor_type`** on the way: `*_id` = which one, `*_type` = which kind —
  one suffix rule with no exceptions to memorize; the closed, ordered
  vocabulary and its bypassable-when-absent semantics are unchanged.
- **Enrollment is organization-scoped** and its `guard_id` parameter is
  renamed **`pep_id`**: it names the enrolling sensor, which v0.5
  confusingly shared a name with the per-action guard group. The
  "workspace API key" is now the **organization API key** throughout — the
  key proves the tenant; WHERE an event lands is the agent's business
  (placement → asserted `agent_workspace` → the key's default, last).

## [v0.5] — 2026-08-12

The agent-centric identity remodel. OGR watches AGENTS, so the `subject` now
answers five questions about the actor — WHICH agent, WHAT kind, in WHICH
workspace, WHO built it, WHO is using it — and the human-identity vocabulary
(`principal`, `principal_group`) is gone.

### Changed (breaking)
- **`subject` is the agent five-tuple**: `agent_id` (org-unique identity;
  behind a gateway the authenticated consumer is the natural value),
  `agent_type` (harness or product name — a label, not an identity),
  `agent_workspace` (a named group of AGENTS the operator maintains, e.g. a
  gateway consumer-group; resolved only inside the tenant the channel
  credential proves), `agent_owner` (builder / responsible party), and
  `agent_user` (who is using the agent THIS session). **`principal` and
  `principal_group` are removed** — the caller-behind-the-gateway is now the
  agent itself, the caller's org-chart group is nobody's policy boundary, and
  owner/user are recorded as *attributes* of the agent and the session, never
  selectors of configuration.
- **`subject` and `subject.agent_id` drop from MUST to SHOULD** — see the
  identity floor below. The subject object closes
  (`additionalProperties: false`) and gains the `attestation` property the
  spec prose always documented.
- **Enrollment assertion scopes bound `agent_id`**, not `principal`,
  namespaces: with the agent as the identity, impersonating an agent is the
  blast radius a scope must cap. `constraints.principal` on pre-authorization
  approval receipts becomes `constraints.agent_id`.
- Wire version `0.4` → `0.5` in schemas (`$id`, `ogr_version`) and examples.

### Added
- **The API-key identity floor** (`runtime-api.md` § Authentication): the
  minimum conformant integration sends only the workspace API key and no
  `subject` at all. The runtime MUST then derive `agent_id` from the key (one
  key, one default agent), place the agent in the key's workspace, and treat
  every session as one user. Every asserted field refines that picture; none
  is a precondition for coverage.
- **The shadow-agent rule** (`guard-event.md`): events sharing an `agent_id`
  but disagreeing on `agent_type` — one credential driving hermes, openclaw,
  and claude-code at once — stay ONE agent (the id is the identity), and a
  runtime SHOULD surface the disagreement as a shadow-agent signal instead of
  splitting the inventory. `security.shadow_agent` names the signal in the
  taxonomy.

## [v0.4] — draft revision (proposal)

Agent-security observability and degraded-mode operation: keep a PEP safe when
the runtime is unreachable, attribute multi-agent delegation, and give the
agent-security threat classes standard IDs.

### Changed (breaking)
- **`safety.pii.*` → `privacy.pii.*`** — the span-level PII subcategory registry
  moves to a new normative `privacy.*` domain. `safety.*` is defined as harmful
  content judged at the content I/O boundary; per-entity masking policy is
  neither, and the registry's own purpose (interoperable per-entity masking) is a
  data-handling control. Leaves are unchanged, so the migration is a pure prefix
  swap: `s/^safety\.pii/privacy.pii/`.
  - `safety.pii` REMAINS, narrowed to the *content* class — the model uttering
    personal data in a reply (the reference moderation capability's S11). The two
    judgments were collapsed onto one id through v0.3.
  - `security.secret_leak` is unaffected: a leaked credential leads to compromise,
    so it stays a security threat class rather than a privacy one.
  - `schema/verdict.schema.json` and `schema/guard-event.schema.json` accept
    `privacy.*` in category-id patterns, and `categories[].domain` gains
    `privacy`. A validator pinned to v0.3 REJECTS `privacy.*` ids.
- **Vendor-namespace rule tightened**: a class with a neutral home in a normative
  domain MUST use it rather than an `x.<vendor>.*` id. The vendor namespace is
  for what the standard does not model yet, not a parking space.

### Added
- **Runtime API binding** (`specification/runtime-api.md`) — the normative
  HTTP surface a runtime exposes, previously implemented by six clients with
  no spec text: canonical `/v1/*` paths (`evaluate`, `ingest`, `enroll`,
  `heartbeat`, `config`, `approvals`, `health`), Bearer workspace-key auth,
  the `ogr-partial` interim-judgment header, the `ogr-batch-signature`
  detached-JWS attestation header, error shapes, the 207 ingest envelope, and
  the sanctioned extension fields (`run_id`, `turn`, `authz`, `x.ogr.*`).
  Anchors the API → SDK → Plugin layering.
- **`subject.principal_group`** (MAY) — the group `principal` belongs to, as the
  enforcement point already knows it. A gateway consumer-group is the motivating case:
  the operator maintains it, it arrives on every request for free, and a runtime can
  map it to whatever it calls a policy boundary without inferring anything.

  Two fields rather than one, and the reason is the one the industry already settled:
  `principal` is an AUTHENTICATION fact (the identity the PEP verified), a group is
  where AUTHORIZATION is organised. AWS IAM refuses to let a group be a `Principal` on
  exactly those grounds; Azure Entra goes the other way and calls a group a security
  principal, and this specification follows AWS because a PEP can verify a caller and
  cannot verify a grouping.

  ⚠️ Both are CLAIMS, and the new one carries a failure mode worth stating: a runtime
  MUST resolve `principal_group` only inside the tenant its channel credential already
  proves. It names a group; it does not grant one, and it is NOT a tenant identifier —
  a runtime reading it as one would let any caller name any tenant.

  Additive and optional, so a v0.4 PEP that omits it stays conformant and a validator
  pinned to an earlier draft is unaffected.

- **Heartbeat identifies the SENDER** ([liveness](specification/enrollment-and-receipts.md#liveness-heartbeat)):
  `sensor.id`, the same identity a PEP's events carry. The signal exists to catch a
  silenced integration, so it has to name the integration. An instrumentation that
  fronts exactly one agent MAY also name it (`subject.agent_id`); a gateway fronting
  many MUST NOT, because attributing its liveness to one agent reports the others as
  covered by a sensor that never spoke for them. Clarifying, not breaking: the shape
  was already `{interval_s, counters}` with no required subject.

- **Adapter degraded mode** (`specification/degraded-mode.md`): a PEP-side
  `on_unreachable` (`block | allow | require_local_approval`) per category-prefix
  for when the enforcement point cannot reach the runtime — runtime-independent
  local approval, locally cached hard rules that stay enforced, degraded
  entry/exit signaling, and tamper-evident buffered-event replay on reconnect.
  Replaces the blanket fail-closed default in `CONFORMANCE.md` (issue #3).
- **Actor lineage** — `subject.parent_agent_id` + `subject.delegation_chain` and
  an `agent_spawn` kind, so multi-agent delegation (unscoped privilege
  inheritance, confused deputy) is attributable and itself guardable; distinct
  from the data-lineage provenance already carried (`specification/guard-event.md`,
  `schema/guard-event.schema.json`, issue #4).
- **`config_change` kind** — an agent-hook adapter reporting mutation of its own
  guardrail surface (permissions, hooks, MCP allowlist, skills), semantics a
  sandbox `file` write loses (`specification/guard-event.md`, issue #5).
- **Liveness / heartbeat** — a transport-level PEP heartbeat with
  enrollment-declared cadence and counters, closing the "selective suppression"
  gap the threat model already referenced
  (`specification/enrollment-and-receipts.md`, issue #5).
- **`security.memory_poisoning`** and **`security.resource_exhaustion`** taxonomy
  IDs — persistent-memory corruption and loop/rate/spend abuse — as neutral
  standard IDs, with reference-detector coverage recorded as informative rather
  than an admission gate (`specification/taxonomy.md`, issue #5).
- **Detector encoding capability** — detectors declare which `content_encoding`
  values they can judge and MUST abstain otherwise; completes the edge-redaction
  story and flags a per-encoding benchmark axis as follow-up
  (`specification/local-redaction.md`, issue #6).
- **`safety.unsafe_advice`** taxonomy category — a domain-neutral failure mode
  for confident guidance in a high-stakes domain (medical/financial/legal) that
  is harmful, unsupported, or should have deferred/escalated to a human. Domains
  specialize via subcategory (`safety.unsafe_advice.clinical_escalation`) rather
  than a vertical sibling under `safety.*` (issue #14). (`specification/taxonomy.md`)
- **Reference moderation mapping** (informative) — the 18-class content-safety
  model now emits the most specific normative id per class, with rollup
  subcategories (`safety.toxicity.hate`, `safety.violence.threat`,
  `safety.illicit.commercial`, …) and `x.ogr.politics.*` / `x.ogr.national_symbols`
  for the jurisdiction-specific classes, replacing a generic `content_safety`
  bucket. (`specification/taxonomy.md`)

### Changed
- **Placeholder convention is now `${OGR_<TYPE>_<n>}`**, replacing
  `[PII:<category>:<ref>]` ([local redaction](specification/local-redaction.md#placeholder-convention)).
  A SHOULD, so no schema change — but the old shape does not survive the trip it
  exists to make: `[` `]` is a markdown link reference and `__` is escaped to
  `\_\_` by a model formatting its output, either of which breaks the exact match
  that restoration depends on. The new shape is delimited, markdown-inert, and
  keeps the value's kind legible so a judge can still reason about a credential it
  cannot see. `<n>` MUST be unique across the model's whole context (session
  scope, not per event), or two values collide on one placeholder and restoration
  returns the wrong one.
  - Restoration is specified as a *decision*, not a mechanism: a placeholder is
    reachable by the model, so an adapter SHOULD judge the placeholder-bearing
    action before restoring and bind a `ref` to the destinations it may be
    restored into. An unknown or expired `ref` MUST fail the action.
  - `operator: replace` is documented as restorable from an enforcement-point
    map, which is the cheap path for a value that only has to survive the current
    session — no ciphertext, no key management.
  - The `redactions` and `modifications` examples also carried pre-v0.4
    `safety.pii.*` ids; corrected to `security.secret_leak` / `privacy.pii.*`.
- Wire version `0.3` → `0.4` in schemas (`$id`, `ogr_version`) and examples. All
  new fields and kinds are optional and the taxonomy additions need no schema
  change: a valid v0.3 object is a valid v0.4 object after the version-string bump.
- Folded the specification into the namesake repo `openguardrails/openguardrails`
  as the canonical home of the standard. (Previously `openguardrails-spec`.)

## [v0.3] — draft revision (proposal)

Span-level detection and privacy-preserving deployment: separate *what was
found* from *what to do*, and let the enforcement point scrub payloads
before they ever leave the trust boundary.

### Added
- **`Verdict.findings`** — normalized span-capable detection results
  (`category`, `path`, `start`/`end`, `score`, `detector`); offsets only,
  never matched text (`specification/verdict.md`).
- **Reversible redaction** — `operator` (`replace|mask|hash|encrypt`) and
  `ref` on `modifications.spans[]` for stable pseudonyms and
  redact-then-restore round-trips.
- **Local pre-detection redaction** (`specification/local-redaction.md`):
  `GuardEvent.content_encoding` (issue #6) + `GuardEvent.redactions`
  metadata, the placeholder convention, and a **normative redactor
  contract** (`POST /analyze`, presidio-analyzer-compatible) with a new
  Redactor conformance role (`CONFORMANCE.md`).
- **`safety.pii.*` subcategory registry** with hierarchical rollup
  (`safety.pii.national_id.cn` → `safety.pii.national_id`) and an
  informative presidio entity mapping (`specification/taxonomy.md`).
- **Composition of modifications** — union-of-spans rule for `redact`,
  first-winner rule for whole-payload rewrites
  (`specification/composition.md`).

### Changed
- Wire version `0.2` → `0.3` in schemas (`$id`, `ogr_version`) and examples.
- All new fields are optional: a valid v0.2 object is a valid v0.3 object
  after the version-string bump.

## [v0.2] — draft revision (proposal)

One key model closing two `v0.1` trust gaps: unauthenticated events (#7) and
the forgeable approval flag (#2). Proposed together because approval receipts
and event authenticity share the same enrollment/key infrastructure.

### Added
- **Enrollment & approval receipts**
  (`specification/enrollment-and-receipts.md`,
  `schema/approval-receipt.schema.json`): normative enrollment outcomes,
  authenticated event channels, runtime-signed approval receipts bound to
  canonical payload digests (RFC 8785 JCS, per-kind digest inputs),
  cross-altitude bindings, and `pre_authorization` (JIT) grants.
- Runtime conformance role (`CONFORMANCE.md`).

### Changed
- `ogr-guardcontext` header version `01` → `02`: flags bit 1 is now advisory
  ("approval receipt attached") and carries no authority by itself; authority
  lives in the `ogr-receipt` JWS companion header.
- Wire version `0.1` → `0.2` in schemas (`$id`, `ogr_version`) and examples.

### Breaking — migration
- Version-`01` guard-context with flags bit 1 set MUST be treated as carrying
  **no** approval: the bit was forgeable by the propagating party.
- Adapters that gated on bit 1 must attach and verify `ogr-receipt` and emit
  version-`02` contexts.
- Treating an action as approved now requires receipt verification (signature,
  expiry, scope, recomputed payload digest) for adapter conformance.

## [v0] — draft

Initial draft of the contract.

### Added
- `GuardEvent` — the typed unit observed at an interception point
  (`specification/guard-event.md`, `schema/guard-event.schema.json`).
- `Verdict` — a detector's decision about an event
  (`specification/verdict.md`, `schema/verdict.schema.json`).
- Provenance — trust/taint labels on every piece of context, and `guard-context`
  propagation for cross-altitude correlation by `guard_id`
  (`specification/provenance-and-context.md`).
- Composition — how multiple verdicts combine into one decision
  (`specification/composition.md`).
- Taxonomy — `safety.*` and `security.*` risk categories
  (`specification/taxonomy.md`).
- Conformance criteria (`CONFORMANCE.md`) and governance (`GOVERNANCE.md`).

> Minor versions before `v1` may introduce breaking changes between releases;
> every break is logged here. The first stable line is `v1`.
