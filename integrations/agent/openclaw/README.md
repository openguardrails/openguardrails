# openguardrails-instrumentation-openclaw

Guard an [OpenClaw](https://github.com/openclaw/openclaw) assistant through an
[OpenGuardrails](https://openguardrails.com) runtime, on **OGR v0.8**. It is
the multi-channel counterpart of
[`@openguardrails/opencode-auto-mode`](../opencode/).

**No OpenClaw core changes, and no SDK.** This is a pure plugin on OpenClaw's
in-process hooks that speaks the Runtime API directly
(`specification/runtime-api.md`): one hand-rolled `POST /v1/evaluate` per
held action plus an optional heartbeat. It is *restrict-only*: it can stop a
would-run tool call or a would-send message, never loosen one.

## The vantage, honestly

The v0.8 recipe pairs two events per **model call**: `step/request` holding
the raw provider request, `step/response` holding the raw response.
OpenClaw's plugin hooks expose **tool calls and channel messages, not the
model byte path** — this plugin never holds a provider body, so it cannot
implement that pairing. What it does hold, at the host's two refusable
moments, is model-produced output about to be acted on; each becomes a
single **canonical `step/response`** (`llm_protocol: "canonical"`) carrying
exactly what is in hand, with a fresh `step_id` per event and no request
half. Consequences, stated plainly:

- the model's prompt-side and reasoning are never judged — only its tool
  calls (one per event, as the host surfaces them) and its outbound channel
  messages;
- the runtime derives session/turn/step from much less context than a
  loop-owning integration (like [`@openguardrails/dsh`](../dsh/)) provides;
- no `timing` is sent — this vantage observes no byte path, and fabricating
  wall-clock facts would be worse than omitting them;
- redaction spans on a verdict cannot be applied yet (same stance as the dsh
  reference): the plugin warns once and the content proceeds unredacted —
  the runtime's own record is masked either way.

## What it enforces

| Hook | `allow` | `block` | no verdict (outage, timeout, 429) |
| --- | --- | --- | --- |
| **`before_tool_call`** | proceed | `{ block }` — the tool never runs | `failMode`: `open` proceeds loudly, `closed` blocks |
| **`message_sending`** (outbound) | deliver | `{ cancel }` — the reply never leaves | `open` delivers loudly, `closed` cancels |

Fail-open is the default (`specification/degraded-mode.md`): guardrails earn
the right to stop production traffic through explicit configuration, never
as a side effect of a network blip. A deployment gating dangerous actions
sets `failMode: "closed"` and accepts that an outage pauses the assistant.

## Install

```bash
openclaw plugins install openguardrails-instrumentation-openclaw
```

## Configure

In your OpenClaw config under `plugins.entries.openguardrails.config`; every
field falls back to the environment (`OGR_RUNTIME_URL`, `OGR_API_KEY`,
`OGR_AGENT_ID`, `OGR_AGENT_WORKSPACE`, `OGR_AGENT_USER`),
then to `""` — the explicit "no assertion", which the runtime resolves from
the API key. Only the API key is required; without one the plugin runs
unguarded and says so once.

```json
{
  "plugins": {
    "entries": {
      "openguardrails": {
        "config": {
          "runtime": {
            "url": "https://openguardrails.com",
            "apiKey": "ogr_...",
            "agentId": "invoice-bot",
            "agentType": "openclaw",
            "workspace": "finance-agents",
            "owner": "payments-team",
            "user": "u-8232"
          },
          "failMode": "open",
          "timeoutMs": 5000,
          "guardMessages": true
        }
      }
    }
  }
}
```

An unasserted `agentId` falls back to the agent id the host supplies on each
hook (a fact, not an invention), then to `""`. While a runtime is connected,
a heartbeat (`integration: "ogr-openclaw/<version>"`, plus
`events_sent`/`evaluate_errors` counters) goes out immediately and every
60 s — how the runtime tells "assistant idle" from "integration went dark",
and where the build id lives in v0.8.

## Test

Offline, against a strict in-process mock runtime that rejects anything but
the exact ten-field v0.8 GuardEvent:

```bash
npm install && npm test     # standalone — no workspace, no network in the tests
```

## Status

`v0.3` — the v0.8 rewrite. The v0.2 local policy engine
(`@openguardrails/core`, regex rules, bring-your-own-model judge, the taint
tracker, `require_approval`, the enrolled Ed25519 reporter and
`<workspace>/openguardrails.json`) is gone with the SDK layer; policy now
lives in the runtime, where you configure it once for every integration.
The plugin no longer imports the `openclaw` package — it exports the same
plain `{id, name, description, register}` entry `definePluginEntry` used to
brand, so it builds and tests standalone.

## License

Apache-2.0
