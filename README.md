<div align="center">

# OpenGuardrails

**AI agent guardrails for every builder.**

Let your agents do more, and walk away. Open source, and it runs on your machine.

Apache-2.0 · [openguardrails.com](https://openguardrails.com)

</div>

---

Most of what an agent does is safe, and a rule can tell. OpenGuardrails decides those actions on
your machine, with no network and no model. It sends only the ones a rule cannot decide to a model
built to judge agent actions, so you stop being asked, and it tells you when something is wrong.

```text
tool call -> local rules --- allow ------------------------------> runs
                         |-- deny ---------------------------------> refused
                         `-- cannot tell -> OpenGuardrails model
                                             |-- allow ------------> runs
                                             |-- unsafe -----------> refused, the agent is told why
                                             `-- your decision ----> the agent asks you
```

Unsafe and "your decision" are different things. A key on its way to an unknown host is a security
problem, and it is refused. Nobody is asked to rule on it. Buying this lipstick is safe, and it is
still your call.

- **Your keys stay home.** Secrets become placeholders before a request leaves your machine, side
  requests included, so the model provider and any relay never see them. A tool still gets the real
  value, and only after its call is allowed.
- **Local rules.** A strict shell parser, a read-only allowlist, workspace boundaries and a small
  list of things no agent should ever do. A command the parser does not fully understand is never
  allowed by a rule. Read them: [`cli/src/gate/gate.ts`](cli/src/gate/gate.ts),
  [`cli/src/decide.ts`](cli/src/decide.ts).
- **A refusal does not end the task.** The agent is told what was refused and what it may do
  instead, then carries on.
- **Sandbox and firewall.** `openguardrails run` starts an agent where it cannot read your
  credentials and every connection is recorded. It also reports hosts the agent reached but no tool
  call named.
- **You can see everything.** `openguardrails decisions` lists every decision, and
  `~/.openguardrails/model-requests.ndjson` holds exactly what was sent to the model.

## Status

Early, and honest about it. Tested end to end against the real harnesses through the local gateway,
with no plugin, using the scripted models in [`cli/experiments`](cli/experiments):

| Agent | Rules and model enforced | Agent told why | Secrets kept from the model provider | Tool gets the real value |
|---|---|---|---|---|
| [Hermes](https://github.com/NousResearch/hermes-agent) 0.20 | yes | yes | yes | yes |
| [OpenClaw](https://github.com/openclaw/openclaw) 2026.6 | yes | yes | yes | yes |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 0.2 | yes | yes | yes | yes |

Not available yet:

- **The model API is not public yet.** It has been tested with the real model through all three agents, but
  is not deployed. Until then, what the rules cannot decide is reported as not judged and left to the
  agent's own permission check. The contract is in [`specification/model-api.md`](specification/model-api.md).
- **The package is not on npm yet.** Install from a checkout, below.
- Asking you on your phone. Until then, a decision that is yours comes back to you through the agent.

Known limits are listed in [`cli/README.md`](cli/README.md#what-it-does-not-do-yet).

## Try it

Needs Node 22.12 or newer.

```sh
git clone https://github.com/openguardrails/openguardrails
cd openguardrails/cli && npm install && npm run build && npm link
```

Tell it about your model API in `~/.openguardrails/config.json`, mode 0600:

```json
{
  "gateway": {
    "upstreams": { "main": { "baseURL": "https://openrouter.ai/api/v1", "model": "qwen/qwen3.8-27b", "apiKeyEnv": "OPENROUTER_API_KEY" } },
    "routes": { "auto": ["main"] }
  }
}
```

```sh
openguardrails serve   # port 4180; set gateway.port in the config to change it
```

Then point your agent at `http://127.0.0.1:4180/v1`, with model `auto` and any string as its API key.
That is the whole integration, and it works the same for every agent.

`openguardrails connect` turns on the model once it is public, and shows where to raise your quota.
`openguardrails decisions` shows what happened. For an enterprise deployment, plugins and the gateway
connect to OpenGuardrails AIRS instead, with no other change.

## What is in this repository

| Path | What it is |
|---|---|
| [`cli/`](cli/) | The `openguardrails` command: rules, local service, sandbox, firewall, gateway |
| [`integrations/`](integrations/) | Plugins for agents and gateways |
| [`benchmarks/`](benchmarks/) | The public evaluation. We enter too, and publish the results either way |
| [`specification/`](specification/README.md) | The OGR wire protocol that the plugins speak |

## For companies

OpenGuardrails AIRS is the enterprise product: organization-wide policy, audit, SSO, analytics and
private deployment. It uses the same plugins and the same models. See
[openguardrails.com](https://openguardrails.com).

## License

Apache-2.0.
