# OpenGuardrails

**Runtime Security for AI Agents** — Protect AI agents from data exfiltration, prompt injection, sensitive data leakage, credential theft, command injection, and harmful content.

OpenGuardrails is an open-source security framework for AI agents. It monitors agent behavior in real time, blocks malicious tool call patterns before they execute, sanitizes sensitive data before it reaches LLM providers, and gives you full visibility through a management dashboard.

## Quick Start (Recommended)

### 1. Install the OpenGuardrails skill from ClawHub

Visit [clawhub.ai/ThomasLWang/moltguard](https://clawhub.ai/ThomasLWang/moltguard) and install the skill into OpenClaw.

### 2. Activate

Run in OpenClaw:

```
/og_activate
```

OpenClaw will automatically register with the OpenGuardrails Core platform. You'll receive:
- A **claim URL** — open it in your browser, enter your email and the verification code
- A **verification email** — click the link to activate your agent
- **30,000 free security detection calls**

### 3. Try it out

After activation, you'll receive a **test email** designed to demonstrate OpenGuardrails' detection capabilities. Ask OpenClaw to read the email — you'll see OpenGuardrails detect and flag the security risks in real time.

### 4. View your dashboard

Sign in at [openguardrails.com/dashboard](https://www.openguardrails.com/dashboard) to view:
- **Agents** — all registered AI agents under your account
- **Identities** — email-based account and agent identity management
- **Permissions** — agent permission policies
- **Graph** — visual representation of agent behavior and tool call patterns
- **Risks** — detected threats, blocked actions, and security alerts

## What It Protects Against

### Behavioral Threat Detection

The Core behavioral engine evaluates tool call sequences against a rule hierarchy and returns block/alert/allow decisions with explanations:

| Risk Level | Action | Threats |
|------------|--------|---------|
| **Critical** | Block | Sensitive file read + network exfiltration, credential access + external domains |
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

## Self-Hosted Deployment

### Dashboard (Private Deployment)

Deploy the management dashboard locally — no need to use the hosted version:

```bash
npm install -g openguardrails
openguardrails dashboard init
openguardrails dashboard start
```

Open the dashboard in your browser and enter your Core API key to log in. All data is stored locally in SQLite at `~/.openguardrails/`.

### AI Security Gateway (Private Deployment)

Deploy the gateway locally to sanitize sensitive data before it reaches external LLM providers:

```bash
npm install -g @openguardrails/gateway
openguardrails gateway start
```

After starting the gateway:

1. Configure your LLM API keys in `~/.openguardrails/gateway.json`:

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

2. Point OpenClaw to use the gateway as its LLM base URL:

```
Base URL: http://localhost:8900
```

All prompts are sanitized locally before being sent to LLM providers. PII, credentials, and secrets are stripped on the way out and restored on the way back. Supports Anthropic, OpenAI (+ compatible: Kimi, DeepSeek), and Gemini.

### Self-Hosted Core (Full Private Deployment)

For fully air-gapped or private deployments, you can also self-host the Core platform:

```bash
cd core
npm install
cp .env.example .env    # Edit as needed
npm run dev             # Starts on port 53666
```

Then point the OpenClaw plugin to your local Core:

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
  moltguard/              # MoltGuard OpenClaw plugin
```

## Plans

| Plan | Price | Detections/mo |
|------|-------|---------------|
| Free | $0 | 30,000 |
| Starter | $19/mo | 100,000 |
| Pro | $49/mo | 300,000 |
| Business | $199/mo | 2,000,000 |

All agents registered under the same email share one account and quota pool.

## npm Packages

| Package | Description |
|---------|-------------|
| `openguardrails` | CLI — includes bundled dashboard for private deployment |
| `@openguardrails/gateway` | AI Security Gateway — standalone local proxy |
| `@openguardrails/openguardrails` | OpenClaw security plugin |

## License

Apache License 2.0. See [LICENSE](LICENSE) for details.
