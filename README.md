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

Early, and honest about it. Tested end to end against the real harnesses, with the scripted models
in [`cli/experiments`](cli/experiments):

| Agent | Rules and model enforced | Agent told why | Secrets kept from the model provider |
|---|---|---|---|
| [Hermes](https://github.com/NousResearch/hermes-agent) 0.20 | yes | yes | **no**: the side request that names a session goes out unmasked |
| [OpenClaw](https://github.com/openclaw/openclaw) 2026.6 | yes | yes | **no**: this version's model traffic misses the plugin's interceptor |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 0.2 | **no**: the plugin no longer loads on this version | no | no |

Not available yet:

- **The model API is not live.** Without it, what the rules cannot decide is reported as not judged
  and left to the agent's own permission check. The contract is in
  [`specification/model-api.md`](specification/model-api.md).
- **The package is not on npm yet.** Install from a checkout, below.
- Asking you on your phone. Until then, a decision that is yours comes back to you through the agent.

## Try it

Needs Node 22.12 or newer.

```sh
git clone https://github.com/openguardrails/openguardrails
cd openguardrails/cli && npm install && npm run build && npm link
openguardrails serve   # port 4180; set gateway.port in the config to change it
```

Then point an agent's plugin at it.

**Hermes:**

```sh
mkdir -p ~/.hermes/plugins
ln -sfn "$PWD/../integrations/agent/hermes/src/openguardrails_instrumentation_hermes" ~/.hermes/plugins/ogr-guard
hermes plugins enable ogr-guard
export OGR_RUNTIME_URL=http://127.0.0.1:4180 OGR_API_KEY=local
```

**OpenClaw:**

```sh
(cd ../integrations/agent/openclaw && npm install && npm run build)
openclaw plugins install -l ../integrations/agent/openclaw
export OGR_RUNTIME_URL=http://127.0.0.1:4180 OGR_API_KEY=local
```

The same setting pointed at an OpenGuardrails AIRS deployment makes it an enterprise agent, with no
other change.

`openguardrails run -- <command>` and the gateway are described in [`cli/README.md`](cli/README.md).

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
