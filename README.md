# OpenGuardrails

**#1 OpenClaw security plugin on [ClawHub](https://clawhub.ai/ThomasLWang/moltguard)** protect your OpenClaw with real-time defense against prompt injection, data leaks, and dangerous actions.

**Three Principles:**
- **Instant Value** — Works immediately after installation
- **No Security Expertise** — No configuration needed
- **Secure by Default** — "Install it, and the agent won't go rogue"

Open source (Apache 2.0). 

---

## What It Does

| Feature | Description |
|---------|-------------|
| **Agent Activity Monitor** | Track agentic hours, actions, LLM calls, blocks, and risk events |
| **Agent Guard** | Real-time interception of tool calls, shell commands, file access, HTTP requests |
| **Secret & Data Leak Protection** | Auto-sanitize API keys, SSH keys, PII before sending to LLMs |
| **Prompt Injection Protection** | Detect and block "ignore instructions", "send secrets", "bypass rules" attacks |

---

## Quick Start

### 1. Install MoltGuard

Run this in your terminal to install the MoltGuard OpenClaw skill:

```bash
npx clawhub@latest install moltguard
```

Then ask OpenClaw to install and activate it:

```
Install and activate moltguard
```

### 2. Start protecting

MoltGuard auto-registers with Core and starts protecting immediately — no email required.

That's it. Your agent is now protected with **500 free checks/day**.

To upgrade or link to your account, run `/og_core` to open the portal, enter your email, and click the magic link.

### 3. View the dashboard

Sign in at [openguardrails.com/dashboard](https://www.openguardrails.com/dashboard) to see detected threats, agent behavior graphs, permission policies, and risk events.

### Commands

| Command | Action |
|---------|--------|
| `/og_status` | Show status, API key, and quota |
| `/og_config` | Configure API key for cross-machine sharing |
| `/og_core` | Open Core portal for account and billing |
| `/og_dashboard` | Start local Dashboard |
| `/og_claim` | Display agent ID and API key for claiming |

---

## Core Risk Surfaces

1. **Prompt / Instruction Risk** — Prompt injection, malicious email/web instructions, unauthorized tasks
2. **Behavioral Risk** — Dangerous commands, file deletion, risky API calls
3. **Data Risk** — Secret leakage, PII exposure, sending sensitive data to LLMs

## Detection Engine

10 built-in scanners + intent-action mismatch detection:

**Content scanners:** Prompt injection · System override · Web attacks · MCP tool poisoning · Malicious code execution · NSFW · PII leakage · Credential leakage · Confidential data · Off-topic drift

**Behavioral patterns:** File read → exfiltration · Credential access → external write · Shell exec after web fetch · Intent-action mismatch · and more

See [architecture.md](docs/architecture.md#scanners) for the full list.

---

## Self-Hosted Options

The detection engine (Core) is a hosted service — the rest can be self-hosted:

**Private dashboard** — deploy locally, data stays in SQLite at `~/.openguardrails/`:
```bash
npm install -g openguardrails
openguardrails dashboard start
```

**AI Security Gateway** — sanitize PII and credentials locally before they reach any LLM provider:
```bash
npm install -g @openguardrails/gateway
openguardrails gateway start
# Point OpenClaw base URL to http://localhost:8900
```

---


## License

Apache License 2.0. See [LICENSE](LICENSE) for details.
