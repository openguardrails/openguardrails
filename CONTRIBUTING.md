# Contributing

This monorepo contains the OpenGuardrails specification, SDKs, integrations,
gateway, benchmark, examples, skill, and website. Cross-component changes can
be made in one pull request; independently published packages keep their own
versions and changelogs.

## What belongs here

- Changes to `specification/*.md`
- Changes to `schema/*.json`
- Taxonomy additions/changes (`specification/taxonomy.md`)
- Conformance criteria (`CONFORMANCE.md`)
- Runtime changes under `packages/`
- Agent and framework bindings under `integrations/`
- Gateway, benchmark, example, skill, and website changes in their respective directories

Keep a change scoped to the smallest relevant directories. When a protocol
change affects an implementation, update both in the same pull request.

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
5. Run the relevant checks from the repository root: `npm run build && npm test`
   for JavaScript work and `python -m pytest` for Python work.

## Reviewing

Normative changes are reviewed against the [principles](GOVERNANCE.md#principles):
neutral, boundary-not-brains, provenance-first, defense-in-depth. A change that
advantages one detector vendor over others is out of scope by construction.

## Licensing

By contributing you agree your contribution is licensed under Apache-2.0.
