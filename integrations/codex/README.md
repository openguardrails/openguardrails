# openguardrails-instrumentation-codex

**Auto mode for [OpenAI Codex](https://github.com/openai/codex), over the
[OpenGuardrails](https://openguardrails.com) (OGR) protocol.**

Install this as a Codex plugin and Codex stops interrupting you for tool calls
an OGR runtime judges safe — while everything risky still stops for a human,
and outright-dangerous calls are blocked even when you've bypassed Codex's own
approvals.

It ships **two complementary hooks**:

| Hook | Codex event | Job |
|---|---|---|
| **Auto mode** | `PermissionRequest` | Removes prompts for *safe* calls. Asks an OGR runtime; `allow` runs unattended, `block` is denied, everything else defers to you. |
| **Guardrail** | `PreToolUse` | Blocks *dangerous* calls (`curl \| bash`, obfuscated exec, egress, credential reads) — non-bypassable, fires even under `bypassPermissions`. |

Auto mode is the OGR **agent-hook altitude**: Codex acts as an OGR Policy
Enforcement Point, and the runtime is the decision point. The same policy model
also enforces at the gateway and sandbox altitudes.

## Install (as a Codex plugin)

Requires **Codex ≥ 0.122** (when `PermissionRequest` hooks landed) and Node ≥ 18.

```bash
# 1. Add this repo as a plugin marketplace and install the plugin.
codex plugin marketplace add openguardrails/openguardrails
codex plugin add openguardrails-codex@openguardrails
```

At the next `codex` startup you'll be asked to **review and trust** the plugin's
hooks (they don't run until you do — this is Codex's hook-trust gate). Choose
*Trust all and continue*.

Then point auto mode at your OGR runtime by exporting a few env vars (in your
shell profile, so Codex's `sh -lc` hook process inherits them):

```bash
export OGR_SERVER="https://your-ogr-runtime:8878"   # default http://127.0.0.1:8878
export OGR_ENROLL_TOKEN="et-…"                       # from your OGR tenant
```

That's it. Safe calls now run without a prompt; the runtime decides.

> **Building from a local clone instead?** `npm install && npm run build` bundles
> both zero-dependency hooks, then `codex plugin marketplace add ./path/to/clone`.

## Configuration (auto mode)

All via environment variables (the plugin manifest can't declare config, so the
hook reads env; `${PLUGIN_DATA}` is wired to Codex's per-plugin state dir
automatically):

| Var | Default | Meaning |
|---|---|---|
| `OGR_SERVER` | `http://127.0.0.1:8878` | OGR runtime base URL |
| `OGR_ENROLL_TOKEN` | *(required)* | PEP enrollment token for your tenant |
| `OGR_AGENT_ID` | `codex-<hostname>` | Stable PEP identity |
| `OGR_TIMEOUT_MS` | `10000` | Per-decision timeout |
| `OGR_MAX_CONSECUTIVE_DENIALS` | `3` | Denials in a row before deferring the rest of the turn to you |
| `OGR_MAX_TOTAL_DENIALS` | `20` | Total denials per turn before deferring |
| `OGR_AUTOMODE_POLICY` | *(none)* | Path to a JSON file with prose `{environment, allow, soft_deny}` slots forwarded to the classifier |
| `OGR_STATE_DIR` | `${PLUGIN_DATA}` | Where the PEP credential and per-turn denial counters are cached |

## How auto mode maps OGR to Codex

`hooks/ogr-codex-automode-hook.src.mjs` reads the `PermissionRequest` payload on
stdin, enrolls once as an OGR PEP (credential cached on disk across
invocations), builds a `tool_call` `GuardEvent`, and calls
`POST /api/v1/decide`:

| OGR `Verdict.decision` | Auto-mode hook output | User sees |
|---|---|---|
| `allow` | `{decision:{behavior:"allow"}}` | nothing — the call just runs |
| `block` | `{decision:{behavior:"deny", message}}` | the call is refused; the reason goes back to the model |
| `require_approval` / `modify` / `redact` | *(empty stdout = abstain)* | Codex's own approval prompt — **you** are the approver in an interactive CLI |
| runtime down / timeout / error | *(abstain)* | Codex's own prompt — **fail closed to ask**, never a silent allow |

**Reasoning-blind transcript.** The `GuardEvent` payload carries a projection of
the session containing only user text and bare assistant tool calls — assistant
prose and tool *outputs* are stripped, so a prompt-injected agent cannot argue
the classifier into an allow. (`tool_call` receipt digests cover only
`["name","arguments"]`, so this extension never invalidates approval receipts.)

**Denial-escalation backstop.** If the classifier keeps denying the same turn
(3 in a row / 20 total by default), auto mode stops deciding and hands control
back to you rather than trapping the agent in a deny loop.

**Explicit policy always wins.** Auto mode runs *after* Codex's execpolicy rules
and any other `PermissionRequest` hooks, and only on calls that would otherwise
prompt — it can never override a rule that already allowed or denied a call.

## The guardrail hook (PreToolUse)

The second hook is the original OGR command-approval gate. Codex sends
`permission_mode` — including `bypassPermissions` — and the hook fires
regardless, so a `deny` here blocks a call even when the user has waved through
Codex's approvals.

| Tool call | OGR decision | Codex result |
|---|---|---|
| `curl … \| bash`, `base64 -d \| sh`, `curl … \| python` | `block` | **deny** |
| `rm -rf /`, download-then-`chmod +x`, `$(curl …)` | `block` | **deny** |
| egress to a non-allowlisted host | `require_approval` | **ask** |
| read of `~/.ssh`, `~/.aws`, `.env`, cookies | `require_approval` | **ask** |
| `npm run build`, fetch from pypi/npm/github | `allow` | **allow** |

Its policy lives in [`policy/policy.json`](./policy/policy.json) — copy-then-edit,
or point elsewhere with `OGR_POLICY=…`. It **fails open** on its own internal
errors and **fails closed** on a matched dangerous rule. (Auto mode, by
contrast, fails *closed to ask* — a guardrail that removes prompts must never
remove them by accident.)

Prefer only one of the two? Delete the unwanted event block from
[`hooks/hooks.json`](./hooks/hooks.json).

## Runtime setup

Auto mode needs an OGR runtime with the **action-classifier** detector enabled
(it calls an [og-classifier](https://github.com/openguardrails/og-classifier)
command-approval model, or falls back to the runtime's rule/LLM-judge tiers).
See the runtime's `OPERATING.md` for `OGR_ACTION_CLASSIFIER_URL` and enabling
the `detection.action_classifier` policy section for your tenant.

## Tests

```bash
npm test          # guardrail smoke cases + auto-mode hook (mock OGR runtime)
```

`test/automode.mjs` covers allow/deny/abstain mapping, fail-closed on
unreachable/timeout/500, PEP enrollment caching + stale-credential re-enroll,
the denial-escalation backstop, reasoning-blind transcript projection, and
policy passthrough. `test/e2e.sh` drives the built hook against a *live* runtime.

## Status

`v0.2`. Apache-2.0. Built against the Codex `PermissionRequest` / `PreToolUse`
hook schema and plugin system (`openai/codex`, `codex-rs/hooks`,
`codex-rs/core-plugins`) as of 2026-07.
