# Conformance

OGR conformance is intentionally narrow: it is about *speaking the wire*, not
about detection quality. Quality is measured separately by
[`openguardrails-bench`](https://github.com/openguardrails/openguardrails-bench).

There are four conformance roles. An implementation may play more than one.

## Detector conformance

A detector is **OGR-conformant** if it:

1. accepts a `GuardEvent` that validates against
   [`schema/guard-event.schema.json`](schema/guard-event.schema.json);
2. returns a `Verdict` that validates against
   [`schema/verdict.schema.json`](schema/verdict.schema.json);
3. references risk categories only from the published
   [taxonomy](specification/taxonomy.md) namespaces (`safety.*`, `security.*`),
   or a documented vendor extension namespace;
4. is deterministic with respect to its declared inputs — given the same
   `GuardEvent` and configuration, the verdict's decision is stable.

A conformant detector MAY ignore fields it does not understand, but MUST NOT
reject an event solely for containing unknown optional fields (forward
compatibility).

## Adapter conformance (agent hook / gateway / sandbox)

An adapter is **OGR-conformant** if it:

1. emits `GuardEvent`s that validate against the schema at its interception
   point, with `provenance` trust labels populated for every piece of context it
   can attribute (see
   [provenance](specification/provenance-and-context.md));
2. propagates `guard-context` so one logical action can be correlated across
   altitudes by `guard_id`
   (see [guard-context propagation](specification/provenance-and-context.md#guard-context-propagation));
3. honors the composed `Verdict` decision — `block` blocks, `allow` allows,
   `require_approval` gates — at its enforcement point;
4. fails closed on `security.*` decisions unless explicitly configured otherwise;
5. enrolls with its runtime before emitting enforcement-relevant events, and
   emits them only over a channel authenticated with its enrollment credential
   (see [Enrollment & approval receipts](specification/enrollment-and-receipts.md));
6. treats an approval as granted **only** after verifying an approval receipt —
   signature, expiry, scope, and payload-digest binding — and never honors a
   bare approval flag;
7. when emitting `content_encoding: redacted` (or `hashed`), populates
   `redactions` for every span it transformed and retains the original
   locally for verdict enforcement (see
   [Local redaction](specification/local-redaction.md)).

## Redactor conformance

A local redaction service is **OGR-conformant** if it implements the span
contract in [Local redaction](specification/local-redaction.md):
`POST /analyze` accepting `{text, language, score_threshold}` and returning
`[{entity_type, start, end, score}]`, plus `GET /health`. Any conformant
redactor container works with any conformant adapter; the adapter — not the
redactor — applies operators and holds originals.

## Composer conformance

A composer (the component that merges multiple detectors' verdicts into one
decision) is **OGR-conformant** if it implements the rules in
[composition](specification/composition.md) — including precedence, the
most-restrictive-wins default, and `require_approval` handling.

## Runtime conformance

A runtime (the Policy Decision Point) is **OGR-conformant** if it:

1. binds each enrolled PEP's channel identity to the `subject` values that PEP
   may assert, and rejects events where the two disagree;
2. accepts events from unenrolled PEPs only as **unverified** — usable for
   observability, never as the basis for minting receipts or granting
   enforcement authority;
3. mints approval receipts only after the approval flow for a
   `require_approval` decision completes, with bindings and expiry per
   [Enrollment & approval receipts](specification/enrollment-and-receipts.md);
4. distributes and rotates its verification keys so PEPs can validate every
   receipt for its full lifetime (overlapping rotation windows).

## Self-certification

Conformance is currently self-declared. State the version you target and the role
you implement, e.g.:

```
OpenGuardrails v0 — detector + adapter conformant
```

Validate against the schemas in `schema/` as part of your test suite. A shared
conformance test corpus is tracked in
[`openguardrails-examples`](https://github.com/openguardrails/openguardrails-examples).
