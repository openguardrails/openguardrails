# OpenGuardrails

Guard Agent for AI Agents. Open source (Apache 2.0).

## Repository Layout

```
gateway/            # AI Security Gateway (@openguardrails/gateway)
dashboard/          # Management dashboard (pnpm + Turborepo monorepo)
openclaw-security/  # OpenClaw security plugin with guard agent and monitoring
```

## dashboard

pnpm monorepo. All packages use TypeScript strict mode.

- `packages/shared` (@og/shared) - Types, 5-tier config, constants
- `packages/db` (@og/db) - Drizzle ORM, multi-dialect (SQLite default, PG, MySQL)
- `packages/cli` (@openguardrails/cli) - CLI tool
- `apps/api` (@og/api) - Express API, port 53667
- `apps/web` (@og/web) - Next.js 14, port 53668

```bash
cd dashboard
pnpm install && pnpm build
pnpm db:migrate && pnpm db:seed
pnpm dev
```

Database: SQLite at `dashboard/data/openguardrails.db` by default. Set `DATABASE_URL` for PG/MySQL.

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

## openclaw-security

OpenClaw plugin (@openguardrails/openguardrails). Guard agent for prompt injection detection, monitoring dashboard on port 8901. Uses `gateway/` for AI Security Gateway.

## Conventions

- Express APIs return `{ success: boolean, data?, error? }`
- Scanners S01-S10 (prompt injection, system override, web attacks, MCP tool poisoning, code execution, NSFW, PII, credentials, confidential data, off-topic)
- API key format: `sk-og-<32 hex>`
- Internal auth: `X-Internal-Key` header
