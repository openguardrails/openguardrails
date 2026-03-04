# dashboard - OpenGuardrails Management Dashboard

Human-facing management dashboard for monitoring and managing AI agents.

## Philosophy

**Dashboard is designed for humans, not agents.**

- Humans use Dashboard to monitor agent behavior, view detections, and set policies
- Agents report observations to Dashboard, but don't "use" it
- This contrasts with Core, which is designed for autonomous agent use

**Dashboard and Core are independent systems:**

- Dashboard can be self-hosted (private deployment) or use our SaaS
- Core API key (`sk-og-xxx`) is the universal credential:
  - MoltGuard uses it to authenticate with Core (behavioral detection)
  - MoltGuard uses it to report observations to Dashboard
  - Humans use it to log into Dashboard and view their agents
- Dashboard does NOT have its own user accounts — it trusts Core API keys

## Core Feature: Agent Activity Monitor

"What did my agent do today?"

| Metric | Description |
|--------|-------------|
| **Agentic Hours** | Total time of all tool calls and conversations |
| **Actions** | Number of tool calls executed |
| **LLM Calls** | Number of LLM API calls |
| **Blocks** | Number of blocked actions |
| **Risk Events** | Security events detected |

## Architecture
- pnpm monorepo with Turborepo
- `packages/shared` (@og/shared) - Types, 5-tier config, utilities
- `packages/db` (@og/db) - Drizzle ORM schema + query modules (SQLite default, PG/MySQL optional)
- `packages/cli` (@openguardrails/cli) - CLI for one-command install and management
- `apps/api` (@og/api) - Express API on port 3001
- `apps/web` (@og/web) - Next.js 14 frontend on port 3000

## Key Concepts
- **5-tier subscriptions**: free / starter / pro / business / enterprise
- **Feature gating**: discovery + detection (all), protection (business+), governance (enterprise)
- **Agent management**: Register, monitor, and manage AI agents
- **Policy engine**: Block/alert/log actions based on scanner results
- **Detection proxy**: `/api/detect` validates auth → checks quota → calls core → applies policies → logs results

## Commands
```bash
pnpm install         # Install all dependencies
pnpm build           # Build all packages
pnpm dev             # Dev mode for all services
pnpm db:generate     # Generate Drizzle migrations
pnpm db:migrate      # Run migrations
pnpm db:seed         # Seed default scanners
```

## Database
SQLite by default, PostgreSQL/MySQL optional via `DB_DIALECT` env var or `DATABASE_URL` scheme. Drizzle ORM with dialect-specific schemas. Tables: settings, agents, scanner_definitions, policies, usage_logs, detection_results.

## Environment
See `.env.example`. Key vars: DATABASE_URL, API_PORT, OG_CORE_URL.

## Conventions
- TypeScript strict mode
- Express APIs return `{ success: boolean, data?, error? }`
- API key format: `sk-og-<32 hex>`
- Auth: Core API key in `Authorization: Bearer sk-og-xxx` header (no JWT, no local users)
