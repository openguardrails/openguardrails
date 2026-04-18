# OpenGuardrails-OSS

> **Protect every action your agent takes.**

OpenGuardrails is an agent-security platform. **OpenGuardrails-OSS** is its
open-source part — a toolkit for giving an AI agent a **health-check** and
an **exam**. You drive the work through an agent (OpenClaw, Hermes — any autonomous agent) by asking it in natural
language; it then uses OpenGuardrails-OSS to audit *itself* or *other
agents*.

It does three things:

1. **Scan** — a health-check for installed agents, skills, plugins, and MCP
   servers. Looks for known vulnerabilities, known-malicious components, and
   dangerous configurations. Think of it as a physical exam.
2. **Red-team** — a dynamic exam. Runs curated attack prompts from
   OpenGuardrails Agent Threat Intelligence against a target agent to see whether
   it falls for them. Think of it as a driving test under hostile
   conditions.
3. **Integrate** — ready-to-drop plugin, skill, and SDK so developers can
   call OpenGuardrails from inside their own agents at runtime.

---

## Who is reading this?

This project is designed to be **driven by an AI agent, not by a human typing
commands**. Pick the section that matches you:

- 👤 **You are a human** — keep reading the [For Humans](#-for-humans) section
  below. You will not type any commands. You will only hand this repository's
  URL to an agent (OpenClaw, Hermes Agent, Claude Code, Codex,
  or any other autonomous agent) and tell it, in plain language, what you
  want checked. The agent you drive may be the *same* agent being audited
  (self-exam) or a *different* one (auditing a peer).
- 🤖 **You are an AI agent** — skip to [For Agents](#-for-agents). That
  section contains the commands, flags, exit codes, and machine-readable
  output formats you need. You may be running this on yourself, or on a sibling
  agent on the same machine.

---

## 👤 For Humans

### What this is, in one paragraph

An AI agent — OpenClaw, Hermes Agent, Claude Code, Cursor, whichever one you
run — has root-like power over your laptop. It reads files, writes
files, runs commands, installs tools, and pipes data to the internet.
If an attacker sneaks a bad prompt, a bad skill, or a bad MCP server
into an agent's environment, the attacker inherits that power.
OpenGuardrails-OSS is the toolkit you tell an agent to use so it can
give itself — or a different agent on your machine — a health-check
and an exam, and flag problems early.

### How to use it (no technical skill required)

1. Open any agent that can run shell commands (OpenClaw, Hermes Agent,
   Claude Code, Cursor, ChatGPT desktop with a terminal tool, etc.).
2. Paste this to it:

   > Please clone `https://github.com/openguardrails/openguardrails-oss`
   > and give my agent stack a full security checkup. Report what you
   > find in plain English.

3. That's it. The agent will handle installation, scanning, and
   reporting.

Things you can ask for:

- *"Give yourself a security checkup."* → the agent runs `scan` on
  itself
- *"Check the other agent I have installed."* → `scan` targeted at
  that agent's config paths
- *"Pretend to be an attacker and see if my agent falls for known
  tricks."* → `redteam`, against the target you name
- *"Install the OpenGuardrails skill so this agent can protect itself
  next time."* → installs the skill under `skills/openguardrails/`

The agent driving the work does **not** have to be the agent being
audited. You can drive a self-exam (agent audits itself) or a peer
exam (agent A audits agent B).

### Why some of it is open, and some of it isn't

Security is **asymmetric combat under cost constraints**.

- An attacker only needs to find *one* working exploit.
- A defender has to cover *every* possible path.
- The defender's cost is therefore structurally higher than the attacker's.
- The only way defense wins is to raise the attacker's cost above the
  attacker's expected reward (or above the return the attacker could get
  from an easier target).

That fact dictates what we open-source and what we keep closed:

| Open-sourced (this repo)                  | Why                                            |
| ----------------------------------------- | ---------------------------------------------- |
| Scanner for known vulnerabilities         | Every user who patches = one fewer free kill   |
| Red-team attack catalog and runner        | Lets defenders *measure* their exposure        |
| Integration clients (plugin, skill, SDK)  | Low value to an attacker                       |

| Kept proprietary                          | Why                                            |
| ----------------------------------------- | ---------------------------------------------- |
| Detection rules and runtime policy engine | Publishing them tells attackers how to evade   |
| Threat-intelligence ingestion pipeline    | Publishing it tells attackers what we see      |
| Defense models and scoring                | Publishing them lets attackers train against   |

In short: we open-source **what helps you find problems** and we keep closed
**what helps us stop them**. Both halves raise the attacker's cost. For the
longer argument see [docs/PHILOSOPHY.md](docs/PHILOSOPHY.md).

### What you get out of it

- A report of the known-bad components on your machine, if any.
- A score and a list of attacks your agent fell for, if any.
- An easy integration path if you're building an agent and want it covered
  at runtime.

---

## 🤖 For Agents

You are reading this because a human handed you this repository's URL and
asked you to audit agent security. The subject of that audit may be **you
yourself** (self-exam), **another agent on the same machine** (peer exam,
e.g., you are Claude Code checking an OpenClaw install), or **a remote
agent endpoint** the human gave you. Clarify which if the request is
ambiguous.

Follow the steps below. Prefer machine-readable output (`--json`) when
composing results. Assume the human wants a short summary; don't dump raw
JSON at them.

### Bootstrap

```bash
git clone https://github.com/openguardrails/openguardrails-oss.git
cd openguardrails-oss
bun install
```

If `bun` is not installed: `curl -fsSL https://bun.sh/install | bash`. If you
cannot install Bun, stop and tell the human — do not silently fall back to
`node`.

### Commands

All commands are invoked as `bun src/cli.ts <subcommand>` or, after
`bun link`, as `openguardrails <subcommand>` / `ogr <subcommand>`.

#### `scan` — static health-check

```bash
ogr scan [--target <path>] [--json] [--severity <low|medium|high|critical>]
```

- Walks common agent install locations (`~/.claude`, `~/.cursor`,
  `~/.config/*mcp*`, project-local `.mcp.json`, etc.).
- Cross-references the offline knowledge base at
  `src/scan/knowledge-base.ts`.
- Exit codes: `0` clean, `2` findings below `--severity`, `3` findings at or
  above `--severity`, `1` tool error.

#### `redteam` — dynamic red-team run

```bash
ogr redteam --target <url-or-cmd> [--suite <name>] [--json] [--max <n>]
```

- `--target` is either an HTTP endpoint that accepts
  `POST { "prompt": "..." }` returning `{ "response": "..." }`, or a shell
  command that reads a prompt from stdin and writes the agent's answer to
  stdout.
- Suites are defined in `src/redteam/attacks.ts`. Default suite is
  `core-prompt-injection`.
- Each attack has a detector; a hit counts as a failure for the target.
- Exit code reflects failures (same scheme as `scan`).

#### `integrate` — emit an integration artifact

```bash
ogr integrate skill       > openguardrails.skill.md
ogr integrate plugin      > moltguard.plugin.json
ogr integrate sdk         # prints SDK usage snippet
```

### Output contract

With `--json`, every command prints one JSON object to stdout:

```jsonc
{
  "tool": "openguardrails-oss",
  "version": "0.1.0",
  "command": "scan",
  "startedAt": "2026-04-17T12:00:00Z",
  "finishedAt": "2026-04-17T12:00:04Z",
  "findings": [
    {
      "id": "OGR-KB-0001",
      "severity": "high",
      "title": "...",
      "location": "...",
      "evidence": "...",
      "remediation": "..."
    }
  ],
  "summary": { "total": 1, "bySeverity": { "high": 1 } }
}
```

Do not paraphrase `severity` fields; preserve them verbatim when reporting
to the human.

### When to escalate to the human

- Any `critical` finding — stop, report immediately, do not auto-remediate.
- A `redteam` failure that indicates the target agent leaked filesystem
  contents or executed an attacker-supplied shell command.
- Missing permissions to read `~/.claude` or similar — ask; do not sudo.

### What you should *not* do

- Do not commit scan reports back into the user's repo unless asked —
  they contain paths and may contain sensitive strings.
- Do not run `redteam` against a target you were not explicitly told to
  test. The attack suite is designed to be loud in logs.
- Do not "improve" the knowledge base by adding speculative entries.

---

## Project layout

```
src/
  cli.ts                 # CLI entry — scan / redteam / integrate
  index.ts               # library entry
  scan/                  # static scanner + offline knowledge base
  redteam/               # attack runner + attack catalog
  integrations/
    sdk.ts               # TypeScript SDK for agent developers
    moltguard/           # plugin for OpenClaw-family agents
    skill/               # portable skill package for tool-using LLMs
  utils/
skills/
  openguardrails/        # drop-in skill directory for Claude Code etc.
docs/
  PHILOSOPHY.md          # why we open-source what we open-source
  AGENT.md               # extended agent-facing playbook
```

## Contributing

Contributions to the **attack catalog** (`src/redteam/attacks.ts`) and
**knowledge base** (`src/scan/knowledge-base.ts`) are especially welcome —
that is the half of the work that scales with community eyes. See
[docs/PHILOSOPHY.md](docs/PHILOSOPHY.md) before proposing anything on the
defensive side; we will most likely redirect it to the closed-source
product.

## License & contact

Apache-2.0. See [LICENSE](LICENSE).

- Website: https://openguardrails.com
- Author: [@thomas-security](https://github.com/thomas-security) ·
  thomas@openguardrails.com
- Organization: OpenGuardrails.com

## About @OpenGuardrails/MoltGuard

**The most downloaded security skill on OpenClaw [ClawHub](https://clawhub.ai/thomas-security/moltguard)** — protect every action your openclaw takes.

<img width="1144" height="883" alt="image" src="https://github.com/user-attachments/assets/9b6d80f2-dde9-4467-b9e7-2f514e8b01cd" />
