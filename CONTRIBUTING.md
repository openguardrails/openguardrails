# Contributing

This repo is the **specification** for OpenGuardrails. It holds the normative
documents, JSON Schemas, taxonomy, and conformance criteria — not implementation
code. Implementations live in their own repos (SDKs, instrumentations, gateway,
bench); see the [README](README.md#the-ecosystem).

## What belongs here

- Changes to `specification/*.md`
- Changes to `schema/*.json`
- Taxonomy additions/changes (`specification/taxonomy.md`)
- Conformance criteria (`CONFORMANCE.md`)

If you're fixing a bug in an adapter or SDK, open the PR against *that* repo.

## How to propose a change

1. Open an issue describing the problem before a large change, so the wire isn't
   churned twice.
2. Submit a PR. Classify it in the description:
   - **Editorial** — wording, examples, clarification with no change to the wire.
   - **Normative** — any change to a schema, required field, verdict semantics,
     composition rule, or taxonomy ID.
3. For normative PRs, include:
   - a rationale,
   - a `CHANGELOG.md` entry,
   - a version bump (see [GOVERNANCE.md](GOVERNANCE.md#versioning)),
   - a migration note if breaking.
4. Keep schema and prose in sync — a field added to a schema must be documented in
   the matching `specification/` file, and vice versa.

## Reviewing

Normative changes are reviewed against the [principles](GOVERNANCE.md#principles):
neutral, boundary-not-brains, provenance-first, defense-in-depth. A change that
advantages one detector vendor over others is out of scope by construction.

## Licensing

By contributing you agree your contribution is licensed under Apache-2.0.
