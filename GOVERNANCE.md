# Governance

OGR is the wire protocol OpenGuardrails' plugins speak, published so that anyone can read it, implement it
or connect their own detector. OpenGuardrails maintains it and also builds a guardrail product and
models, so it is not a neutral standards body and does not claim to be.

## Principles

1. **The wire is open.** The specification and schemas are Apache-2.0, and anyone may implement them.
2. **The evaluation is reproducible.** OpenGuardrails enters its own detectors in `benchmarks/`. The
   corpora, scoring and harness are public, so anyone can check a result, and results are published
   whether or not they favor us.
3. **Changes are additive.** Within 1.x a new wire field is optional in both directions.

## Scope of this repo

This repository is normative for:

- the `specification/` documents,
- the JSON Schemas in `schema/`,
- the taxonomy namespace (`safety.*`, `security.*`),
- conformance criteria (`CONFORMANCE.md`).

Implementations (`cli/`, `integrations/`, `benchmarks/`) are **not** normative — when an implementation disagrees with this repo, this
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
