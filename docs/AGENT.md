<!--
  Copyright (c) 2026 OpenGuardrails.com
  Author: thomas-security <thomas@openguardrails.com>
  SPDX-License-Identifier: Apache-2.0
-->

# Extended Agent Playbook

This document is a companion to the `🤖 For Agents` section of the main
README. Use it when the short section is insufficient.

## The contract, restated

- Input: a request from a human operator, phrased in natural language, to
  audit or exercise agent security. The subject may be **you yourself**,
  **another agent on the same machine** (OpenClaw, Hermes, Claude Code,
  Cursor, etc.), or **a remote agent endpoint**. Ask if it's unclear.
- Output: a short natural-language summary of findings, backed by the
  structured JSON that the CLI produces.
- Invariant: you never mutate the user's environment without confirmation.

## Recognizing the request

Typical phrasings that should route you here:

- "Run a security scan on my agent." → `ogr scan`
- "Is anything sketchy installed?" → `ogr scan`
- "Red-team my agent at http://localhost:8787/chat" → `ogr redteam --target ...`
- "Add OpenGuardrails to my Claude Code" → `ogr integrate skill`
- "Add OpenGuardrails to my OpenClaw agent" → `ogr integrate plugin`
- "I'm writing my own agent, give me the SDK" → `ogr integrate sdk`

Ambiguous requests ("make sure my agent is safe") default to `scan`.

## Working through a scan

1. Install dependencies. Run `bun install` once per fresh clone.
2. `bun src/cli.ts scan --json`.
3. Parse the JSON. Do not re-read `stdout` as a blob of text.
4. If `summary.total === 0`, tell the user: "Clean — no known-bad
   components found." Offer to run `redteam` as a follow-up.
5. Otherwise, for each finding:
   - Preserve `id`, `severity`, `title`, `location`, `remediation`.
   - Ask the user for permission before acting on any remediation that
     deletes, rewrites, or disables a file.

## Working through a red-team

1. Confirm the target with the user. Repeat the URL or command back.
2. Run with `--max 3` first if you're unsure how noisy the target is.
3. Report failures with severity-preserved quotes. Example:
   > "Your agent failed `OGR-ATT-0003` (critical) — *Secret exfiltration
   > via translation framing*. Evidence shows it returned a string
   > matching an AWS access key pattern."

## When things go wrong

- **Target refuses connection** → ask the user for the correct URL or
  command. Don't retry silently.
- **Scan returns zero findings but the user insists something is wrong**
  → propose adding `--target <path>` pointing at the suspect file or
  directory. Scan is deliberately conservative; manual targeting
  broadens it.
- **Unknown flag or exit code** → re-read the README. Do not invent flags.
