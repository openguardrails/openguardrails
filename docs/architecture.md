# OpenGuardrails Architecture

## Overview

OpenGuardrails is a runtime security layer for AI agents. The system intercepts agent actions before they execute, scans for threats, and enforces behavioral policies.

```
                    ┌─────────────────────────────────┐
                    │         Your AI Agent            │
                    │    (e.g. OpenClaw + MoltGuard)   │
                    └──┬──────────────┬───────────┬───┘
                       │ behavioral   │observations│ LLM requests
                       │ assess       │            │ (optional)
                       ▼              ▼            ▼
              ┌──────────────┐  ┌──────────┐  ┌─────────────────┐
              │  Core        │  │Dashboard │  │  AI Security    │
              │  Behavioral  │  │Agent mgmt│  │  Gateway        │
              │  Detection + │  │risk graph│  │  PII sanitize   │
              │  Policy      │  │tool log  │  │  ↕              │
              └──────────────┘  └──────────┘  │  LLM Provider   │
                                              └─────────────────┘
```

## Components

### MoltGuard (OpenClaw Plugin)
Source: `moltguard/`
Package: `@openguardrails/moltguard`

The agent-side plugin. Intercepts tool calls and messages in real time, sends them to Core for scanning, and enforces block/allow/alert decisions before actions execute. Handles agent registration, activation, and quota tracking.

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
Self-hosted: `npm install -g openguardrails && openguardrails dashboard start`

Management UI. Monorepo (pnpm + Turborepo):

```
dashboard/
  apps/api/        # Express API (port 53667)
  apps/web/        # Vite + React (port 53668)
  packages/shared/ # Types, 5-tier config, constants (@og/shared)
  packages/db/     # Drizzle ORM, multi-dialect: SQLite/PG/MySQL (@og/db)
```

Features: agent list, identity management, permission policies, behavior graph, risk event log.

---

### AI Security Gateway
Source: `gateway/`
Package: `@openguardrails/gateway` (port 8900)

Local reverse proxy for LLM API calls. Sanitizes PII, credentials, and secrets from prompts before they leave the machine, and restores original values in responses. Zero npm dependencies. Supports Anthropic, OpenAI (+ compatible: Kimi, DeepSeek), and Gemini.

---

### CLI
Source: `cli/`
Package: `openguardrails`

Bundles the dashboard (API + pre-built frontend) for private deployment. Has zero workspace dependencies — uses esbuild to bundle everything, spawns child processes at runtime. User data lives at `~/.openguardrails/`.

---

## Data Flow

**Normal agent request (hosted):**

```
Agent tool call
  → MoltGuard intercepts
  → POST /api/v1/behavior/assess to Core  (behavioral rules, S01–S10 scanners)
  → Core returns decision (block/alert/allow)
  → MoltGuard enforces decision
  → POST /api/observations to Dashboard   (non-blocking, records tool call)
  → (if allowed) tool call executes
```

**With AI Security Gateway (local):**

```
Agent LLM request
  → Gateway receives (localhost:8900)
  → Scans & strips PII/credentials from prompt
  → Forwards sanitized request to LLM provider
  → LLM response arrives
  → Gateway restores original values
  → Returns clean response to agent
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

## Contributing

The open-source components (Dashboard, Gateway, MoltGuard, CLI) can each be developed independently. Core is a hosted service and its source is not public.

```bash
# Dashboard (full stack)
cd dashboard && pnpm install && pnpm build && pnpm db:migrate && pnpm dev

# Gateway
cd gateway && npm run dev

# MoltGuard plugin
cd moltguard
```

API conventions:
- All Express endpoints return `{ success: boolean, data?, error? }`
- API key format: `sk-og-<32 hex>`
- Internal service auth: `X-Internal-Key` header
- All URL config vars named `coreUrl` / `CORE_URL`
