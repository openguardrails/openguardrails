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

### `categories` entry

```json
{ "id": "security.prompt_injection", "domain": "security", "score": 0.93 }
```

`id` MUST be drawn from the [taxonomy](taxonomy.md). `domain` MUST be `safety`
or `security`.

### `modifications`

```json
{
  "kind": "redact",
  "spans": [ { "path": "payload.text", "start": 40, "end": 76, "replacement": "[REDACTED:pii.email]" } ]
}
```

## Example — an LLM detector blocks an injected install command

```json
{
  "ogr_version": "0.1",
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
