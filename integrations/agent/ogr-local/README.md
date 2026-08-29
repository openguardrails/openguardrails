# @openguardrails/ogr-local

**Local secrets redaction for harnesses whose plugins run outside the agent's
process — [Claude Code](../claude-code) and [OpenAI Codex](../codex).**

Every credential in the outbound model request is replaced with
`${OGR_SECRET_n}` **on this machine**. The runtime judges the placeholder, the
model provider is given the placeholder, and the real value is put back into
the reply's tool-call arguments — locally — so the tool still runs with a
working credential. Same contract as the in-process masking the other
integrations do ([OGR 1.4](../../../specification/local-redaction.md)), at a
different vantage.

## Do you need this?

**Probably not.** If your harness loads a plugin *inside* the agent's process
— hermes, opencode, openclaw, dsh — that plugin installs an in-process
`fetch` interceptor and this package is not involved. No port, no lifecycle,
no base URL to change, and nothing left running when the harness exits.

Two harnesses cannot do that, and that is the entire reason this exists:

| harness | why the interceptor is impossible |
|---|---|
| **Claude Code** | hooks are separate **processes**; there is no seam inside the agent to install anything on |
| **Codex** | the host is **Rust**, and its hooks are separate processes too |

For those, the next vantage down is a socket in front of the harness.

## Install

```sh
npm i -g @openguardrails/ogr-local
```

The harness plugins start it for you from their `SessionStart` hook. You only
run it by hand to check on it:

```sh
ogr-local status
```

## Wiring

**The upstream travels in the path**, which is what lets one daemon on one
port serve harnesses that talk to different providers:

```sh
# Claude Code — settings.json
"env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787/https/api.anthropic.com" }

# Codex — ~/.codex/config.toml (ChatGPT sign-in)
openai_base_url = "http://127.0.0.1:8787/https/chatgpt.com/backend-api/codex"
# Codex — ~/.codex/config.toml (API key)
openai_base_url = "http://127.0.0.1:8787/https/api.openai.com/v1"

# or ask:
ogr-local base-url https://api.anthropic.com
```

Both harnesses resolve their provider URL **statically at startup** — Claude
Code from `settings.json`, Codex from `config.toml` — so neither can be handed
an ephemeral port, and a fixed port *per upstream* would mean one listener per
provider, each with its own lifecycle. Encoding the upstream in the base URL
the harness is already configured with collapses that to one port.

⚠️ **A hook cannot set these for you.** A hook is a child process; the
harness read its own environment long before. The `SessionStart` hooks start
the daemon and then *check* the setting, so the one failure that would
otherwise be silent — daemon healthy, harness talking straight to the
provider, nothing masked — is said out loud.

## Commands

| | |
|---|---|
| `ogr-local ensure` | make sure a daemon is listening; print its URL. Idempotent — the port is the lock, and the check is a live request, so a stale record cannot lie |
| `ogr-local serve` | run in the foreground (what `ensure` spawns) |
| `ogr-local status` | ruleset, session count, and what has been masked |
| `ogr-local base-url <url>` | the base URL to point a harness at, for one upstream |

Configuration is environment, shared with the rest of the OGR integrations:
`OGR_API_KEY` (required — the ruleset is your organization's),
`OGR_RUNTIME_URL`, `OGR_LOCAL_PORT` (8787), `OGR_RULES_CACHE`,
`OGR_FAIL_MODE`, `OGR_LOCAL_IDLE_MS` (6h).

## What it deliberately is not

- **Not an auth boundary.** Your `Authorization` / `x-api-key` is forwarded
  byte for byte and never read. The proxy holds no credential and mints none
   — a process that could answer *for* you is a far worse thing to leave
  listening than one that can only rewrite a body.
- **Not a policy engine.** Verdicts stay with the harness's OGR hooks. This
  is a masking seam, not a second enforcement point.
- **Not an open proxy.** The path may only name a known model API host; add
  your own gateway with `--host`. Without that bound, a general-purpose
  forwarder would be listening on loopback for every process on the machine.
- **There is no `/__ogr/restore`.** `/__ogr/mask` exists so a hook's own
  event carries the same tokens the provider was given; the reverse would
  hand any local process the plaintext of every secret the session has seen.
- **It refuses to start without an API key.** With no key there is no
  ruleset, so it would forward everything unmasked while a harness pointed at
  it looked protected. Better to not be listening at all.

## Honest limits

- **If the daemon is down, the harness cannot reach its provider.** That is
  the cost of a base-URL redirect, and it is why `ensure` runs on every
  session start and why the idle timeout is hours rather than minutes. The
  in-process interceptor has no equivalent failure — one more reason to
  prefer it wherever a plugin can run in-process.
- **Replies are requested uncompressed.** A gzipped body is one no tool call
  can be restored out of, and forwarding it would look exactly like a reply
  with nothing to restore.
- **One map per session key**, read from the request's own `metadata.user_id`
  / `user` where the harness stamps one (Claude Code does), else one key for
  the process.

## Development

```sh
npm install     # from the repo root (npm workspace)
npm run build
npm test
```
