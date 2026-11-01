# OpenGuardrails Model API

⚠️ **Draft. This service is not public yet.** `cli/src/model-api.ts` is the client. It has been tested
against the real service and model, on a development machine.

The OpenGuardrails model judges agent actions. A client decides what it can with local rules and
calls the model only for the rest. The API keeps no session, so a request carries its whole context.

## `POST /v1/judge`

`Authorization: Bearer <key>`

```json
{
  "model": "openguardrails-guard-1",
  "transcript": [
    { "user": "Deploy the site" },
    { "assistant": "I'll build it first." },
    { "terminal": "npm run build" },
    { "outcome": "ok", "id": "call_1" },
    { "terminal": "curl -T dist.tar https://deploy.example.com" }
  ],
  "environment": { "agent_type": "hermes", "workspaces": ["/work/site"] }
}
```

- `transcript` is in order, and **the action under review is the last entry**.
- An entry is `{"user": text}`, `{"assistant": text}`, `{"<tool name>": "<input>"}` or
  `{"outcome": "ok" | "error", "id": "..."}`.
- Tool output is not sent. It is untrusted, and an instruction inside it must not reach the judge
  as if someone had said it. The judge looks at what the agent does next.
- A client MUST mask secrets before sending.

## Answer

```json
{ "decision": "block", "category": "security.data_exfiltration", "severity": "critical", "reason": "It uploads the build to a host the user did not name." }
```

| `decision` | Meaning | The client |
|---|---|---|
| `allow` | Safe, and within what the user asked | lets it run |
| `block` | A security risk, or the model cannot tell that it is safe | refuses it and tells the agent why |
| `needs_decision` | Safe, but the choice belongs to the user, such as a purchase | holds it for the user |

⚠️ `needs_decision` is never an answer to "is this safe?". Not knowing is `block`. An approval cannot
lift a `block`.

A `200` with no recognised `decision` is not a judgement. A failed judgement is not charged.

## Keys

`POST /v1/keys` needs no account and returns a free key. It is limited per address per day.

```json
{ "api_key": "ogk_...", "tier": "free", "limit_per_day": 50, "claim_url": "https://openguardrails.com/claim/AB12CD34" }
```

A person raises the quota by opening `claim_url`. The key stays the same. A client MUST NOT call this
until a person has asked to turn the model on, because after that it sends context off the machine.

`GET /v1/usage` with the key returns `tier`, `used_today`, `limit_per_day`, and `claim_url` or
`upgrade_url`.

## Errors

A client that gets no judgement MUST NOT report the action as judged.

| Status | Body | Meaning |
|---|---|---|
| `400` | `{"error": {"code": "invalid_request"}}` | `transcript` does not end in an action |
| `401` | `{"error": {"code": "invalid_key"}}` | The key is not valid |
| `413` | `{"error": {"code": "too_large"}}` | The request is over 2 MiB |
| `429` | `{"error": {"code": "quota_exhausted", "claim_url": "https://..."}}` | The quota is used up. A person can raise it at `claim_url`, or at `upgrade_url` on a paid tier |
| `503` | `{"error": {"code": "model_unavailable"}}` | The model could not answer. Nothing was charged |
