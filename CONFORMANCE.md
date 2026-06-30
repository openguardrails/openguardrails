# Conformance

OGR conformance is intentionally narrow: it is about *speaking the wire*, not
about detection quality. Quality is measured separately by
[`openguardrails-bench`](https://github.com/openguardrails/openguardrails-bench).

There are three conformance roles. An implementation may play more than one.

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
   `require_human` gates — at its enforcement point;
4. fails closed on `security.*` decisions unless explicitly configured otherwise.

## Composer conformance

A composer (the component that merges multiple detectors' verdicts into one
decision) is **OGR-conformant** if it implements the rules in
[composition](specification/composition.md) — including precedence, the
most-restrictive-wins default, and `require_human` handling.

## Self-certification

Conformance is currently self-declared. State the version you target and the role
you implement, e.g.:

```
OpenGuardrails v0 — detector + adapter conformant
```

Validate against the schemas in `schema/` as part of your test suite. A shared
conformance test corpus is tracked in
[`openguardrails-examples`](https://github.com/openguardrails/openguardrails-examples).
