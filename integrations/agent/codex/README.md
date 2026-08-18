# openguardrails-instrumentation-codex

**Auto mode for [OpenAI Codex](https://github.com/openai/codex), over the
[OpenGuardrails](https://openguardrails.com) (OGR) v0.8 protocol.**

Install this as a Codex plugin and Codex stops interrupting you for tool calls
an OGR runtime judges safe — while everything unclear still stops for a human,
and outright-dangerous calls are blocked even when you've bypassed Codex's own
approvals.

It ships **two complementary hooks**, both zero-dependency Node scripts
speaking the [Runtime API](../../../specification/runtime-api.md) directly
(there is no SDK and no local policy engine — v0.7 retired both):

| Hook | Codex event | Job | Degraded mode |
|---|---|---|---|
| **Auto mode** | `PermissionRequest` | Removes prompts for *safe* calls: `allow` runs unattended, `block` is denied, everything else defers to you. | **abstain** — no verdict means Codex's own prompt appears; the human decides |
| **Guardrail** | `PreToolUse` | Denies *blocked* calls — non-bypassable, fires even under `bypassPermissions`. | `OGR_FAIL_MODE`: `open` (default) or `closed` |

The two degraded modes differ on purpose: a `PermissionRequest` has a human
standing by, so abstaining is strictly safer than either failing open or
trapping the agent. The guardrail fires where no human is standing by, so it
takes the spec's [open/closed fork](../../../specification/degraded-mode.md).

## Install (as a Codex plugin)

Requires **Codex ≥ 0.122** (when `PermissionRequest` hooks landed) and Node ≥ 18.
No `npm install`, no build step — each hook is a single self-contained file.

```bash
codex plugin marketplace add openguardrails/openguardrails
codex plugin add openguardrails-codex@openguardrails
```

At the next `codex` startup you'll be asked to **review and trust** the plugin's
hooks (they don't run until you do — this is Codex's hook-trust gate). Choose
*Trust all and continue*.

Then point the hooks at your OGR runtime (in your shell profile, so Codex's
`sh -lc` hook process inherits them):

```bash
export OGR_RUNTIME_URL="https://your-ogr-runtime"   # default https://openguardrails.com
export OGR_API_KEY="ogr_…"                          # your organization API key
```

That's it. Safe calls now run without a prompt; the runtime decides.

> **Wiring by hand instead of the plugin system?** See
> [`config.example.toml`](./config.example.toml).

## Configuration

All via environment variables (the plugin manifest can't declare config;
`${PLUGIN_DATA}` is wired to Codex's per-plugin state dir automatically):

| Var | Default | Meaning |
|---|---|---|
| `OGR_RUNTIME_URL` | `https://openguardrails.com` | Runtime base URL; canonical `/v1/...` paths are appended (legacy alias: `OGR_SERVER`) |
| `OGR_API_KEY` | *(required)* | Organization API key, sent as `Authorization: Bearer` (legacy alias: `OGR_ENROLL_TOKEN`) |
| `OGR_FAIL_MODE` | `open` | **Guardrail hook only** — what "no verdict" means: `open` proceeds unjudged, `closed` denies |
| `OGR_TIMEOUT_MS` | `5000` | Per-evaluate budget |
| `OGR_AGENT_ID` | `""` | `agent_id` claim; empty = derived from the API key (identity floor) |
| `OGR_AGENT_TYPE` | `codex` | `agent_type` claim (harness label) |
| `OGR_AGENT_WORKSPACE` | `""` | `agent_workspace` claim; empty = the API key's workspace |
| `OGR_AGENT_USER` | `""` | `agent_user` claim |
| `OGR_MAX_CONSECUTIVE_DENIALS` | `3` | Auto mode: denials in a row before deferring the rest of the turn to you |
| `OGR_MAX_TOTAL_DENIALS` | `20` | Auto mode: total denials per turn before deferring |
| `OGR_STATE_DIR` | `${PLUGIN_DATA}` | Where auto mode's per-turn denial counters live |

## How the hooks map OGR v0.8 to Codex

Each hook holds one pending tool call and sends the runtime one canonical
`step/response` [`GuardEvent`](../../../specification/guard-event.md) —
`{kind, step_id, four-tuple, llm_protocol: "canonical", payload}` where the
payload carries the held call as `tool_calls[0]`, plus the current
generation's prose and reasoning summaries read from the session rollout
(`transcript_path`) and the host-reported model. `step_id` is fresh per
invocation; sessions and turns are derived by the runtime.

Auto mode maps the [`Verdict`](../../../specification/verdict.md) back:

| Verdict | Auto-mode hook output | User sees |
|---|---|---|
| `allow` | `{decision:{behavior:"allow"}}` | nothing — the call just runs |
| `block` | `{decision:{behavior:"deny", message}}` | the call is refused; the findings go back to the model |
| `allow` + `modifications.spans` on the held call | *(abstain)* | Codex's own prompt — the hook can't redact a pending call, so it never auto-runs one the runtime wanted rewritten |
| `allow` + `unjudged` naming the held call | *(abstain)* | Codex's own prompt — "could not look" is never auto-approved |
| no verdict (down / timeout / 429 / 5xx) | *(abstain)* | Codex's own prompt — the human decides |

**Denial-escalation backstop.** If the runtime keeps denying the same turn
(3 in a row / 20 total by default), auto mode stops deciding and hands control
back to you rather than trapping the agent in a deny loop. Counters persist
under `OGR_STATE_DIR`, keyed by session and turn.

**Explicit policy always wins.** Auto mode runs *after* Codex's execpolicy rules
and any other `PermissionRequest` hooks, and only on calls that would otherwise
prompt — it can never override a rule that already allowed or denied a call.

The guardrail hook maps the same verdicts to `PreToolUse` output: `block` →
`deny` (even under `bypassPermissions`), `allow` → silent, no verdict →
`OGR_FAIL_MODE`.

## Honest limits: the fragment vantage

A Codex hook never holds the model call — it holds **one tool call awaiting
approval**. That bounds what this integration can honestly send:

- **No `step/request`.** The hook never sees what was sent to the model, so
  only the response half of each step reaches the runtime — and only when a
  matched call fires a hook. Prose-only turns are invisible.
- **One call per event.** Parallel calls from one generation arrive as
  separate hook invocations, so they reach the runtime as separate steps —
  the decomposition a full-loop integration (the
  [recipe](../../../specification/runtime-api.md#the-recipe)) avoids. The
  hooks recover what they can from the rollout: the current generation's
  prose and reasoning ride alongside the call.
- **No redaction.** A hook cannot rewrite tool arguments; spans targeting the
  held call are enforced as abstain (auto mode) / deny (guardrail).
- **No heartbeat.** The hooks are one-shot processes with no resident loop;
  the fleet-coverage heartbeat needs a vantage that stays alive.

(The v0.6 plugin's Ed25519 enrollment, signed requests, and the
reasoning-blind `authz` transcript envelope left with the old protocol — the
API key is the whole channel identity in v0.8, and the model's own prose is
signal the runtime's judge wants alongside the call.)

## Tests

```bash
npm test    # offline: strict v0.8 mock runtime (node:http) + behavioral cases
```

`test/smoke.mjs` covers the guardrail (block→deny, fail-open default,
fail-closed config, unjudged/span handling, rollout mapping);
`test/automode.mjs` covers auto mode (allow/deny mapping, abstain on every
no-verdict path, the denial-escalation backstop). Both suites share a mock
runtime that rejects any event deviating from
[`schema/guard-event.schema.json`](../../../schema/guard-event.schema.json)
by so much as one field. `test/e2e.sh` drives the auto-mode hook against a
*live* runtime.

## Status

`v1.0` — the v0.8 rewrite. Apache-2.0. Built against the Codex
`PermissionRequest` / `PreToolUse` hook schema and plugin system
(`openai/codex`, `codex-rs/hooks`, `codex-rs/core-plugins`) as of 2026-07.
