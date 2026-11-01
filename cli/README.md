# openguardrails

The command behind [OpenGuardrails](../README.md).

```text
openguardrails serve                    the local service: OGR Runtime API, and the model gateway if configured
openguardrails status                   check the service, every upstream, the model API and AIRS; exit 1 on a problem
openguardrails decisions                what the rules and the model decided, with no arguments or message text
openguardrails run -- <command...>      run a command and everything it spawns inside the sandbox
openguardrails log [run-id]             what a sandboxed run did
openguardrails stop                     stop the local service
```

Configuration is `~/.openguardrails/config.json`, mode 0600. Every part is optional:

```json
{
  "workspaces": ["/Users/me/work"],
  "model": { "apiKeyEnv": "OPENGUARDRAILS_API_KEY" },
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

## What it does not do yet

- A rule reads one action. The model sees the whole session, but only for the actions that reach it.
- With no model key, what the rules cannot decide proceeds unjudged, subject to the agent's own
  permission check. It is logged as `unjudged`.
- Secrets in what is sent to the model API are masked here. Secrets in what your agent sends to its own
  model provider are masked only by each plugin, with the gaps listed in the [status table](../README.md#status).
- If a plugin fails to load, the agent may run with no guard and little warning. DeepSeek Harness
  prints one line and carries on. `openguardrails decisions` staying empty is the sign.
- `openguardrails run` hides this tool's own configuration from the sandbox, so a plugin inside it
  cannot read a key from there. Pass the local service's address to the plugin instead.

## Sandbox and gateway

`openguardrails run` uses [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropics/sandbox-runtime):
Seatbelt on macOS, bubblewrap and seccomp on Linux. It is a beta, so the version is pinned, and its
stated limits apply. macOS also needs `ripgrep`. Linux needs `bubblewrap`, `socat` and `ripgrep`.
Windows is untested.

The gateway is one local base URL in front of many model APIs, with failover, for OpenAI Chat, OpenAI
Responses and Anthropic Messages. It does not translate protocols, so the members of a route must
speak the protocol their client speaks.

## Experiments

```sh
npm run build
experiments/run.sh <hermes|openclaw|dsh> <empty-lab-dir> [judge|nomodel]
```

Runs the real harness with its plugin, in a throwaway home, against a scripted model and a scripted
model API. Files in the work directory prove what really ran. The harness must already be installed.

The secret rules in `rules/secrets.json` are a snapshot of what OpenGuardrails AIRS serves. Every rule
carries examples, and the tests fail if one stops passing them. Examples shaped like a real issuer's key
are left out of this public file and assembled in the tests instead.
