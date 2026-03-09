# moltguard - MoltGuard OpenClaw Security Plugin

Local safety plugin for OpenClaw with AI Security Gateway, platform integration, and local dashboard.

## Three Principles

1. **Instant Value** — Works immediately after installation
2. **No Security Expertise** — No configuration needed
3. **Secure by Default** — "Install it, and the agent won't go rogue"

## Core Features

| Feature | Description |
|---------|-------------|
| **Agent Guard** | Real-time interception of tool calls, shell commands, file access, HTTP requests |
| **Secret & Data Leak Protection** | Auto-sanitize API keys, SSH keys, PII before sending to LLMs |
| **Prompt Injection Protection** | Detect "ignore instructions", "send secrets", "bypass rules" attacks |

## Onboarding Flow

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
- Agent informs user about quota status
- User clicks link → Core login page → Enter email
- User receives magic link email → Click to login
- Purchase API quota → Current API key gets paid capacity

### User Commands

| Command | Action |
|---------|--------|
| `/og_status` | Show status, API key, and quota |
| `/og_sanitize on` | Enable AI Security Gateway for data sanitization |
| `/og_sanitize off` | Disable AI Security Gateway |
| `/og_sanitize` | Show gateway status |
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

## Architecture
- OpenClaw plugin extension (`index.ts`)
- `agent/` - Guard agent: config, behavior-detector, sanitizer, types
- `memory/` - Conversation memory management
- `platform-client/` - SDK for communicating with dashboard
- AI Security Gateway has been extracted to top-level `gateway/` package

## Commands
```bash
npm run typecheck      # Type-check all code
npm run build          # Compile TypeScript
npm run test           # Run tests
```

## Key Concepts
- **Core API**: All security detection is performed by Core (no local detection)
- **AI Security Gateway**: Content is sanitized before leaving the machine (e.g., `sk-123abc` → `<SECRET_TOKEN>`, restored in responses)
- **Platform client**: Agent registration, heartbeat, detection requests
- **Dashboard**: Local web UI showing detection stats, agentic hours, risk events
- **Intent-Action Mismatch**: Core technique — detect when agent actions don't match stated intent

## Environment
```
OG_CORE_URL=https://www.openguardrails.com/core
OG_API_KEY=sk-og-...
GATEWAY_PORT=38790
DASHBOARD_PORT=38789
```

## Conventions
- TypeScript strict mode, ES2022 target, NodeNext modules
- No database - all state is in-memory or on dashboard
- Sensitive data never leaves local machine unsanitized
