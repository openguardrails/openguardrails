# integrations/openclaw-plugin - OpenClaw Safety Plugin

Local safety plugin for OpenClaw with PII sanitization gateway, platform integration, and local dashboard.

## Architecture
- OpenClaw plugin extension (`index.ts`, `gateway-manager.ts`)
- `agent/` - Guard agent: config, runner, sanitizer, types
- `gateway/` - Local HTTP gateway for PII sanitization (:8900)
- `memory/` - Conversation memory management
- `platform-client/` - SDK for communicating with dashboard
- `dashboard/` - Local lightweight dashboard (:8901)

## Commands
```bash
npm run typecheck      # Type-check all code
npm run build          # Compile TypeScript
npm run test           # Run tests
npm run gateway        # Start local gateway
npm run dashboard      # Start local dashboard
```

## Key Concepts
- **Dual backend**: Supports dashboard (preferred) or legacy MoltGuard API
- **Local PII sanitization**: Content is sanitized before leaving the machine
- **Platform client**: Agent registration, heartbeat, detection requests, report upload
- **Dashboard**: Auto-refreshing local web UI showing detection stats

## Environment
```
OG_PLATFORM_URL=https://platform.openguardrails.com
OG_API_KEY=sk-og-...
GATEWAY_PORT=8900
DASHBOARD_PORT=8901
```

## Conventions
- TypeScript strict mode, ES2022 target, NodeNext modules
- No database - all state is in-memory or on dashboard
- Sensitive data never leaves local machine unsanitized
