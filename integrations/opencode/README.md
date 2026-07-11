# openguardrails-instrumentation-opencode

Guard an [opencode](https://github.com/anomalyco/opencode) agent's tool calls
through the [OpenGuardrails (OGR)](https://www.npmjs.com/package/@openguardrails/core)
protocol — the TS counterpart of `openguardrails-instrumentation-hermes`.

The agent configures **its own guardrails**: plain **text + regex** rules (no
model required), and optionally **its own model** as an LLM judge. Enforced as a
pure opencode plugin — **no core changes, no fork**.

```bash
npm install openguardrails-instrumentation-opencode
```

## How it works

opencode fires `tool.execute.before` for every tool, before it runs. This plugin
turns the call into an OGR `GuardEvent`, runs it through a `Runtime` built from
your policy, and enforces the `Verdict`:

| OGR decision | opencode behavior |
| --- | --- |
| `allow` / `modify` / `redact` | proceed |
| `block` | throw → the agent sees a tool error and must find a safer path |
| `require_approval` | throw → asks you to re-run intentionally or relax the policy |

It is a **restrict-only** guard: it can stop a would-run tool call, never loosen
one. (opencode's own `permission` rules still apply first.)

## Enable

In your opencode config:

```jsonc
{
  "plugin": ["openguardrails-instrumentation-opencode"]
}
```

## Configure your guardrails

Drop an OGR policy at **`.opencode/guardrails.json`** (the agent can write/edit
this itself), or pass it inline as plugin options. A sensible default ships in
the package (`curl|bash`, `rm -rf /`, credential-file access, `| sudo`).

```json
{
  "composition": { "security.*": { "strategy": "deny-wins", "on_all_failed": "block" } },
  "config_rules": {
    "command_rules": [
      { "id": "no-prod-deploy", "regex": "deploy\\s+--env\\s+prod",
        "category": "security.malicious_command", "decision": "require_approval",
        "score": 0.9, "why": "production deploys need explicit human approval" }
    ]
  }
}
```

### Use your own model as the judge

```json
{
  "config_rules": { "command_rules": [] },
  "judge": { "baseURL": "https://api.openai.com/v1", "model": "gpt-4o-mini", "apiKey": "sk-..." }
}
```

Any OpenAI-compatible chat endpoint works — point it at the same model your agent
uses, or a dedicated guard model. The judge weighs provenance and returns an OGR
verdict; the deterministic text/regex rules remain the baseline.

## Status

`v0.1`. Pure plugin via `tool.execute.before`. A first-class "ask the human"
(`require_approval` as an interactive prompt) and transcript-based provenance
tainting are tracked follow-ups; today `require_approval` is enforced as a
deny-with-guidance.
