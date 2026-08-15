# Conformance

OGR conformance is intentionally narrow: it is about *speaking the wire*, not
about detection quality. Quality is measured separately by
[`openguardrails-bench`](https://github.com/openguardrails/openguardrails/tree/main/benchmarks).

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
   `GuardEvent` and configuration, the verdict's decision is stable;
5. reports what it could not judge (`unjudged` paths) rather than answering
   as if it had looked.

A conformant detector MAY ignore fields it does not understand, but MUST NOT
reject an event solely for containing unknown fields (forward compatibility).

## Integration conformance

An integration is **OGR-conformant** if it implements
[the recipe](specification/runtime-api.md#the-recipe) in full:

1. emits `GuardEvent`s that validate against the schema, one event per step
   half — never a shattered step — with every field present (empty-string
   identity assertions included) and the raw provider body forwarded
   undecomposed;
2. mints a fresh `step_id` per model call and stamps it on both of that
   call's events; declares nothing else — no coordinates exist on the wire;
3. honors the `Verdict` at its enforcement point — `block` blocks, and
   `modifications.spans` are applied before content proceeds;
4. applies its configured fail mode on evaluate failure — open by default,
   configurable closed; under `closed`, treats a non-empty `unjudged`, an
   evaluate failure, and a 429 all as "could not look" (see
   [Degraded mode](specification/degraded-mode.md));
5. judges streamed answers once, whole, behind a held-back tail
   ([streaming](specification/runtime-api.md#streaming-hold-the-tail-judge-once)) —
   never chunk-by-chunk, and never releasing the tail or executing a tool
   call before the verdict.

## Runtime conformance

A runtime (the Policy Decision Point) is **OGR-conformant** if it:

1. serves the endpoints and semantics of the
   [Runtime API binding](specification/runtime-api.md) — canonical `/v1/*`
   paths, schema validation, runtime-assigned identifiers, and the
   documented error shapes;
2. resolves every asserted identity field only within the tenant the API key
   proves;
3. derives sessions, turns and steps server-side — re-attaching sessions
   across a harness's context compaction — and pairs each step's two events
   by `step_id`;
4. composes multi-detector answers per
   [composition](specification/composition.md), including the findings,
   spans and unjudged unions;
5. never silently drops an event it accepted.

## Self-certification

Conformance is currently self-declared. State the version you target and the
role you implement, e.g.:

```
OpenGuardrails v0.8 — detector + integration conformant
```

Validate against the schemas in `schema/` as part of your test suite. The
runnable minimal integration lives at
[`examples/minimal-agent/`](examples/minimal-agent/).
