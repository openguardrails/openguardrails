# Changelog

All notable changes to the OpenGuardrails **protocol** are recorded here. This
tracks the wire (schemas, verdict semantics, provenance, composition, taxonomy),
not implementations. Downstream SDKs and adapters pin a protocol version.

The format follows [Keep a Changelog](https://keepachangelog.com/). The protocol
version is independent of any implementation's package version.

## [v0.4] — draft revision (proposal)

Agent-security observability and degraded-mode operation: keep a PEP safe when
the runtime is unreachable, attribute multi-agent delegation, and give the
agent-security threat classes standard IDs.

### Added
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

> `v0` is a draft: breaking changes are permitted between drafts and logged here.
> The first stable line is `v1`.
