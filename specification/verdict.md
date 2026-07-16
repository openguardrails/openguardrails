# Verdict

A `Verdict` is a detector's decision about a `GuardEvent`. A runtime collects one
verdict per detector and [composes](composition.md) them into a single
**effective verdict** that the interception point enforces. Keywords per RFC 2119.

## Fields

| Field | Type | Req | Description |
|---|---|---|---|
| `ogr_version` | string | MUST | Spec version. |
| `event_id` | string | MUST | The `GuardEvent` being judged. |
| `guard_id` | string | MUST | Copied from the event. |
| `provider` | string | MUST | Detector identity (for attribution / metering / benchmark). |
| `decision` | enum | MUST | See **Decisions**. |
| `categories` | array | SHOULD | Matched risk categories with scores. |
| `modifications` | object | MAY | Required only when `decision` is `modify` or `redact`. |
| `reasons` | array<string> | SHOULD | Human-readable justification. |
| `evidence` | array<object> | MAY | Structured pointers (spans, matched rule ids, fetched-artifact hashes). |
| `findings` | array | SHOULD (span detectors) | Normalized detection results — *what was found*, as opposed to `decision`/`modifications` (*what to do*). |
| `latency_ms` | number | MAY | Detector self-reported latency. |
| `confidence` | number | MAY | `0.0`–`1.0`. |

## Decisions

| `decision` | Meaning | Typical domain |
|---|---|---|
| `allow` | No action. | both |
| `block` | Deny the action entirely. | both |
| `require_approval` | Suspend; a human must approve before proceeding. | security |
| `modify` | Proceed with a transformed payload (e.g. constrained argv). | both |
| `redact` | Proceed with sensitive spans removed. | safety |

A detector that does not handle an event's `kind`, or finds nothing, MUST return
`allow` (an explicit abstention), never silence.

How a `require_approval` decision is satisfied downstream — the approval flow,
the runtime-signed receipt that records the grant, and how enforcement points
verify it — is specified in
[Enrollment & approval receipts](enrollment-and-receipts.md).

### `categories` entry

```json
{ "id": "security.prompt_injection", "domain": "security", "score": 0.93 }
```

`id` MUST be drawn from the [taxonomy](taxonomy.md). `domain` MUST be `safety`
or `security`.

### `findings` entry

```json
{ "category": "safety.pii.national_id.cn", "path": "payload.text",
  "start": 7, "end": 25, "score": 0.95, "detector": "ogr.patterns" }
```

- A finding is *what a detector found*; `decision` and `modifications`
  remain *what to do about it*. Event-level findings (e.g. a malicious
  command) omit `path`/`start`/`end`.
- Findings MUST NOT echo the matched text — offsets only. Otherwise every
  verdict store becomes a copy of the sensitive data it was meant to guard.
- All offsets refer to the payload **as transported** (after any
  [local redaction](local-redaction.md)), never to a form the receiver has
  not seen.
- When `decision` is `redact`, `modifications.spans` SHOULD be derivable
  from the span-bearing findings (same `path`/offsets).
- `categories` remains the rollup (with max scores) of findings and is the
  field [composition](composition.md) operates on.

### `modifications`

```json
{
  "kind": "redact",
  "spans": [ { "path": "payload.text", "start": 40, "end": 76,
               "operator": "encrypt", "ref": "r-8f2e",
               "replacement": "[PII:safety.pii.email:r-8f2e]" } ]
}
```

`operator` (`replace` default \| `mask` \| `hash` \| `encrypt`) says how the
span is transformed; `hash` supports stable pseudonyms, `encrypt` supports
restoration. `ref` is an opaque handle, unique within the verdict: a later
event or verdict using the same `ref` refers to the same original value. Key
management and the restore operation are implementation-internal; the
protocol only guarantees `ref` stability. `replacement` carries a
placeholder, never the original.

## Example — an LLM detector blocks an injected install command

```json
{
  "ogr_version": "0.4",
  "event_id": "evt-9f2",
  "guard_id": "ga-1a2b",
  "provider": "ogr.poc.llm_judge",
  "decision": "block",
  "categories": [
    { "id": "security.malicious_command", "domain": "security", "score": 0.91 },
    { "id": "security.prompt_injection",  "domain": "security", "score": 0.88 }
  ],
  "reasons": [
    "argv pipes a remotely fetched script directly into a shell",
    "command originated from untrusted web content (provenance: web/untrusted)",
    "env exposes AWS_SECRET_ACCESS_KEY to the spawned process"
  ],
  "evidence": [ { "type": "provenance_ref", "event_id": "evt-7c1" } ],
  "confidence": 0.9,
  "latency_ms": 120
}
```

The normative JSON Schema is [`schema/verdict.schema.json`](../schema/verdict.schema.json).
