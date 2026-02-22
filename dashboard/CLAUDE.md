# dashboard - OpenGuardrails Management Dashboard

User-facing management dashboard with auth, multi-agent management, and web UI.

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
See `.env.example`. Key vars: DATABASE_URL, API_PORT, OG_CORE_URL, OG_CORE_KEY.

## Conventions
- TypeScript strict mode
- Express APIs return `{ success: boolean, data?, error? }`
- API key format: `sk-og-<32 hex>`
- JWT access tokens: 15min, refresh tokens: 30d
