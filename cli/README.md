# openguardrails

The command behind [OpenGuardrails](../README.md).

```text
openguardrails serve                    the local service: OGR Runtime API, and the model gateway if configured
openguardrails status                   check the service, every upstream, the model API and AIRS; exit 1 on a problem
openguardrails connect                  turn on the model: get a free key, and show where to claim more
openguardrails decisions                what the rules and the model decided, with no arguments or message text
openguardrails run -- <command...>      run a command and everything it spawns inside the sandbox
openguardrails log [run-id]             what a sandboxed run did
openguardrails stop                     stop the local service
```

Configuration is `~/.openguardrails/config.json`, mode 0600. Every part is optional:

```json
{
  "workspaces": ["/Users/me/work"],
  "model": { "apiKeyEnv": "OPENGUARDRAILS_API_KEY", "failMode": "closed" },
  "gateway": {
    "upstreams": { "primary": { "baseURL": "http://10.0.0.5:8000/v1", "model": "dsv41-flash", "apiKey": "local-no-auth" } },
    "routes": { "auto": ["primary"] }
  },
  "sandbox": { "allowHosts": ["10.0.0.5:8888"] }
}
```

- `workspaces` are the absolute directories an agent works in. A relative path is taken as inside
  one. An absolute path outside them goes to the model. The Runtime API does not tell this service an
  agent's working directory, so nothing else can draw this line yet.
- The local service listens on loopback and takes any API key.

## What the rules decide

| Answer | Examples |
|---|---|
| allow | `git status`, `grep -rn TODO src`, reading or changing a file in the workspace, the agent's own bookkeeping |
| deny | `rm -rf /`, formatting a disk, reading `~/.ssh/id_rsa` or `~/.aws/credentials`, cloud metadata endpoints, changing this tool's own configuration |
| the model decides | everything else: network, installs, `git push`, deleting, scripts, `.env`, `.git/hooks`, `package.json`, any tool the rules do not know |

Nothing that leaves the machine is ever allowed by a rule.

## Two ways to connect

**The gateway, recommended.** Point the agent's base URL at `http://127.0.0.1:4180/v1`. Every request
passes through it, whichever harness sent it. It holds your provider keys, masks secrets on the way
out and judges tool calls on the way back. With AIRS configured, AIRS does the masking and judging.

**A plugin**, from `integrations/agent/`, with `OGR_RUNTIME_URL=http://127.0.0.1:4180`. A refused call
reaches the agent as a failed tool call, so it carries on by itself. But a plugin sees only what its
harness shows it. Tested: on Hermes the request that names a session goes out unmasked, on OpenClaw
2026.6 no model traffic reaches the plugin's interceptor, and the DeepSeek Harness plugin does not load
on 0.2.0-rc.2. A plugin that fails to load can leave the agent running with no guard and one line of
warning.

## What it does not do yet

- **A refused step can end the agent's turn.** Through the gateway, a refused call is removed from the
  reply and the reason added to its text. If no call survives, the turn ends with that reason, for
  the person to read. It does not end the session. If another call survives, the task goes on.
- A rule reads one action. The model sees the whole session, but only for the actions that reach it.
- With no model connected, what the rules cannot decide proceeds unjudged, subject to the agent's own
  permission check. It is logged as `unjudged`. The same goes for a used-up quota, and the person is told
  once a day.
- Once connected, a model that cannot answer means the action is refused, and the agent is told it may
  retry. Set `"failMode": "open"` under `model` to let such actions through instead.
- **Placeholders do not survive a restart of the service.** A model that reuses one from before gets
  that call refused, with an explanation, and no tool sees the placeholder.
- A secret the rules do not recognize is not masked. Prose in a reply keeps its placeholders, on
  purpose: only a tool gets the real value.
- The gateway sees what is sent to it. An agent or a tool that calls a provider directly goes around it.
  `openguardrails run` forces the network through this machine's proxy and records that traffic.
- Only OpenAI Chat is tested against real harnesses. Anthropic Messages streaming is tested against a
  stand-in. On OpenAI Responses a refusal in a stream retracts the whole step.
- `openguardrails run` hides this tool's own configuration from the sandbox, so a plugin inside it
  cannot read a key from there. Pass the local service's address to the plugin instead.

## Sandbox and gateway

`openguardrails run` uses [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropics/sandbox-runtime):
Seatbelt on macOS, bubblewrap and seccomp on Linux. It is a beta, so the version is pinned, and its
stated limits apply. macOS also needs `ripgrep`. Linux needs `bubblewrap`, `socat` and `ripgrep`.
Windows is untested.

The gateway also fails over between model APIs, for OpenAI Chat, OpenAI
Responses and Anthropic Messages. It does not translate protocols, so the members of a route must
speak the protocol their client speaks.

## Experiments

```sh
npm run build
experiments/run.sh <hermes|openclaw|dsh> <empty-lab-dir> [gateway|live|judge|nomodel]
```

Runs the real harness in a throwaway home, against a scripted model and a scripted model API: through
the gateway with `gateway`, through the gateway and a real Model API at `$MODEL_API_URL` with `live`, or
with its plugin otherwise. Files in the work directory prove what really ran. The harness must already be installed.

The secret rules in `rules/secrets.json` are a snapshot of what OpenGuardrails AIRS serves. Every rule
carries examples, and the tests fail if one stops passing them. Examples shaped like a real issuer's key
are left out of this public file and assembled in the tests instead.
