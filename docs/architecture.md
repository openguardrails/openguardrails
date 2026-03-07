# OpenGuardrails Architecture

## Overview

OpenGuardrails is a runtime security layer for AI agents. The system intercepts agent actions before they execute, scans for threats, and enforces behavioral policies.

```
                    ┌─────────────────────────────────┐
                    │         Your AI Agent            │
                    │    (e.g. OpenClaw + MoltGuard)   │
                    └──┬──────────────┬───────────────┘
                       │ behavioral   │ LLM requests
                       │ assess       │ (sanitized)
                       ▼              ▼
              ┌──────────────┐  ┌─────────────────┐
              │  Core        │  │  AI Security    │
              │  Behavioral  │  │  Gateway        │
              │  Detection + │  │  (embedded)     │
              │  Policy      │  │  PII sanitize   │
              └──────────────┘  │  ↕              │
                                │  LLM Provider   │
                                └─────────────────┘
                                        │
                                        ▼
                                ┌──────────────┐
                                │  Dashboard   │
                                │  (embedded)  │
                                │  agent mgmt  │
                                │  risk graph  │
                                └──────────────┘
```

## Components

### MoltGuard (OpenClaw Plugin)
Source: `moltguard/`
Package: `@openguardrails/moltguard`

The agent-side plugin that runs everything locally. Intercepts tool calls and messages in real time, sends them to Core for scanning, and enforces block/allow/alert decisions before actions execute.

**Embedded components:**
- **AI Security Gateway** — Sanitizes PII/credentials before LLM calls (port 53669)
- **Dashboard** — Local web UI for monitoring and configuration (ports 53667/53668)

Install via ClawHub: `npx clawhub@latest install moltguard`

---

### OpenGuardrails Core
Hosted: `https://www.openguardrails.com/core`

The detection and policy engine — a hosted service (similar to an LLM API, source not public). Runs 10 content scanners (S01–S10) and a behavioral assessment engine that evaluates tool call sequences against a rule hierarchy. Returns `block / alert / allow` decisions with explanations. No LLM involved — fully rule-driven for determinism and speed.

Handles: agent registration, email verification, API key issuance, Stripe billing, and account management.

---

### Dashboard
Source: `dashboard/`
Hosted: `https://www.openguardrails.com/dashboard`

Management UI. Monorepo (pnpm + Turborepo):

```
dashboard/
  apps/api/        # Express API (port 53667)
  apps/web/        # Vite + React (port 53668)
  packages/shared/ # Types, 5-tier config, constants (@og/shared)
  packages/db/     # Drizzle ORM, multi-dialect: SQLite/PG/MySQL (@og/db)
```

Features: agent list, identity management, permission policies, behavior graph, risk event log, gateway activity monitoring.

The dashboard runs **embedded** in the MoltGuard plugin process — no separate CLI tool needed.

---

### AI Security Gateway
Source: `gateway/`
Package: `@openguardrails/gateway` (port 53669)

Local reverse proxy for LLM API calls. Sanitizes PII, credentials, and secrets from prompts before they leave the machine, and restores original values in responses. Zero npm dependencies. Supports Anthropic, OpenAI (+ compatible: Kimi, DeepSeek, vLLM), and Gemini.

The gateway runs **embedded** in the MoltGuard plugin process. Users enable it via `/og_sanitize on`.

---

## Data Flow

**Normal agent request (with Core detection):**

```
Agent tool call
  → MoltGuard intercepts
  → POST /api/v1/behavior/assess to Core  (behavioral rules, S01–S10 scanners)
  → Core returns decision (block/alert/allow)
  → MoltGuard enforces decision
  → Report to Dashboard (non-blocking)
  → (if allowed) tool call executes
```

**With AI Security Gateway (data sanitization):**

```
Agent LLM request
  → Gateway receives (localhost:53669)
  → Scans & replaces PII/credentials with placeholders
  → Forwards sanitized request to LLM provider
  → LLM response arrives
  → Gateway restores original values
  → Returns clean response to agent
  → Activity logged to Dashboard
```

---

## Scanners

| ID | Scanner | Detects |
|----|---------|---------|
| S01 | Prompt Injection | Crafted inputs hijacking agent behavior |
| S02 | System Override | Attempts to bypass safety boundaries |
| S03 | Web Attacks | XSS, CSRF, web exploits targeting agent APIs |
| S04 | MCP Tool Poisoning | Malicious tool definitions in MCP integrations |
| S05 | Malicious Code Execution | Harmful code via interpreters/sandboxes |
| S06 | NSFW Content | Explicit content, minor protection (12 risk categories) |
| S07 | PII Exposure | Personally identifiable information leakage |
| S08 | Credential Leakage | API keys, tokens, passwords in agent I/O |
| S09 | Confidential Data | Trade secrets and proprietary information |
| S10 | Off-Topic Drift | Agent misuse for unauthorized tasks |

## Behavioral Rules

The Core behavioral engine evaluates tool call sequences — not just individual calls. Example patterns it blocks:

| Severity | Pattern |
|----------|---------|
| Critical | Sensitive file read → network exfiltration |
| Critical | Credential access → external domain write |
| High | Shell exec after web fetch |
| High | Command injection in shell args |
| Medium | Sensitive path access without clear intent |

---

## Repository Layout

```
moltguard/          # MoltGuard OpenClaw plugin (includes embedded gateway + dashboard)
gateway/            # AI Security Gateway source (@openguardrails/gateway)
dashboard/          # Management dashboard (pnpm + Turborepo monorepo)
```

Note: The `cli/` directory has been removed — dashboard and gateway are now embedded in the MoltGuard plugin.

---

## Contributing

The open-source components (Dashboard, Gateway, MoltGuard) can each be developed independently. Core is a hosted service and its source is not public.

```bash
# Dashboard (full stack)
cd dashboard && pnpm install && pnpm build && pnpm db:migrate && pnpm dev

# Gateway
cd gateway && npm run dev

# MoltGuard plugin
cd moltguard && npm run build
```

API conventions:
- All Express endpoints return `{ success: boolean, data?, error? }`
- API key format: `sk-og-<32 hex>`
- Internal service auth: `X-Internal-Key` header
- All URL config vars named `coreUrl` / `CORE_URL`
