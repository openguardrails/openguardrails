# OpenGuardrails

Guard Agent for AI Agents. Open source (Apache 2.0).

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

Database: SQLite at `dashboard/data/openguardrails.db` by default. Set `DATABASE_URL` for PG/MySQL.

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
npm run dev          # Start on port 8900
npm run typecheck    # Type-check
npm run test         # Run sanitizer tests
```

Config: `~/.openguardrails/gateway.json` or environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GATEWAY_PORT`).

## moltguard

OpenClaw plugin (@openguardrails/moltguard). Guard agent for prompt injection detection, behavioral monitoring. Uses `gateway/` for AI Security Gateway.

Install from ClawHub: https://clawhub.ai/ThomasLWang/moltguard

## Conventions

- Express APIs return `{ success: boolean, data?, error? }`
- Scanners S01-S10 (prompt injection, system override, web attacks, MCP tool poisoning, code execution, NSFW, PII, credentials, confidential data, off-topic)
- API key format: `sk-og-<32 hex>`
- Internal auth: `X-Internal-Key` header
