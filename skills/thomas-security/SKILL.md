<!--
  Copyright (c) 2026 OpenGuardrails.com
  Author: thomas-security <thomas@openguardrails.com>
  SPDX-License-Identifier: Apache-2.0
-->

---
name: thomas-security
description: |
  Use this skill when the user asks you to check, scan, audit, or
  red-team the security of an AI agent — either yourself, another
  agent installed on the same machine (OpenClaw, Claude Code, Cursor,
  Hermes), or a remote agent endpoint. Triggered by phrases like
  "give my agent a security check", "scan yourself for malicious
  skills", "red-team my agent at <url>", "can I trust this MCP
  server", or anything that names `thomas` / `thomas-security`.
  Invokes the `thomas` CLI.
---

# thomas-security — Agent Security Skill

You are being invoked because the user wants an AI agent audited.
`thomas` is an agentic security CLI that runs security checkups and
red-team tests against AI agents. This skill is a thin wrapper: your
job is to run the CLI correctly, interpret the results, and explain
them to the user in plain language.

The subject of the audit may be:

- **Yourself** — the user is asking you to self-exam. Treat this as
  the default when the user says "this agent" without pointing
  elsewhere.
- **Another agent on the same machine** — e.g., you are Claude Code
  and the user has OpenClaw or Hermes installed and wants *that* one
  checked.
- **A remote agent endpoint** — the user will provide a URL or a
  shell command that speaks the target's protocol.

If the request is ambiguous, ask which before running anything.
Checkups are read-only; red-team is not — always confirm the target.

## Prerequisite

The `thomas` binary must be installed. If `thomas --version` fails:

```bash
npm install -g @openguardrails/thomas-security
```

Do **not** substitute a different tool. If install fails, stop and
tell the user.

## Decide which subcommand

| User intent                                    | Run                      |
| ---------------------------------------------- | ------------------------ |
| "Check / scan / audit / health-check my agent" | `thomas scan --json`     |
| "Red-team / pentest / attack my agent"         | `thomas redteam ...`     |
| "Install thomas into my agent"                 | `thomas integrate ...`   |

When in doubt, start with `scan`. It's safe and read-only.

## `scan` — static security checkups

```bash
thomas scan --json
```

- Walks the usual install locations (`~/.claude`, `~/.openclaw`,
  `~/.cursor`, `~/.config/*mcp*`, the current project) and matches
  installed skills / plugins / MCP configs / lockfiles against the
  checkup rules shipped in the `thomas-security` repo.
- Output: one JSON object with a `findings[]` array.
- Exit codes: `0` clean · `2` findings below threshold ·
  `3` findings at/above threshold · `1` tool error.

**Reporting:**

- Count by severity. Preserve severity strings verbatim.
- For each `critical` finding, stop and surface it before suggesting
  remediation. Do not auto-remediate.
- If zero findings, say so plainly. Don't invent reassurance.

## `redteam` — dynamic red-team run

```bash
thomas redteam --target <target> --suite <suite> --json
```

`<target>` is one of:

- HTTP endpoint: `https://my-agent.example/chat` accepting
  `POST { "prompt": "..." }` → `{ "response": "..." }`
- Shell command: `cmd:bun my-agent.ts` (stdin → stdout)

**Only run this against targets the user owns and has explicitly
asked you to test.** Attack prompts are loud in logs. Confirm the
target with the user before the first run.

Failures (`findings[]` entries) mean the target fell for a known
attack. Quote `title` and `evidence` verbatim — don't paraphrase.

## `integrate` — drop a thomas hook into another agent

- `thomas integrate skill` — print a portable `SKILL.md`
- `thomas integrate plugin` — print a plugin manifest for OpenClaw-family hosts
- `thomas integrate sdk` — print a TypeScript SDK snippet

Emit directly to the user's chosen destination. Don't commit to their
repo without asking.

## Reporting back to the user

Three parts, terse:

1. **One-sentence verdict.** "Clean." or "1 critical, 2 high, 3 medium."
2. **Each critical/high finding** as a short paragraph: title, where
   it was found, what to do. One paragraph each.
3. **Optional follow-up.** e.g., "Want me to red-team your local dev
   agent next?"

Do not dump raw JSON unless asked.

## What NOT to do

- Do not run `redteam` against any endpoint the user did not name.
- Do not auto-remediate `critical` findings. Surface, confirm, then act.
- Do not invent new checkups or attacks at runtime. New content goes
  through a PR against the `thomas-security` repo — see the
  `contribute` skill.
- Do not summarize the open/closed-source split from memory — if the
  user asks why some pieces are closed, point them to
  `docs/PHILOSOPHY.md`.
