<!--
  Copyright (c) 2026 OpenGuardrails.com
  Author: thomas-security <thomas@openguardrails.com>
  SPDX-License-Identifier: Apache-2.0
-->

# Extended Agent Playbook

Companion to the two skills in [`skills/`](../skills). Read the skill
first; this document adds detail for the hard cases.

## The two modes

An agent interacting with this repo is doing one of two things:

1. **Using `thomas`** to audit something — that's
   [`skills/thomas-security/SKILL.md`](../skills/thomas-security/SKILL.md).
2. **Contributing** new checkups / red-team / integrations to this repo —
   that's [`skills/contribute/SKILL.md`](../skills/contribute/SKILL.md).

Everything below applies to both unless noted.

## Invariants you never break

- You do not mutate the user's environment without confirmation.
- You do not run `thomas redteam` against a target the user didn't name.
- You do not commit files to the user's repo without showing the diff.
- You do not invent references. Every checkup / attack cites a real URL.
- You preserve severity strings verbatim when reporting. `critical`
  means `critical`.

## Running thomas

```bash
thomas scan --json
thomas redteam --target <url|cmd> --suite <suite> --json
thomas integrate {skill|plugin|sdk}
```

Exit codes (all subcommands): `0` clean · `2` findings below threshold ·
`3` findings at/above threshold · `1` tool error.

Parse the JSON. Do not re-read stdout as a text blob. The JSON shape:

```jsonc
{
  "tool": "thomas-security",
  "version": "...",
  "command": "scan",
  "startedAt": "...",
  "finishedAt": "...",
  "findings": [
    { "id": "OGR-OC-...", "severity": "high", "title": "...",
      "location": "...", "evidence": "...", "remediation": "..." }
  ],
  "summary": { "total": 1, "bySeverity": { "high": 1 } }
}
```

## Recognizing which mode the user wants

| User phrasing                                   | Mode       | Next step                      |
| ----------------------------------------------- | ---------- | ------------------------------ |
| "scan / audit / check my agent"                 | use        | `thomas scan`                  |
| "red-team / pentest / attack the agent at …"    | use        | `thomas redteam`               |
| "install / integrate thomas into my agent"      | use        | `thomas integrate`             |
| "add a checkup for <CVE>"                       | contribute | load `contribute` skill        |
| "write a red-team attack for <incident>"        | contribute | load `contribute` skill        |
| "add an integration for <agent>"                | contribute | load `contribute` skill        |
| "make sure my agent is safe" (ambiguous)        | use        | default to `scan`              |

## When things go wrong

- **`thomas` not on PATH** → `npm install -g @openguardrails/thomas-security`.
  If that also fails, stop and tell the user. Don't substitute a different
  tool.
- **Target refuses connection** → ask for the correct URL or command.
  Don't retry silently.
- **Scan returns zero findings but the user insists something's wrong**
  → propose `--target <path>` pointing at the suspect file or directory.
  Scan is conservative by design; manual targeting broadens it.
- **Red-team suite doesn't exist for the target agent** → that's a
  contribution opportunity. Offer to load the `contribute` skill.
- **User asks to publish a rule with no public reference** → decline.
  Walk them through filing upstream first. This bar is load-bearing for
  the whole project.

## Reporting format

Three parts, each short:

1. One-sentence verdict. Preserve severity counts.
2. Per-finding paragraph: title, location, action. One paragraph each.
3. Optional follow-up offer.

No raw JSON unless asked. No editorializing on severity ("this seems
minor") — the severity field already says what it says.
