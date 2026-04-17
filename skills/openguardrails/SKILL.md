<!--
  Copyright (c) 2026 OpenGuardrails.com
  Author: thomas-security <thomas@openguardrails.com>
  SPDX-License-Identifier: Apache-2.0
-->

---
name: openguardrails
description: |
  Use this skill when the user asks you to check, scan, test, or
  audit the security of an AI agent — either yourself, another agent
  installed on the same machine (e.g., OpenClaw, Hermes, Claude Code,
  Cursor), or a remote agent endpoint. Triggered by phrases like
  "give my agent a security check", "scan yourself for malicious
  skills", "red-team my agent at <url>", "can I trust this MCP
  server", or anything that cites OpenGuardrails. Invokes the
  OpenGuardrails-OSS CLI.
---

# OpenGuardrails — Agent Security Skill

You are being invoked because the user wants an AI agent audited.
OpenGuardrails-OSS is the open-source toolkit for this. This skill is a
thin wrapper: your job is to run the CLI correctly, interpret the
results, and explain them to the user in plain language.

The subject of the audit may be:

- **Yourself** — the user is asking you to self-exam. Treat this as
  the default when the user says "this agent" without pointing
  elsewhere.
- **Another agent on the same machine** — e.g., you are Claude Code
  and the user has OpenClaw or Hermes installed and wants *that* one
  checked. Target its config directories explicitly.
- **A remote agent endpoint** — the user will provide a URL or a
  shell command that speaks the target's protocol.

If the request is ambiguous, ask which before running anything
destructive. `scan` is read-only and safe to run for either self-exam
or peer-exam without confirmation; `redteam` is not — always confirm.

## Decide which tool

| User's intent                                  | Run                 |
| ---------------------------------------------- | ------------------- |
| "Check / scan / audit / health-check my agent" | `ogr scan --json`   |
| "Red-team / pentest / pretend to attack it"    | `ogr redteam ...`   |
| "Install / integrate OpenGuardrails into my agent" | `ogr integrate ...` |

When in doubt, start with `scan`. It is safe and read-only.

## Before you run anything

1. Make sure the repo is present and dependencies are installed:

   ```bash
   test -d openguardrails-oss || git clone https://github.com/openguardrails/openguardrails-oss.git
   cd openguardrails-oss && bun install
   ```

2. If `bun` is not on PATH, stop and tell the user. Do not silently
   substitute `node` or `npm` — the CLI uses Bun-specific APIs.

## `scan` — static health-check

```bash
bun src/cli.ts scan --json
```

- Walks `~/.claude`, `~/.cursor`, `~/.vscode`, and the current
  project for known-bad skills, plugins, MCP configs, and dangerous
  permissions.
- Output is a single JSON object conforming to the contract in the
  README.
- Exit codes: `0` clean · `2` findings below threshold · `3` findings
  at/above threshold · `1` tool error.

**What to do with the results:**

- Report the count by severity. Preserve severity strings verbatim.
- For each `critical` finding, stop and surface it to the user
  before suggesting remediation. Do not auto-remediate.
- If there are zero findings, say so plainly. Do not invent
  reassurance.

## `redteam` — dynamic attack simulation

```bash
bun src/cli.ts redteam --target <target> --json
```

`<target>` is one of:

- an HTTP endpoint: `https://my-agent.example/api/chat`
  (must accept `POST { "prompt": "..." }` and return
  `{ "response": "..." }` or plain text)
- a shell command: `cmd:bun my-agent.ts` (reads the prompt from
  stdin, writes the reply to stdout)

**Only run this against targets the user owns and has explicitly
asked you to test.** The attack suite is loud and will appear in
server logs. Confirm the target with the user before the first run.

Failures (`findings[]` with severity `high`/`critical`) indicate
that the target agent fell for a known attack. Quote the `title`
and `evidence` fields verbatim when reporting back — don't
paraphrase.

## `integrate` — emit a drop-in artifact

- `bun src/cli.ts integrate skill` → prints this SKILL.md
- `bun src/cli.ts integrate plugin` → prints a JSON manifest for the
  moltguard plugin (OpenClaw-family agents)
- `bun src/cli.ts integrate sdk` → prints a TypeScript usage snippet

Emit directly to the user's chosen destination. Do not commit to
their repo without asking.

## Reporting back to the user

Keep it tight. A good report has three parts:

1. **One sentence verdict.** "Clean." or "1 critical, 2 high, 3 medium."
2. **Each critical/high finding** as a short paragraph: title, where
   it was found, what to do about it. One paragraph each.
3. **Optional follow-ups.** e.g., "Want me to also run the red-team
   suite against your local dev agent?"

Do not dump raw JSON unless the user asks for it.

## What NOT to do

- Do not run `redteam` against any endpoint the user did not name.
- Do not auto-remediate `critical` findings. Surface, confirm, then
  act.
- Do not add speculative entries to the knowledge base. Contributions
  go through PRs in the repo, not through the skill.
- Do not summarize OpenGuardrails' philosophy from memory — if the
  user asks why some parts are closed source, point them to
  `docs/PHILOSOPHY.md` or quote from it.
