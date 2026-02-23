# OpenGuardrails

**Runtime Security for AI Agents.** Detects prompt injection, credential leakage, data exfiltration, and behavioral threats — in real time, before they execute.

OpenGuardrails wraps your AI agent with a security layer: the agent-side plugin intercepts every tool call and message, scans it against 10 threat detectors and a behavioral rule engine, and blocks or alerts before damage is done. A management dashboard gives you full visibility. An optional local gateway sanitizes sensitive data before it ever leaves your machine.

Open source (Apache 2.0). [Architecture →](docs/architecture.md)

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

### 2. Claim your account

MoltGuard will output a **claim link**. Open it in your browser, enter your email address and the verification code — you'll receive a confirmation email to complete activation.

That's it. Your agent is now protected and you have **30,000 free detections**.

### 3. View the dashboard

Sign in at [openguardrails.com/dashboard](https://www.openguardrails.com/dashboard) to see detected threats, agent behavior graphs, permission policies, and risk events.

---

## What It Detects

10 built-in scanners + a behavioral engine that watches tool call sequences:

**Content scanners:** Prompt injection · System override · Web attacks · MCP tool poisoning · Malicious code execution · NSFW · PII leakage · Credential leakage · Confidential data · Off-topic drift

**Behavioral patterns (cross-call):** File read → exfiltration · Credential access → external write · Shell exec after web fetch · Command injection · and more

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
