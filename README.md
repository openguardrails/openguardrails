# OpenGuardrails v6

**Runtime Security for AI Agents** — Protect AI agents from data exfiltration, prompt injection, sensitive data leakage, credential theft, command injection, and harmful content.

OpenGuardrails is an open-source security framework for AI agents. It monitors agent behavior in real time, blocks malicious tool call patterns before they execute, sanitizes sensitive data before it reaches LLM providers, and gives you full visibility through an account portal and management dashboard.

## Versions

| Version | Branch | Status | Description |
|---------|--------|--------|-------------|
| **v6** | `main` | Active | New architecture — Core platform, Gateway, OpenClaw plugin |
| **v5** | `v5` | LTS | Stable legacy version |

v6 is a complete rewrite. If you need the previous version: `git checkout v5`

## What It Protects Against

### Behavioral Threat Detection

The Core behavioral engine evaluates tool call sequences against a rule hierarchy and returns block/alert/allow decisions with explanations:

| Risk Level | Action | Threats |
|------------|--------|---------|
| **Critical** | Block | Sensitive file read followed by network exfiltration, credential access + external domains |
| **High** | Block | Shell escape / command injection, credential access with intent mismatch, shell exec after web fetch |
| **Medium** | Alert | Sensitive path access without clear intent, external domains outside expected scope |

### 10 Built-in Content Scanners

| ID | Scanner | What it catches |
|----|---------|----------------|
| S01 | Prompt Injection | Crafted inputs that hijack agent behavior |
| S02 | System Override | Attempts to bypass safety boundaries |
| S03 | Web Attacks | XSS, CSRF, and web exploits targeting agent APIs |
| S04 | MCP Tool Poisoning | Malicious tool definitions in MCP integrations |
| S05 | Malicious Code Execution | Harmful code via interpreters and sandboxes |
| S06 | NSFW Content | Explicit or inappropriate content, minor protection (12 risk categories) |
| S07 | PII Exposure | Personally identifiable information leakage |
| S08 | Credential Leakage | API keys, tokens, passwords in agent I/O |
| S09 | Confidential Data | Trade secrets and proprietary information |
| S10 | Off-Topic Drift | Agent misuse for unauthorized tasks |

### Data Leakage Prevention

The AI Security Gateway sanitizes PII, credentials, and secrets from prompts before they leave the machine, and restores original values in responses. Zero npm dependencies.

## Architecture

```
openguardrails/
  core/                   # Platform API (port 53666)
  gateway/                # AI Security Gateway (port 8900)
  dashboard/              # Management dashboard (pnpm monorepo)
    apps/
      api/                #   Express API (port 53667)
      web/                #   React frontend (port 53668)
    packages/
      shared/             #   Types, config, constants
      db/                 #   Drizzle ORM (SQLite/PG/MySQL)
      cli/                #   CLI tool
  openclaw-security/      # OpenClaw plugin
```

### core

The platform backend. Handles the full agent lifecycle:

- **Agent registration** — `POST /api/v1/agents/register` returns API key, claim URL, verification code
- **Claim & activation** — email verification flow, activates agent after email confirmed
- **Behavioral assessment** — `POST /api/v1/behavior/assess` evaluates tool chains against risk rules
- **Account portal** — web UI at `/login` and `/account` for managing agents, viewing quota, upgrading plans
- **Billing** — Stripe integration for paid plans
- **Quota tracking** — per-account usage metering across all agents

### gateway

AI Security Gateway. A local HTTP proxy that sits between agents and LLM providers:

- Sanitizes PII, credentials, API keys, and secrets from prompts before sending to LLMs
- Restores original values in LLM responses
- Supports Anthropic, OpenAI (+ compatible: Kimi, DeepSeek), and Gemini
- Zero npm dependencies, runs locally

### dashboard

Management UI for detection results, scanner configuration, and security policies:

- **Database**: SQLite by default, PostgreSQL/MySQL optional
- **Policy engine**: block, alert, or log based on scanner results and sensitivity thresholds
- **Detection proxy**: routes content through Core's S01-S10 scanners

### openclaw-security

OpenClaw plugin that hooks into agent tool calls:

- Classifies every tool call in real time (file reads, network calls, shell commands)
- Fast-path blocks critical patterns locally — no cloud round-trip needed
- Sends medium+ risk signals to Core for behavioral assessment
- Sanitizes tool params before any data leaves the machine
- Exposes `/og_status` and `/og_activate` commands

## Quick Start

### Option A: OpenClaw Plugin (recommended)

Install the plugin directly in OpenClaw:

```bash
openclaw plugins install @openguardrails/openclaw-security
```

Then activate:
```bash
/og_activate
```

Follow the claim URL, enter the verification code and your email. After email verification, behavioral detection is active with 30,000 free checks.

### Option B: Self-hosted Platform

```bash
# 1. Clone
git clone https://github.com/openguardrails/openguardrails.git
cd openguardrails

# 2. Start Core API (port 53666)
cd core
npm install
npm run db:migrate
npm run dev

# 3. Start Dashboard (ports 53668 + 53667)
cd ../dashboard
pnpm install && pnpm build
pnpm db:migrate && pnpm db:seed
pnpm dev

# 4. Start Gateway (port 8900, optional)
cd ../gateway
npm run dev
```

Then point the OpenClaw plugin to your local instance:

```json
{
  "plugins": {
    "entries": {
      "openguardrails": {
        "config": {
          "coreUrl": "http://localhost:53666"
        }
      }
    }
  }
}
```

## User Flow

```
Install plugin → /og_activate → Visit claim URL → Enter code + email
→ Click email verification link → Agent active (30,000 free checks)
→ Sign in at /login with email + API key → View account, quota, agents
```

## Plans

| Plan | Price | Detections/mo |
|------|-------|---------------|
| Free | $0 | 30,000 |
| Starter | $19/mo | 100,000 |
| Pro | $49/mo | 300,000 |
| Business | $199/mo | 2,000,000 |

All agents registered under the same email share one account and quota pool.

## Configuration

### Core (`core/.env`)

```bash
PORT=53666
CORE_DB_PATH=./data/openguardrails.db
CORE_URL=http://localhost:53666     # Used in claim URLs and emails

# Email (leave SMTP_HOST blank to log to console in dev)
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=noreply@example.com
SMTP_PASS=<password>
SMTP_FROM=noreply@example.com

# Stripe (optional — leave blank to disable billing)
STRIPE_SECRET_KEY=sk_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

### Gateway (`~/.openguardrails/gateway.json`)

```json
{
  "port": 8900,
  "backends": {
    "anthropic": { "apiKey": "sk-ant-..." },
    "openai": { "apiKey": "sk-..." },
    "gemini": { "apiKey": "..." }
  }
}
```

### OpenClaw Plugin (`~/.openclaw/openclaw.json`)

```json
{
  "plugins": {
    "entries": {
      "openguardrails": {
        "config": {
          "enabled": true,
          "blockOnRisk": true,
          "coreUrl": "https://www.openguardrails.com/core",
          "apiKey": "",
          "agentName": "OpenClaw Agent",
          "timeoutMs": 60000
        }
      }
    }
  }
}
```

## API Conventions

- All endpoints return `{ success: boolean, data?, error? }`
- API key format: `sk-og-<32 hex>`
- Agent auth: `Authorization: Bearer sk-og-...`

## License

Apache License 2.0. See [LICENSE](LICENSE) for details.
