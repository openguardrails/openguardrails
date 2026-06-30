# Changelog

All notable changes to the OpenGuardrails **protocol** are recorded here. This
tracks the wire (schemas, verdict semantics, provenance, composition, taxonomy),
not implementations. Downstream SDKs and adapters pin a protocol version.

The format follows [Keep a Changelog](https://keepachangelog.com/). The protocol
version is independent of any implementation's package version.

## [Unreleased]

### Changed
- Folded the specification into the namesake repo `openguardrails/openguardrails`
  as the canonical home of the standard. (Previously `openguardrails-spec`.)

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
