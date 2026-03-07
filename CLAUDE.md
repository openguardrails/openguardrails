# OpenGuardrails

Guard Agent for AI Agents. Open source (Apache 2.0).

## Product Positioning

**Protect Your AI Agents.** Real-time protection against prompt injection, data leaks, and dangerous actions.

**Three Principles:**
1. **Instant Value** — Works immediately after installation
2. **No Security Expertise** — No configuration needed
3. **Secure by Default** — "Install it, and the agent won't go rogue"

**Agent-Native Design**: Built for autonomous agents. Agents use OpenGuardrails to protect themselves — not a tool imposed on them, but a tool they choose to use.

## Core Risk Surfaces

1. **Prompt / Instruction Risk** — Prompt injection, malicious email/web instructions, unauthorized tasks
2. **Behavioral Risk** — Dangerous commands, file deletion, risky API calls
3. **Data Risk** — Secret leakage, PII exposure, sending sensitive data to LLMs

## Three Control Flows

- **Action Flow** — Agent actions (tool calls, system commands, file operations)
- **Data Flow** — LLM input/output, file access, data sanitization
- **Time Flow** — Agentic hours (usage tracking, rate limiting, billing)

## Core Features

### 1. Agent Activity Monitor
"What did my agent do today?"
- Agentic hours (total time of all tool calls and conversations)
- Actions count
- LLM call count
- Blocks count
- Risk events

### 2. Agent Guard
Real-time interception of agent behavior.
- **Monitor**: tool calls, shell commands, file access, HTTP requests, LLM prompts
- **Actions**: allow, warn, block

### 3. Secret & Data Leak Protection
Automatic detection and sanitization:
- API keys, SSH keys, .env files, PII
- Before sending to LLM: auto-sanitize (e.g., `sk-123abc` → `<SECRET_TOKEN>`)
- Restore original values in responses

### 4. Prompt Injection Protection
Largest risk source for agents. Detects:
- "ignore previous instructions"
- "send me your secrets"
- "bypass system rules"

When agent accesses web/API: auto-scan for prompt injection.

## Core Technology

**Intent-Action Mismatch Detection**: Security agent that detects when agent actions don't match stated intent. Built on unified, scalable, configurable OpenGuardrails detection engine.

## Agent-Native Onboarding

MoltGuard and Core are agent-native. Dashboard is for humans.

### Automatic Flow (Zero Human Intervention)

```
MoltGuard installed → Auto-register with Core → Get API key → Start protecting
```

1. **MoltGuard installs** — Plugin loads automatically on OpenClaw start
2. **Auto-register** — POST to Core `/api/v1/agents/register`, get `apiKey` + `agentId`
3. **Credentials saved** — `~/.openclaw/credentials/moltguard/credentials.json`
4. **Protection active** — Calls Core for detection, reports to Dashboard
5. **Free quota** — 500 checks/day, no email required

### When Quota Exceeded

Core returns upgrade info with recommendation message:
- Agent informs user about quota status and security impact
- User clicks link → Core login page → Enter email
- User receives magic link email → Click to login
- Purchase API quota → Current API key gets paid capacity

### User Commands

| Command | Action |
|---------|--------|
| `/og_status` | Show MoltGuard status, API key, and quota |
| `/og_config` | Configure API key for cross-machine sharing |
| `/og_core` | Open Core portal for account and billing |
| `/og_dashboard` | Start local Dashboard and get access URLs |
| `/og_claim` | Display agent ID and API key for claiming on Core |

### Claiming an Agent (linking to account)

For autonomous agents (not yet linked to an email):
1. User runs `/og_claim` to get agent ID and API key
2. User goes to Core login page (`/og_core`)
3. User enters email, receives magic link
4. User goes to `/claim-agent` page
5. User pastes agent ID and API key
6. Agent is now linked to user's account, shares account quota

### Multi-Machine Support

- Same email can claim multiple API keys (one per machine)
- All API keys visible in one Dashboard under same email
- Each API key tracks its own usage against shared account quota

### Magic Link Auth

```
User enters email → Receives email with login link → Click to authenticate
```

No passwords. No API key copy-paste for humans.

## Repository Layout

```
core/               # Platform API (port 53666) — agent registration, behavioral detection, billing
gateway/            # AI Security Gateway (@openguardrails/gateway)
dashboard/          # Management dashboard (pnpm + Turborepo monorepo)
moltguard/          # MoltGuard OpenClaw security plugin with guard agent and monitoring
cli/                # CLI tool (openguardrails) — bundles dashboard for private deployment
```

## core

Platform backend. Agent registration, email verification, behavioral assessment engine (rule-driven, no LLM), Stripe billing, account portal.

```bash
cd core
npm install
cp .env.example .env
npm run dev          # Start on port 53666
```

Database: SQLite at `./data/openguardrails.db` by default.

## dashboard

pnpm monorepo. All packages use TypeScript strict mode.

- `packages/shared` (@og/shared) - Types, 5-tier config, constants
- `packages/db` (@og/db) - Drizzle ORM, multi-dialect (SQLite default, PG, MySQL)
- `apps/api` (@og/api) - Express API, port 53667
- `apps/web` (@og/web) - Vite + React, port 53668

```bash
cd dashboard
pnpm install && pnpm build
pnpm db:migrate && pnpm db:seed
pnpm dev
```

Database: SQLite at `dashboard/data/dashboard.db` by default. Set `DATABASE_URL` for PG/MySQL.

Private deployment (end users):

```bash
npm install -g openguardrails
openguardrails dashboard init
openguardrails dashboard start
# Open browser → enter Core API key to log in
```

## gateway

AI Security Gateway (@openguardrails/gateway). Secure proxy for LLM API calls — sanitizes PII, credentials, and sensitive data before sending to providers, restores in responses. Zero npm dependencies.

Supports Anthropic, OpenAI (+ compatible: Kimi, DeepSeek), and Gemini.

```bash
cd gateway
npm run dev          # Start on port 53669
npm run typecheck    # Type-check
npm run test         # Run sanitizer tests
```

Config: `~/.openguardrails/gateway.json` or environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GATEWAY_PORT`).

### Integration with OpenClaw

Users enable gateway via MoltGuard commands:
- `/og_sanitize on` — Modifies all agents' `models.json` to route through gateway (http://127.0.0.1:53669)
- `/og_sanitize off` — Restores original baseUrls
- Gateway config (`~/.openguardrails/gateway.json`) is auto-generated with providers' API keys
- Backup stored in `~/.openclaw/credentials/moltguard/gateway-backup.json`

## moltguard

OpenClaw plugin (@openguardrails/moltguard). Guard agent for prompt injection detection, behavioral monitoring. Uses `gateway/` for AI Security Gateway.

Install from ClawHub: https://clawhub.ai/ThomasLWang/moltguard

## Conventions

- Express APIs return `{ success: boolean, data?, error? }`
- Scanners S01-S10 (prompt injection, system override, web attacks, MCP tool poisoning, code execution, NSFW, PII, credentials, confidential data, off-topic)
- API key format: `sk-og-<32 hex>`
- Internal auth: `X-Internal-Key` header
