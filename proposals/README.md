# proposals — non-normative drafts

A **staging area for drafts that are not yet part of the standard.** Nothing in
this directory is normative: `specification/`, `schema/`, the taxonomy, and
`CONFORMANCE.md` are the ratified contract (see [GOVERNANCE.md](../GOVERNANCE.md)),
and a document here carries no RFC-2119 weight until its neutral parts have been
merged into those files through the normal PR process.

Use a proposal when you want to circulate a framework — a new vertical profile, a
candidate set of dimensions, an idea for a future field — for discussion **before**
churning the wire. This mirrors the sibling runtime repo's `docs/proposals/`.

## Lifecycle

1. **Draft** — add a `proposals/<name>.md` with a `Status:` banner, open a
   **GitHub Discussion** (or a **Draft PR**, which gives line-level comments — best
   for iterating on specific dimensions), and link it. Per
   [CONTRIBUTING.md](../CONTRIBUTING.md), an issue/discussion comes *before* a large
   change so the wire isn't churned twice.
2. **Accepted** — the neutral parts fold into `specification/` + `schema/` +
   `taxonomy.md` with a changelog entry and a version bump; the vertical-specific
   parts become an *informative* mapping section (the pattern healthcare, trading,
   and security-operations already follow).
3. **Retired** — the draft is deleted or marked superseded once merged. A proposal
   is a conversation, not a second source of truth.

## Current

- [`quant-agent-mandate.md`](quant-agent-mandate.md) — a quant/trading-agent
  profile of the [authorization envelope](../specification/mandate.md), with a
  candidate dimension set and the open questions worth deciding with a partner.
