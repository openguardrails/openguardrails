# openguardrails

The command behind [OpenGuardrails](../README.md).

```text
openguardrails serve                    the local service: OGR Runtime API, and the model gateway if configured
openguardrails status                   check the service, every upstream, the model API and AIRS; exit 1 on a problem
openguardrails connect                  turn on the model: get a free key, and show where to claim more
openguardrails decisions                what the rules and the model decided, with no arguments or message text
openguardrails scan [--json]            the agents on this machine, what they load, and what to fix
openguardrails attach <agent...|--all>  send an agent's model calls through the gateway (--dry-run to preview)
openguardrails detach <agent...|--all>  put an agent's old base URLs back
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
- The local service listens on loopback and takes any API key. Avoid port 4190: `fetch` refuses it, so every
  agent built on Node would fail to connect while `curl` works.

## What the rules decide

| Answer | Examples |
|---|---|
| allow | `git status`, `grep -rn TODO src`, reading or changing a file in the workspace, the agent's own bookkeeping |
| deny | `rm -rf /`, formatting a disk, reading `~/.ssh/id_rsa` or `~/.aws/credentials`, cloud metadata endpoints, changing this tool's own configuration |
| the model decides | everything else: network, installs, `git push`, deleting, scripts, `.env`, `.git/hooks`, `package.json`, any tool the rules do not know |

Nothing that leaves the machine is ever allowed by a rule.

## Connecting

Point the agent's base URL at `http://127.0.0.1:4180/v1`. Every request
passes through it, whichever harness sent it. It holds your provider keys, masks secrets on the way
out and judges tool calls on the way back. With AIRS configured, AIRS does the masking and judging.

There are no agent plugins any more. A plugin sees only what its harness shows it. Tested: on Hermes
the request that names a session went out unmasked, on OpenClaw 2026.6 no model traffic reached the
plugin's interceptor, and the DeepSeek Harness plugin did not load on 0.2.0-rc.2. A plugin that fails
to load can leave the agent running with no guard and one line of warning.

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
- `openguardrails run` hides this tool's own configuration from the sandbox, so nothing inside it can
  read a key from there.

## Scan

`openguardrails scan` lists every agent it finds on the machine. It changes nothing and sends nothing.

| Agents | |
|---|---|
| OpenClaw and Hermes (personal), OpenCode, Codex and DeepSeek Harness (open source coding) | OpenGuardrails protects these |
| Claude Code, Gemini CLI, Cursor, Claude Desktop, VS Code, Windsurf | Listed only. Claude Code's own permissions are strong; the others are apps whose model settings are not a file to rewrite |

For each agent it lists:

- where its model calls go, and whether they pass through the local gateway;
- the MCP servers it starts or connects to, with the package each one runs and whether that package
  is pinned to an exact version;
- its skills and plugins, each with a sha256 of what is on disk.

It reports three findings: a protected agent that calls its model directly, a secret written in plain
text in any agent's config (where it is, never its value), and an MCP server that fetches an unpinned
package.
`--json` prints the whole inventory.

## Attach

`openguardrails attach hermes` (or `--all`) points an agent's model calls at the local gateway. Only
the base URL changes: `https://api.example.com/v1` becomes `http://127.0.0.1:4180/u/api.example.com/v1`,
and the gateway sends each call on to `https://api.example.com/v1` with the agent's own path, model and
key. The key stays where the agent keeps it. The config file is edited value by value, so comments and
formatting survive, and a copy is kept in `~/.openguardrails/backups` first. Restart the agent afterwards.
`openguardrails detach` puts the old URLs back.

It attaches OpenClaw, Hermes, OpenCode, Codex and DeepSeek Harness. It skips a provider the agent
builds in, with no base URL in its config, and says so.

## Sandbox and gateway

`openguardrails run` uses [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropics/sandbox-runtime):
Seatbelt on macOS, bubblewrap and seccomp on Linux. It is a beta, so the version is pinned, and its
stated limits apply. macOS also needs `ripgrep`. Linux needs `bubblewrap`, `socat` and `ripgrep`.
Windows is untested.

A command that serves a web UI, such as `dsh --profile web`, needs `--expose <port>` on Linux: the
sandbox has its own network, so its server is otherwise out of this machine's sight. The port is then
reachable at `127.0.0.1:<port>` here, and nowhere else. The sandbox ends with the run, even when the
run is killed.

On a machine that reaches the internet through a proxy of its own (a corporate proxy, or v2rayA),
give it as `--upstream-proxy http://127.0.0.1:20171`, or `sandbox.upstreamProxy` in the config. It
defaults to `HTTPS_PROXY`. The command then reaches the internet only through this tool, and this
tool through that proxy:

- Every destination is written down per connection, with the bytes each way, and allowed or refused
  as usual. HTTPS on this route is not decrypted, because sandbox-runtime does not send a decrypted
  connection on to a parent proxy.
- On Linux, a command that names the proxy itself (`yt-dlp --proxy http://127.0.0.1:20171`) reaches
  this tool on that port inside the sandbox, so it needs no change. On macOS the real proxy is
  refused, and the command must use the proxy it is given in `HTTPS_PROXY`.
- Any other proxy on the machine is out of reach, and `--allow-host` for the upstream proxy itself
  is refused, because a tunnel through it would be one host to this tool.

The gateway also fails over between model APIs, for OpenAI Chat, OpenAI
Responses and Anthropic Messages. It does not translate protocols, so the members of a route must
speak the protocol their client speaks.

## Rules about your own work

A rule can tell you when your agent gets stuck. Stuck means busy without progress: the command keeps
using CPU, the network or the model, or keeps waiting on a model request or a connection, yet nothing
new appears where its output goes. A command that finished and sits idle is not stuck.

```json
{
  "watches": [{
    "name": "translating or publishing gets stuck",
    "command": "voicego",
    "progress": ["/data/voicego/episodes", "/data/voicego/inbox"],
    "idleMinutes": 30,
    "notify": ["email"]
  }],
  "notify": {
    "email": {
      "to": "you@example.com",
      "smtp": { "host": "smtp.example.com", "port": 465, "user": "you@example.com", "passwordEnv": "SMTP_PASSWORD" }
    }
  }
}
```

`openguardrails run` checks each rule whose `command` is in its command line. It sends one message
when the command gets stuck and one when new output appears. `openguardrails notify test` sends a
test message. The password is kept from the sandbox like every other key.

## Experiments

```sh
npm run build
experiments/run.sh <hermes|openclaw|dsh|opencode> <empty-lab-dir> [gateway|attach|live]
```

Runs the real harness in a throwaway home, against a scripted model and a scripted model API: through
the gateway with `gateway`; configured to call the model directly and then put behind the gateway by
`openguardrails attach` with `attach`; and through the gateway and a real Model API at `$MODEL_API_URL`
with `live`. Files in the work directory prove what really ran. The harness must already be installed.

The secret rules in `rules/secrets.json` are a snapshot of what OpenGuardrails AIRS serves. Every rule
carries examples, and the tests fail if one stops passing them. Examples shaped like a real issuer's key
are left out of this public file and assembled in the tests instead.
