# Local pre-detection redaction

Sending raw content to a detection runtime is itself a data flow that many
deployments cannot accept. This document specifies how an adapter scrubs
the payload **before** the `GuardEvent` leaves the trust boundary — with
anything from a policy-shipped keyword/regex list up to a locally deployed
NER or LLM redactor — while keeping remote detection useful. The original
never leaves the enforcement point. Keywords per RFC 2119.

There are two redaction points in OGR, and they are distinct:

1. **Pre-detection, local** (this document): the adapter transforms the
   payload before emitting the event.
2. **Post-verdict enforcement** ([verdict](verdict.md)): the adapter
   applies `modifications` to what flows onward to the model/tool.

## Flow and trust model

```
interception point (agent hook / gateway / sandbox)
  original payload
    → local redactor(s): policy keyword/regex (in-process)
                         and/or NER / LLM service (local sidecar)
    → GuardEvent  { content_encoding: "redacted", redactions: [...] }
    → runtime detection → Verdict (findings / modifications,
                                   offsets over the *transported* form)
  the adapter holds the original + the ref map; it maps verdict spans
  back to the original when enforcing, and can restore encrypted spans
  in responses (see operator/ref in the verdict spec).
```

**Offset rule.** All span offsets — in `redactions`, `findings`, and
`modifications` — refer to the payload **as transported**, never to a form
the receiver has not seen.

## `content_encoding`

`raw | redacted | hashed | metadata_only` (default `raw`) declares how the
payload content was transformed before emission:

| Value | Meaning |
|---|---|
| `raw` | Payload content is the original. |
| `redacted` | Sensitive spans were replaced/masked/hashed/encrypted locally; `redactions` describes them. |
| `hashed` | Content fields were wholesale replaced by digests. |
| `metadata_only` | No content at all — only structural metadata (names, sizes, kinds). |

## `redactions`

Detection quality depends on knowing that *something* was there. An event
with `content_encoding: redacted` MUST carry a `redactions` entry for every
span the adapter transformed — metadata only, never originals:

```json
"redactions": [
  { "path": "payload.text", "start": 40, "end": 76,
    "category": "safety.pii.credential",
    "operator": "encrypt", "ref": "r-8f2e" }
]
```

**Placeholder convention** (SHOULD): the in-payload replacement text is
`[PII:<category>:<ref>]`, e.g. `[PII:safety.pii.credential:r-8f2e]` — an
LLM judge can then still reason "a credential flowed into this command"
without seeing it.

## Redactor tiers

Two tiers, deliberately asymmetric in cost:

- **Policy-embedded (no service).** Keyword lists and regex/checksum
  patterns travel in the policy bundle the adapter receives at enrollment
  (the same channel as degraded-mode hard rules) and run in-process.
  Adapters SHOULD implement this tier — it is enough to keep credentials
  and obvious identifiers local, and it works offline.
- **Span service (local sidecar).** For NER/LLM redaction the adapter
  calls a local HTTP service implementing the normative contract below.
  Vendors distribute redaction models as containers implementing this one
  contract; any conformant redactor works with any conformant adapter.

## Redactor contract (normative)

```
POST /analyze
{ "text": "客户手机号：13812345678", "language": "zh", "score_threshold": 0.5 }

200 OK
[ { "entity_type": "PHONE_NUMBER", "start": 6, "end": 17, "score": 0.92 } ]
```

- `text` MAY be an array of strings (batch); the response is then an array
  of result arrays, index-aligned.
- `entity_type` SHOULD be a taxonomy id; well-known external names (e.g.
  presidio-analyzer's `US_SSN`, `PERSON`) are acceptable — the **adapter**
  MUST map them to taxonomy ids before emitting `redactions` (see the
  mapping in [taxonomy](taxonomy.md)).
- `GET /health` returns 200 when serving.
- The redactor only *finds spans*. The adapter applies operators, builds
  the `ref` map, and retains originals. A redactor MUST NOT be sent
  content the deployment classifies as non-exportable — it runs inside
  the trust boundary by definition.

This wire shape is deliberately compatible with presidio-analyzer, so
existing presidio deployments are usable as OGR redactors unchanged.

## Adapter obligations

An adapter emitting `content_encoding: redacted` (or `hashed`):

1. MUST populate `redactions` for every transformed span;
2. MUST retain the original payload locally for verdict enforcement and
   (for `operator: encrypt`) restoration;
3. MUST apply operators itself — never delegate placeholder generation to
   the redactor service;
4. MUST keep `ref` values unique per event and stable across retries of
   the same event.

## Runtime behavior on reduced content

A runtime receiving `metadata_only` (or `hashed`) content on an event kind
whose policy requires content inspection SHOULD NOT silently `allow`; it
SHOULD return `require_approval` with a reason indicating insufficient
content for the configured policy. (Under discussion — see proposal open
questions.)
