# MoltGuard

[![npm version](https://img.shields.io/npm/v/@openguardrails/moltguard.svg)](https://www.npmjs.com/package/@openguardrails/moltguard)
[![GitHub](https://img.shields.io/github/license/openguardrails/openguardrails)](https://github.com/openguardrails/openguardrails)

**Comprehensive AI security for OpenClaw**: Real-time protection against prompt injection, data leaks, and dangerous actions.

**GitHub**: [https://github.com/openguardrails/openguardrails/tree/main/moltguard](https://github.com/openguardrails/openguardrails/tree/main/moltguard)

**npm**: [https://www.npmjs.com/package/@openguardrails/moltguard](https://www.npmjs.com/package/@openguardrails/moltguard)

## Three Principles

1. **Instant Value** — Works immediately after installation
2. **No Security Expertise** — No configuration needed
3. **Secure by Default** — "Install it, and the agent won't go rogue"

## Features

| Feature | Description |
|---------|-------------|
| **Agent Guard** | Real-time interception of tool calls, shell commands, file access, HTTP requests |
| **Secret & Data Leak Protection** | Auto-sanitize API keys, SSH keys, PII before sending to LLMs |
| **Prompt Injection Protection** | Detect "ignore instructions", "send secrets", "bypass rules" attacks |
| **Local Dashboard** | View detection stats, agentic hours, and risk events |

## Quick Start

```bash
# Install the plugin
openclaw plugins install @openguardrails/moltguard

# Restart OpenClaw
openclaw gateway restart
```

That's it. MoltGuard auto-registers with Core and starts protecting immediately with 500 free checks/day.

## Commands

All commands are available in OpenClaw conversation:

| Command | Description |
|---------|-------------|
| `/og_status` | Show status, API key, quota, and mode |
| `/og_sanitize on` | Enable AI Security Gateway (sanitize sensitive data before sending to LLMs) |
| `/og_sanitize off` | Disable AI Security Gateway |
| `/og_sanitize` | Show gateway status |
| `/og_scan [type]` | Scan workspace files for security risks |
| `/og_autoscan on/off` | Enable/disable automatic file scanning on changes |
| `/og_dashboard` | Start local Dashboard and get access URL |
| `/og_config` | Show how to configure API key for cross-machine sharing |
| `/og_core` | Open Core portal for account and billing |
| `/og_claim` | Display agent ID and API key for claiming on Core |
| `/og_reset` | Reset MoltGuard and re-register (gets new API key) |

## AI Security Gateway

Protect sensitive data in your prompts before sending to LLMs.

### How It Works

```
You: "My API key is sk-abc123, call the service"
  ↓ Gateway sanitizes locally
LLM sees: "My API key is __PII_SECRET_00000001__, call the service"
  ↓ LLM responds
LLM: "Calling service with __PII_SECRET_00000001__"
  ↓ Gateway restores
Tool executes with: "Calling service with sk-abc123"
```

### Enable Gateway

```
/og_sanitize on
```

This modifies your `~/.openclaw/openclaw.json` to route all LLM providers through the local gateway (port 53669).

### Supported Data Types

| Data Type | Placeholder | Examples |
|-----------|-------------|----------|
| API Keys | `__PII_SECRET_*__` | `sk-...`, `ghp_...`, `AKIA...` |
| Bearer Tokens | `__PII_SECRET_*__` | `Bearer eyJhbG...` |
| Email | `__PII_EMAIL_ADDRESS_*__` | `user@example.com` |
| Credit Cards | `__PII_CREDIT_CARD_*__` | `4111-1111-1111-1111` |
| Phone | `__PII_PHONE_*__` | `+1-555-123-4567` |
| SSN | `__PII_SSN_*__` | `123-45-6789` |
| IP Address | `__PII_IP_ADDRESS_*__` | `192.168.1.1` |
| URLs | `__PII_URL_*__` | `https://internal.corp/secret` |
| High-entropy strings | `__PII_SECRET_*__` | Random tokens with Shannon entropy ≥4.0 |

## Prompt Injection Detection

MoltGuard detects malicious instructions hidden in external content (emails, web pages, documents).

### Detection Flow

```
External Content (email/webpage/document)
         ↓
   ┌─────────────┐
   │   Local     │  Strip PII before analysis
   │  Sanitize   │
   └─────────────┘
         ↓
   ┌─────────────┐
   │    Core     │  Behavioral assessment
   │     API     │  (rule-driven, no LLM)
   └─────────────┘
         ↓
   Block or Allow
```

### What Gets Detected

- "Ignore previous instructions" patterns
- "Send me your secrets" attempts
- System prompt override attacks
- Hidden instructions in markdown/HTML
- Data exfiltration attempts

## Static File Scanning

Scan workspace files for security risks:

```
/og_scan all        # Scan all workspace files
/og_scan memories   # Scan memory files only
/og_scan skills     # Scan skill files only
/og_scan summary    # Show file count without scanning
```

Enable automatic scanning on file changes:

```
/og_autoscan on
```

## Dashboard

View security stats in a local web dashboard:

```
/og_dashboard
```

The dashboard shows:
- Detection events and findings
- Agentic hours (total time of tool calls)
- Gateway activity (sanitizations/restorations)
- Risk event timeline

## Claiming an Agent

Link your agent to an email for shared quota across machines:

1. Run `/og_claim` to get your agent ID and API key
2. Run `/og_core` to open the Core portal
3. Enter your email to receive a magic login link
4. Go to `/claim-agent` and paste your credentials
5. Agent is now linked to your account

## Configuration

Edit `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "moltguard": {
        "enabled": true,
        "config": {
          "coreUrl": "https://www.openguardrails.com/core",
          "blockOnRisk": true,
          "timeoutMs": 60000
        }
      }
    }
  }
}
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `coreUrl` | `https://www.openguardrails.com/core` | Core API endpoint |
| `blockOnRisk` | `true` | Block tool calls when risk detected |
| `timeoutMs` | `60000` | Detection timeout in milliseconds |
| `apiKey` | (auto) | API key (auto-registered if empty) |

### Environment Variables

```bash
OG_API_KEY=sk-og-...        # Use specific API key
OG_CORE_URL=...             # Custom Core URL
```

## Privacy & Data Protection

**OpenGuardrails protects your data — we don't collect it.**

### Local-First Design

- All sensitive data is sanitized **on your machine** before leaving
- Gateway runs locally on `127.0.0.1:53669`
- Placeholder-to-original mappings are ephemeral (discarded after each request)
- Credentials stored locally at `~/.openclaw/credentials/moltguard/`

### What the Cloud API Receives

- Sanitized content (placeholders, not real values)
- Tool names and timing signals
- **Never**: raw file contents, conversation history, or PII

### Fail-Open Design

If the Core API is unreachable, tool calls are **allowed** — never blocks your workflow due to network issues.

## Plugin Update

MoltGuard supports graceful updates:

```bash
openclaw plugins update @openguardrails/moltguard
```

The plugin automatically handles port conflicts during updates using a secure token mechanism.

## Uninstall

```bash
openclaw plugins uninstall @openguardrails/moltguard
openclaw gateway restart
```

To remove stored credentials:

```bash
rm -rf ~/.openclaw/credentials/moltguard
rm -rf ~/.openclaw/extensions/moltguard
```

## Development

```bash
git clone https://github.com/openguardrails/openguardrails.git
cd openguardrails/moltguard

npm install
npm run typecheck
npm run test

# Local development install
openclaw plugins install -l .
openclaw gateway restart
```

## Contact

- **Email**: thomas@openguardrails.com
- **GitHub**: [github.com/openguardrails/openguardrails](https://github.com/openguardrails/openguardrails)

## License

MIT
