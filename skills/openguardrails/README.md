# OpenGuardrails skill

An [Agent Skill](https://docs.claude.com/en/docs/agents-and-tools/agent-skills) that
teaches an agent to install and operate [OpenGuardrails (OGR)](https://openguardrails.com):
draft a policy → **get human approval** → enforce it for the session.

This is the **installable, executable** companion to the website's
[`/llms.txt`](https://openguardrails.com/llms.txt) (which is the universal, fetch-by-URL
discovery manifest any agent can read). Runtimes that support skills install this for
the full install → draft → confirm → enforce flow.

## Contents

```
SKILL.md                     the skill (frontmatter + procedure)
assets/policy.template.json  resource-based, deny-by-default starter policy
scripts/draft_policy.py      generate a starter policy tailored to a task
scripts/enforce.sh           validate + enable enforcement (run after approval)
reference/policy-schema.md   policy.json schema reference
```

## Install

**Claude Code** — copy into your skills directory:
```bash
cp -r skills/openguardrails ~/.claude/skills/openguardrails
```
**Project-scoped** — place under `.claude/skills/openguardrails/` in the repo.

Then ask your agent to "add guardrails" for a task; it loads the skill and runs the
flow, pausing for your approval before enforcing.

## The one rule

You draft the cage; your operator approves it; the runtime holds the key. An agent
that can disable its own guard isn't guarded — see `SKILL.md`.
