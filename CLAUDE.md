# OpenGuardrails

Guard Agent for AI Agents. Open source (Apache 2.0).

## Repository Layout

```
dashboard/          # Management dashboard (pnpm + Turborepo monorepo)
integrations/       # Client plugins
  openclaw-plugin/  # OpenClaw plugin with local PII gateway
```

## dashboard

pnpm monorepo. All packages use TypeScript strict mode.

- `packages/shared` (@og/shared) - Types, 5-tier config, constants
- `packages/db` (@og/db) - Drizzle ORM, multi-dialect (SQLite default, PG, MySQL)
- `packages/cli` (@openguardrails/cli) - CLI tool
- `apps/api` (@og/api) - Express API, port 3001
- `apps/web` (@og/web) - Next.js 14, port 3000

```bash
cd dashboard
pnpm install && pnpm build
pnpm db:migrate && pnpm db:seed
pnpm dev
```

Database: SQLite at `dashboard/data/openguardrails.db` by default. Set `DATABASE_URL` for PG/MySQL.

## integrations/openclaw-plugin

OpenClaw plugin (@openguardrails/moltguard). Local PII sanitization gateway on port 8900, monitoring dashboard on port 8901.

## Conventions

- Express APIs return `{ success: boolean, data?, error? }`
- Scanners S01-S10 (prompt injection, system override, web attacks, MCP tool poisoning, code execution, NSFW, PII, credentials, confidential data, off-topic)
- API key format: `sk-og-<32 hex>`
- Internal auth: `X-Internal-Key` header
