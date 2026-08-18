# @openguardrails/opencode-auto-mode

**Auto mode for [opencode](https://github.com/anomalyco/opencode), on OGR
v0.8.** Whatever your opencode `permission` config would ask you — bash
commands, edits, webfetch — this plugin answers from an
[OpenGuardrails](https://openguardrails.com) **runtime verdict** instead of a
human, and every tool call is judged before it runs. Enforced as a pure
opencode plugin — no core changes, no fork, and **no SDK**: the plugin speaks
the Runtime API directly (`specification/runtime-api.md`), one hand-rolled
`POST /v1/evaluate` per held action plus an optional heartbeat.

Installation is one config edit — opencode installs plugins listed in its
config by itself on the next start:

```jsonc
// opencode.json (or the global ~/.config/opencode/opencode.json)
{
  "plugin": ["@openguardrails/opencode-auto-mode"],
  // auto mode answers whatever you tell opencode to ask about:
  "permission": { "bash": "ask", "edit": "ask", "webfetch": "ask" }
}
```

Then connect a runtime: set `OGR_API_KEY` (get one at
https://openguardrails.com). Without a key the plugin runs unguarded and says
so once — connecting a runtime is a deployment choice, not a crash.

## The vantage, honestly

The v0.8 recipe pairs two events per **model call**: `step/request` holding
the raw provider request, `step/response` holding the raw response.
opencode's plugin surface exposes **tool-call hooks, not the model byte
path** — this plugin never holds a provider body, so it cannot implement
that pairing. What it does hold, at the host's two refusable moments, is a
model-produced tool call about to be acted on. Each one becomes a single
**canonical `step/response`** carrying exactly the `tool_calls` in hand
(`llm_protocol: "canonical"`), with a fresh `step_id` per event and no
request half. Consequences, stated plainly:

- the model's prose and reasoning are never judged, only its tool calls —
  and only one call per event, as the host surfaces them;
- the runtime derives session/turn/step from much less context than a
  loop-owning integration (like [`@openguardrails/dsh`](../dsh/)) provides;
- no `timing` is sent — this vantage observes no byte path, and fabricating
  wall-clock facts would be worse than omitting them;
- redaction spans on a verdict cannot be applied yet (same stance as the dsh
  reference): the plugin warns once and the content proceeds unredacted —
  the runtime's own record is masked either way.

## How it works

**`tool.execute.before`** — the held call is judged before it runs:

| Verdict | opencode behavior |
| --- | --- |
| `allow` | proceed (findings, if any, are recorded runtime-side) |
| `block` | throw → the agent sees a tool error and must find a safer path |
| no verdict (outage, timeout, 429) | `failMode`: `open` proceeds loudly, `closed` refuses |

**`permission.ask`** — opencode's own permission prompt, the human gate.
An ask correlated to an already-judged call (same `callID`) is answered from
that verdict — the same action never earns two answers. An uncorrelated ask
is judged from the permission's own metadata (opencode's bash asks carry the
command there). `allow` → `"allow"`, `block` → `"deny"`, nothing to judge →
*undecided*: `auto.unresolved: "human"` (default) leaves the prompt for you,
`"reject"` denies it — the strict stance for headless runs.

Auto mode stays **restrict-only** toward the agent: it automates *your* seat
at the prompt, never overrides a verdict, and a `block` stays blocked
everywhere.

## Configure

Plugin options (opencode passes them through), each falling back to the
environment, then to `""` — the explicit "no assertion", which the runtime
resolves from the API key:

```jsonc
{
  "runtime": {
    "url": "https://openguardrails.com",   // or your own runtime; env OGR_RUNTIME_URL
    "apiKey": "ogr_...",                   // env OGR_API_KEY
    "agentId": "invoice-bot",              // WHICH agent; env OGR_AGENT_ID
    "agentType": "opencode",               // what KIND (the default)
    "workspace": "finance-agents",         // policy group; env OGR_AGENT_WORKSPACE
    "user": "u-8232"                       // who is using it; env OGR_AGENT_USER
  },
  "failMode": "open",                      // "closed" = an outage pauses the agent
  "timeoutMs": 5000,
  "auto": { "enabled": true, "unresolved": "human" }
}
```

While a runtime is connected, a heartbeat
(`integration: "ogr-opencode-auto-mode/<version>"`, plus
`events_sent`/`evaluate_errors` counters) goes out at boot and every 60 s —
that is how the runtime tells "agent idle" from "integration went dark", and
where the build id lives in v0.8.

## Test

Offline, against a strict in-process mock runtime that rejects anything but
the exact ten-field v0.8 GuardEvent:

```bash
npm install && npm test     # standalone — no workspace, no network in the tests
```

## Status

`v0.3` — the v0.8 rewrite. The v0.2 local policy engine
(`@openguardrails/core`, regex rules, bring-your-own-model judge,
`.opencode/guardrails.json`, `require_approval`) is gone with the SDK layer;
policy now lives in the runtime, where you configure it once for every
integration. Published before `v0.2` as
`openguardrails-instrumentation-opencode`.

## License

Apache-2.0
