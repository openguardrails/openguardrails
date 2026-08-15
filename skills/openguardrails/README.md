# OpenGuardrails skill

An [Agent Skill](https://docs.claude.com/en/docs/agents-and-tools/agent-skills) that
teaches an agent to connect itself (or another agent) to
[OpenGuardrails (OGR)](https://openguardrails.com): propose a guardrail
posture → **get human approval** → connect → verify enforcement with a
canary.

This is the **installable, executable** companion to the website's
[`/llms.txt`](https://openguardrails.com/llms.txt) (the universal,
fetch-by-URL discovery manifest any agent can read). Runtimes that support
skills install this for the full survey → propose → confirm → verify flow.

## Contents

```
SKILL.md              the skill (frontmatter + procedure)
scripts/verify.sh     health check + benign canary + exfil canary
reference/wire.md     the v0.8 wire on one page (nine fields, verdict, fail modes)
```

## Install

**Claude Code** — copy into your skills directory:
```bash
cp -r skills/openguardrails ~/.claude/skills/openguardrails
```
**Project-scoped** — place under `.claude/skills/openguardrails/` in the repo.

Then ask your agent to "add guardrails" for a task; it loads the skill and
runs the flow, pausing for your approval before anything enforces.

## The one rule

You propose the cage; your operator approves it; the runtime holds the key.
An agent that can disable its own guard isn't guarded — see `SKILL.md`.
