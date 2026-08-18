# Changelog

All notable changes to the OpenGuardrails **protocol** are recorded here. This
tracks the wire (schemas, verdict semantics, provenance, composition, taxonomy),
not implementations. Downstream SDKs and adapters pin a protocol version.

The format follows [Keep a Changelog](https://keepachangelog.com/). The protocol
version is independent of any implementation's package version.

## [v0.8] — the minimum API (in progress)

Everything a runtime can derive leaves the wire; everything only the
producer can know becomes required. An integration is an API key, ten
fields, and one endpoint — the same recipe for a developer's own agent loop
and for a gateway. The minimal integration example ships in the spec, the
README, and `examples/minimal-agent/`.

### Changed (breaking)
- **Zero optional GuardEvent fields.** Required, all of them: `kind`,
  `step_id`, the identity five-tuple, `llm_protocol`, `payload`. The
  five-tuple (`agent_id`, `agent_type`, `agent_workspace`, `agent_owner`,
  `agent_user`) is required *with the empty string as the explicit "no
  assertion"* — every integrator answers the identity question instead of
  falling into the API-key floor by omission (the floor itself is
  unchanged).
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
