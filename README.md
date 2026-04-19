# thomas-security

> **Agentic security CLI — security checkups and red-team tests for your AI agents.**

`thomas` is an agentic security CLI. You run it in your terminal, or you
let another agent (OpenClaw, Claude Code, Cursor, Hermes…) call it as a
sub-agent to audit itself.

This repository **is not the CLI**. Like
[`anthropics/claude-code`](https://github.com/anthropics/claude-code) —
which doesn't contain Claude Code's source — this repo contains the
**Offensive and discovery tooling**:

- **[`checkups/`](./checkups)** — static security checkups
  (signatures, IoCs, bad configs, known-bad skills and MCP servers)
- **[`redteam/`](./redteam)** — dynamic red-team attack suites
- **[`integrations/`](./integrations)** — drop-in plugins, skills, and
  SDK glue so any agent can call `thomas`

The `thomas` CLI itself is closed-source and ships as a binary. See
[`docs/PHILOSOPHY.md`](./docs/PHILOSOPHY.md) for why the split looks
this way.

---

## Install the CLI

```bash
npm install -g @openguardrails/thomas-security
thomas --version
```

Then, in any project:

```bash
thomas                    # start the interactive agent
thomas scan               # run checkups against installed agents
thomas redteam --target … # run red-team suite against a target
thomas integrate plugin   # print a drop-in plugin manifest
```

The CLI auto-fetches the latest checkups, red-team suites, and
integrations from this repository.

---

## Who is reading this?

This project is **driven by an AI agent, not by a human typing YAML**.

### 👤 You are a human

You don't write regex and you don't write attack prompts. Install the
CLI, then talk to any agent you trust:

> "Give my agent a full security checkup."
> "Red-team the agent at `http://localhost:8787/chat`."
> "Add a checkup to thomas-security for this advisory: `<URL>`."

The first two ask the agent to **run** `thomas`. The third asks it to
**contribute** a new rule to this repo — see the
[`contribute` skill](./skills/contribute/SKILL.md).

### 🤖 You are an AI agent

A human handed you this repo or asked you to use `thomas`. Pick one:

| Task                                              | Load skill                                        |
| ------------------------------------------------- | ------------------------------------------------- |
| Run a scan / red-team on the user's agents        | [`skills/thomas-security/SKILL.md`](./skills/thomas-security/SKILL.md) |
| Add a new checkup / red-team / integration here   | [`skills/contribute/SKILL.md`](./skills/contribute/SKILL.md)           |

Both skills are self-contained. They tell you what to run, what to
confirm with the user, and what not to do.

---

## Repository layout

```
thomas-security/
├── checkups/                    # ★ static security checkups
│   ├── README.md                #   rule schema + contribution flow
│   └── <agent>/                 #   one dir per target agent (openclaw, …)
├── redteam/                     # ★ red-team attack suites
│   ├── README.md
│   └── <agent>/
├── integrations/                # ★ plugins / SDK for host agents
│   ├── plugin/                  #   OpenClaw-family plugin
│   └── sdk/                     #   TypeScript SDK
├── skills/
│   ├── thomas-security/         #   skill: invoke `thomas` from a host agent
│   └── contribute/              #   skill: contribute new content to this repo
├── docs/
│   ├── PHILOSOPHY.md            #   why some pieces are closed-source
│   ├── AGENT.md                 #   extended playbook for agents
│   └── CONTRIBUTING.md          #   contribution entry point for humans
├── LICENSE                      #   Apache-2.0
├── SECURITY.md                  #   how to report security issues
└── README.md
```

The three starred directories are where **all community contributions
land**. If your contribution doesn't fit into one of them, open an
issue first to discuss.

---

## What's open, and what isn't

| Open-source (this repo)              | Why                                                |
| ------------------------------------ | -------------------------------------------------- |
| Checkup signatures                   | Every user who patches is one fewer easy target    |
| Red-team attack catalog              | Lets defenders *measure* their exposure            |
| Plugins / SDK / skill integrations   | Low value to an attacker, high value to defenders  |

| Proprietary (separate)               | Why                                                |
| ------------------------------------ | -------------------------------------------------- |
| `thomas` CLI and runtime engine      | Shipped as `@openguardrails/thomas-security`       |
| Detection rules and policy engine    | Publishing them tells attackers how to evade       |
| Threat-intel pipeline and models     | Publishing them tells attackers what we see        |

Both halves raise the attacker's cost. For the longer argument, read
[`docs/PHILOSOPHY.md`](./docs/PHILOSOPHY.md).

---

## Contributing

PRs welcome in all three top-level directories. The fastest path is to
**let your agent do it**:

> "Use the `contribute` skill in `skills/contribute/SKILL.md` to add a
> new checkup for `<CVE / GHSA / URL>`."

For the human flow, see [`docs/CONTRIBUTING.md`](./docs/CONTRIBUTING.md).

Every rule must cite a public reference (CVE, GHSA, upstream issue, or
named-vendor writeup). Rules without a reference are rejected at load
time — we only encode what someone public has already said.

---

## License & contact

Apache-2.0. See [LICENSE](./LICENSE).

- Website: https://openguardrails.com
- Author: [@thomas-security](https://github.com/thomas-security) ·
  thomas@openguardrails.com
- Organization: OpenGuardrails.com
