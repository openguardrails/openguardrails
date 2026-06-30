# Governance

OpenGuardrails is a **neutral standard**. Its value depends on no single vendor
controlling what counts as "safe" or who wins the benchmark. This document
states how the specification evolves and how neutrality is protected.

## Principles

1. **The protocol is open and vendor-neutral.** No detector vendor, model
   provider, or sandbox operator has privileged control over the contract.
2. **The benchmark is a referee, not a contestant.** The party that maintains
   `openguardrails-bench` does not ship a competing detector ranked by it. The
   leaderboard methodology, corpora provenance, and scoring are public.
3. **Standardize the boundary, not the brains.** The spec defines the wire
   (`GuardEvent`, `Verdict`, provenance, correlation, composition). Detection
   quality stays competitive and out of scope.
4. **Taxonomy is versioned and swappable.** The contract references category IDs;
   it stays neutral on what each category deems unsafe.

## Scope of this repo

This repository is normative for:

- the `specification/` documents,
- the JSON Schemas in `schema/`,
- the taxonomy namespace (`safety.*`, `security.*`),
- conformance criteria (`CONFORMANCE.md`).

Implementations (SDKs, instrumentations, gateway, bench) live in their own repos
and are **not** normative — when an implementation disagrees with this repo, this
repo wins.

## Changes

- Changes are proposed as pull requests against this repo.
- **Editorial** changes (typos, clarifications that don't alter the wire) merge on
  maintainer review.
- **Normative** changes (any change to a schema, a required field, verdict
  semantics, composition rules, or taxonomy IDs) require:
  - a written rationale in the PR,
  - a `CHANGELOG.md` entry,
  - a version bump (see [Versioning](#versioning)),
  - a migration note when the change is breaking.
- Breaking normative changes should land behind a new protocol version, not
  silently mutate `v0`.

## Versioning

The protocol is versioned independently of any implementation. Downstream SDKs
and adapters pin a protocol version. See `CHANGELOG.md` for the version history.

- `v0` — draft. Breaking changes permitted between drafts; each is logged.
- `v1+` — stable. Breaking changes require a new major version.

## Toward foundation hosting

OGR is intended to be hosted by a neutral foundation. Until then, maintainers
commit to the principles above and to keeping the path to foundation governance
open: a transparent change process, a public benchmark methodology, and an
Apache-2.0 license with no vendor-specific carve-outs.
