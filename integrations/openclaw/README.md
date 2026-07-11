# openguardrails-instrumentation-openclaw

Guard an [OpenClaw](https://github.com/openclaw/openclaw) assistant through the
**OpenGuardrails (OGR)** protocol — a vendor-neutral enforcement layer for AI
agent safety & security. It's the multi-channel counterpart of
[`openguardrails-instrumentation-opencode`](../opencode/).

**No OpenClaw core changes.** This is a pure plugin built on OpenClaw's
in-process [plugin hooks](https://docs.openclaw.ai/plugins/hooks). It is
*restrict-only*: it can stop a would-run tool call or a would-send message,
never loosen one.

## What it does

Each hooked event becomes an OGR `GuardEvent`, runs through a `Runtime` built
from **your own policy** (deterministic text/regex rules, plus optionally your
own model as an LLM judge), and the resulting `Verdict` is enforced:

| Hook | `allow` / `modify` / `redact` | `block` | `require_approval` |
| --- | --- | --- | --- |
| **`before_tool_call`** | proceed | `{ block }` | `{ requireApproval }` — native `/approve` human gate |
| **`message_sending`** (outbound) | deliver | `{ cancel }` | `{ cancel }` |

The human-confirm gate and enforcement stay **privilege-separated**: the plugin
*decides*, the user *approves*, the host *enforces*.

## Install

```bash
openclaw plugins install clawhub:openguardrails
# or, during the npm cutover:
openclaw plugins install openguardrails-instrumentation-openclaw
```

## Configure

The assistant configures its **own** guardrails. Resolution order (low → high):

1. A safe default policy (curl-pipe-to-sh, `rm -rf /`, secret-file reads, …).
2. `<workspace>/openguardrails.json` — an OGR `policy.json` the assistant can
   edit to give itself guardrails. Override the path with `policyPath` or the
   `OPENGUARDRAILS_POLICY` env var.
3. Inline plugin config (highest precedence), in your OpenClaw config:

```json
{
  "plugins": {
    "entries": {
      "openguardrails": {
        "config": {
          "judge": {
            "baseURL": "http://localhost:11434/v1",
            "model": "your-guard-model",
            "apiKey": "..."
          },
          "guardMessages": true
        }
      }
    }
  }
}
```

`judge` points the LLM-judge detector at any OpenAI-compatible chat endpoint —
the same model the assistant already uses, a cheaper sibling, or a dedicated
guard model. The policy format is identical across every OGR integration
(opencode, hermes, python), so one `policy.json` works everywhere.

## Channel-inbound tainting (indirect prompt injection)

Once a session ingests **untrusted content** — an inbound channel message
(`message_received`) or a tool result from a web/fetch/search/browser/MCP tool
(`after_tool_call`) — subsequent tool calls in that session carry `untrusted`
provenance. The OGR judge then escalates a privileged action (e.g. `curl … |
bash`) from `require_approval` to **block** as probable injection, while benign
actions still pass. Taint is session-scoped and cleared on `session_end` /
`before_reset`. A judge is always in the chain (your own model when configured,
else the deterministic `HeuristicBackend`), so this works with no external
model. Tune via config:

```json
{ "taint": { "inboundMessages": true, "toolResults": true,
             "toolResultPattern": "(web|fetch|search|browse|http|url|mcp|mail)" } }
```

## Scope & follow-ups

- Input guardrails on the prompt itself (`before_agent_run`) require the
  operator to set `plugins.entries.openguardrails.hooks.allowConversationAccess`
  — a config flag, not a code change. Not needed for the tool/message
  enforcement above.

## License

Apache-2.0
