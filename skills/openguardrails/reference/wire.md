# The v1.0 wire, one page

One endpoint carries every decision: `POST {base}/v1/evaluate`, header
`Authorization: Bearer ogr_<key>`. One model call = one step = two events
sharing a `step_id` you mint. The runtime records what it judges; there is
no separate ingest.

## GuardEvent — eight required fields, three optional

```jsonc
{
  "kind": "step/request",            // or "step/response"
  "step_id": "8c2f1a0e77b04d5b",     // fresh per model call, same on both halves
  "agent_id": "invoice-bot",         // WHICH agent (org-unique); "" = derive from key
  "agent_type": "my-harness",        // what kind — a label, never selects policy
  "agent_workspace": "finance-agents", // agent group = ONE policy set
  "agent_user": "u-8232",            // who drives it this session (attribute)
  "llm_protocol": "openai.chat",     // openai.chat | openai.responses |
                                     //   anthropic.messages | canonical
  "payload": { /* the RAW provider body, untouched */ },
  // optional — send when you hold the fact:
  "integration": "my-plugin/1.0.0",  // who reported this, name/version
  "connection": "i-abc#41",          // your own downstream-flow id (attribution only)
  "session_hint": "sess_9f2c…"       // your own opaque name for this conversation
}
```

- `step/request` = the request body about to go to the model (system prompt
  is already `messages[0]`). `step/response` = the complete response body,
  BEFORE tool calls execute — the enforcement moment that matters most.
- Tool results need no event: they ride in the next `step/request`.
- `canonical` payloads (when no raw body exists):
  request `{messages, tools?}`, response
  `{text?, reasoning?, tool_calls?, model?, usage?, timing?}`.
- `step/response` should carry `timing {started_at, first_token_at?,
  completed_at}`; raw bodies already carry the provider's `usage`.

## Verdict

```jsonc
{
  "event_id": "evt_…",       // runtime-minted; how you reference the event
  "provider": "ogr-runtime",
  "decision": "allow",        // or "block"
  "findings": [{ "category": "security.data_exfiltration",
                 "severity": "critical",
                 "path": "payload.tool_calls.0.arguments.command",
                 "start": 0, "end": 41, "subject": "curl … ${OGR_URL_1}" }],
  "modifications": { "spans": [ /* apply in place BEFORE content proceeds */ ] },
  "unjudged": [ /* paths it could NOT judge — fail-closed treats as block */ ]
}
```

`findings[].path` names WHICH tool call offended — you may refuse just that
call and execute the rest.

## Failure = your configured fail mode

Timeout, 429, 5xx, network: no verdict. Default posture is **open** (proceed,
count the unjudged step); `closed` denies gated actions until the runtime
answers. 429 is an outage, never an allow.

## Streaming: hold the tail, judge once

Stream to the user while withholding the final ~200 chars; at stream end,
evaluate the reassembled whole response once; `allow` releases the tail,
`block` drops it and cuts the stream. Never judge chunk-by-chunk.

## Everything derived

No session ids, turn/step numbers, timestamps, or protocol versions on the
wire — the runtime reconstructs sessions (across context compaction), turns,
and numbering. `step_id` is the one coordinate because concurrency makes
request↔response pairing underivable.

Normative: `specification/runtime-api.md`, `schema/guard-event.schema.json`,
`schema/verdict.schema.json` in the spec repo.
