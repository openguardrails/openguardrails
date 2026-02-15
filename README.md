# OpenGuardrails v6

**Guard Agent for AI Agents** - Detect, Secure, Deploy AI Agents for personal, business, and enterprise.

OpenGuardrails is an open-source security framework that protects AI agents from prompt injection, data leakage, and misuse. It scans every input and output through a configurable detection pipeline, enforces security policies, and gives you full visibility into what your agents are doing.

## Versions

| Version | Branch | Status | Description |
|---------|--------|--------|-------------|
| **v6** | `main` | Active | New architecture rewrite |
| **v5** | `v5` | LTS | Stable legacy version |

v6 is a complete rewrite with a new modular architecture. If you need the previous version:

```bash
git checkout v5
```

## 10 Built-in Security Scanners

| ID | Scanner | What it catches |
|----|---------|----------------|
| S01 | Prompt Injection | Crafted inputs that hijack agent behavior |
| S02 | System Override | Attempts to bypass safety boundaries |
| S03 | Web Attacks | XSS, CSRF, and web exploits targeting agent APIs |
| S04 | MCP Tool Poisoning | Malicious tool definitions in MCP integrations |
| S05 | Malicious Code Execution | Harmful code via interpreters and sandboxes |
| S06 | NSFW Content | Explicit or inappropriate content (12 risk categories) |
| S07 | PII Exposure | Personally identifiable information leakage |
| S08 | Credential Leakage | API keys, tokens, passwords in agent I/O |
| S09 | Confidential Data | Trade secrets and proprietary information |
| S10 | Off-Topic Drift | Agent misuse for unauthorized tasks |

## Project Structure

```
openguardrails/
  dashboard/              # Management dashboard (pnpm monorepo)
    apps/
      api/                # Express API (port 3001)
      web/                # Next.js frontend (port 3000)
    packages/
      shared/             # Types, config, utilities
      db/                 # Drizzle ORM (SQLite/PostgreSQL/MySQL)
      cli/                # CLI for one-command setup
  integrations/
    openclaw-plugin/      # OpenClaw plugin with local PII gateway
```

### dashboard

The management hub. Register agents, configure scanners, set security policies, and monitor detection results through a web UI.

- **Database**: SQLite by default, PostgreSQL/MySQL optional
- **5-tier model**: free / starter / pro / business / enterprise
- **Policy engine**: block, alert, or log based on scanner results

### integrations/openclaw-plugin

Client-side plugin for OpenClaw agents. Runs a local PII sanitization gateway (port 8900) that intercepts prompts before they reach LLMs, plus a monitoring dashboard (port 8901).

## Quick Start

```bash
# 1. Clone
git clone https://github.com/openguardrails/openguardrails.git
cd openguardrails/dashboard

# 2. Install
pnpm install

# 3. Build
pnpm build

# 4. Initialize database
pnpm db:migrate
pnpm db:seed

# 5. Start
pnpm dev
```

Dashboard runs at http://localhost:3000, API at http://localhost:3001.

## Configuration

Copy `.env.example` to `.env` in the `dashboard/` directory:

```bash
# Database (default: SQLite, no config needed)
# For PostgreSQL:
# DATABASE_URL=postgresql://user:pass@localhost:5432/og_dashboard

# For MySQL:
# DATABASE_URL=mysql://user:pass@localhost:3306/og_dashboard

# API
API_PORT=3001


## License

Apache License 2.0. See [LICENSE](LICENSE) for details.
