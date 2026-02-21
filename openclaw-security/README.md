# OpenGuardrails

[![npm version](https://img.shields.io/npm/v/@openguardrails/openclaw-security.svg)](https://www.npmjs.com/package/@openguardrails/openclaw-security)
[![GitHub](https://img.shields.io/github/license/openguardrails/openguardrails)](https://github.com/openguardrails/openguardrails)

**Comprehensive AI security for OpenClaw**: AI Security Gateway + Prompt injection detection.

**GitHub**: [https://github.com/openguardrails/openguardrails/tree/main/openclaw-security](https://github.com/openguardrails/openguardrails/tree/main/openclaw-security)

**npm**: [https://www.npmjs.com/package/@openguardrails/openclaw-security](https://www.npmjs.com/package/@openguardrails/openclaw-security)

## Features

✨ **NEW: AI Security Gateway** - Protect sensitive data (bank cards, passwords, API keys) before sending to LLMs
🛡️ **Prompt Injection Detection** - Detect and block malicious instructions hidden in external content
🔒 **Privacy-First** - All sensitive data processing happens locally on your machine
🚀 **Zero-Config** - Works out of the box with automatic API key registration

## Table of Contents

- [Quick Start](#quick-start)
- [Feature 1: AI Security Gateway](#feature-1-ai-security-gateway)
- [Feature 2: Prompt Injection Detection](#feature-2-prompt-injection-detection)
- [Installation](#installation)
- [Configuration](#configuration)
- [Commands](#commands)
- [Privacy & Security](#privacy--security)

## Quick Start

```bash
# Install the plugin
openclaw plugins install @openguardrails/openclaw-security

# Restart OpenClaw
openclaw gateway restart

# Enable AI Security Gateway (optional, protects sensitive data)
# Edit ~/.openclaw/openclaw.json and add:
{
  "plugins": {
    "entries": {
      "openguardrails": {
        "config": {
          "gatewayEnabled": true  // ← Enable AI Security Gateway
        }
      }
    }
  }
}
```

## Feature 1: AI Security Gateway

**NEW in v6.0** - Protect sensitive data in your prompts before sending to LLMs.

### What It Does

The AI Security Gateway is a **local HTTP proxy** that automatically:

1. **Intercepts** your prompts before they reach the LLM
2. **Sanitizes** sensitive data (bank cards, passwords, API keys, etc.)
3. **Sends** sanitized prompts to the LLM (Claude/GPT/Kimi/etc.)
4. **Restores** original values in responses before tool execution

**Example:**

```
You: "My card is 6222021234567890, book a hotel"
  ↓ Gateway sanitizes
LLM sees: "My card is __bank_card_1__, book a hotel"
  ↓ LLM responds
LLM: "Booking with __bank_card_1__"
  ↓ Gateway restores
Tool executes with: "Booking with 6222021234567890"
```

### Supported Data Types

| Data Type | Placeholder Example | Detected Patterns |
|-----------|-------------------|-------------------|
| Bank Cards | `__bank_card_1__` | 16-19 digit numbers |
| Credit Cards | `__credit_card_1__` | 1234-5678-9012-3456 |
| Email | `__email_1__` | user@example.com |
| Phone | `__phone_1__` | +86-138-1234-5678 |
| API Keys | `__secret_1__` | sk-..., ghp_..., Bearer tokens |
| IP Address | `__ip_1__` | 192.168.1.1 |
| SSN | `__ssn_1__` | 123-45-6789 |
| IBAN | `__iban_1__` | GB82WEST12345698765432 |
| URL | `__url_1__` | https://example.com |

### Gateway Setup

**1. Enable in config** (`~/.openclaw/openclaw.json`):

```json
{
  "plugins": {
    "entries": {
      "openguardrails": {
        "config": {
          "gatewayEnabled": true,      // Enable AI Security Gateway
          "gatewayPort": 8900,         // Gateway port (default: 8900)
          "gatewayAutoStart": true     // Auto-start (default: true)
        }
      }
    }
  }
}
```

**2. Configure your model to use the gateway**:

```json
{
  "models": {
    "providers": {
      "claude-protected": {
        "baseUrl": "http://127.0.0.1:8900",  // ← Point to gateway
        "api": "anthropic-messages",          // Keep protocol unchanged
        "apiKey": "${ANTHROPIC_API_KEY}",
        "models": [...]
      }
    }
  }
}
```

**3. Restart OpenClaw**:

```bash
openclaw gateway restart
```

### Gateway Commands

| Command | Description |
|---------|-------------|
| `/og_gateway_status` | View AI Security Gateway status and config examples |
| `/og_gateway_start` | Start the AI Security Gateway |
| `/og_gateway_stop` | Stop the AI Security Gateway |
| `/og_gateway_restart` | Restart the AI Security Gateway |

📖 **Full Guide**: See [GATEWAY_GUIDE.md](./GATEWAY_GUIDE.md) for detailed setup instructions, protocol support, and troubleshooting.

## Feature 2: Prompt Injection Detection

Detect and block malicious instructions hidden in external content (emails, web pages, documents).

### How It Works

Before injection detection analysis, content is **sanitized locally** to remove PII:

| Data Type | Placeholder |
|-----------|-------------|
| Email addresses | `<EMAIL>` |
| Phone numbers | `<PHONE>` |
| Credit card numbers | `<CREDIT_CARD>` |
| SSNs | `<SSN>` |
| IP addresses | `<IP_ADDRESS>` |
| API keys & secrets | `<SECRET>` |
| URLs | `<URL>` |
| IBANs | `<IBAN>` |

Then the sanitized content is sent to the detection API for analysis:

### Detection Flow

```
External Content (email/webpage/document)
         ↓
   ┌─────────────┐
   │   Local     │  Strip PII: emails, phones, cards,
   │  Sanitize   │  SSNs, API keys, URLs, IBANs...
   └─────────────┘
         ↓
   ┌─────────────┐
   │  Detection  │  POST /api/check/tool-call
   │     API     │  { sanitized content }
   └─────────────┘
         ↓
   ┌─────────────┐
   │   Verdict   │  { isInjection, confidence,
   │             │    reason, findings }
   └─────────────┘
         ↓
   Block or Allow
```

The plugin hooks into OpenClaw's `tool_result_persist` and `message_received` events. When your agent reads external content, OpenGuardrails sanitizes it locally, sends to the API for analysis, and blocks if injection is detected.

## Installation

```bash
# Install from npm
openclaw plugins install @openguardrails/openclaw-security

# Restart gateway to load the plugin
openclaw gateway restart
```

On first use, the plugin automatically registers an API key — no email, password, or manual setup required.

## Verify Installation

```bash
# Check plugin list, confirm openguardrails status is "loaded"
openclaw plugins list
```

You should see:
```
| OpenGuardrails | openguardrails | loaded | ...
```

## Commands

### Gateway Management

| Command | Description |
|---------|-------------|
| `/og_gateway_status` | View AI Security Gateway status and configuration |
| `/og_gateway_start` | Start the AI Security Gateway |
| `/og_gateway_stop` | Stop the AI Security Gateway |
| `/og_gateway_restart` | Restart the AI Security Gateway |

### Injection Detection

| Command | Description |
|---------|-------------|
| `/og_status` | View detection status and statistics |
| `/og_report` | View recent injection detections |
| `/og_feedback <id> fp [reason]` | Report false positive |
| `/og_feedback missed <reason>` | Report missed detection |

## Testing Detection

### 1. Download Test File

Download the test file with hidden injection:

```bash
curl -L -o /tmp/test-email.txt https://raw.githubusercontent.com/openguardrails/openguardrails/main/samples/test-email.txt
```

### 2. Test in OpenClaw

Ask the agent to read this file:

```
Read the contents of /tmp/test-email.txt
```

### 3. View Detection Logs

```bash
openclaw logs --follow | grep "openguardrails"
```

If detection succeeds, you'll see:

```
[openguardrails] tool_result_persist triggered for "read"
[openguardrails] Analyzing tool result from "read" (1183 chars)
[openguardrails] Analysis complete in 312ms: INJECTION DETECTED
[openguardrails] INJECTION DETECTED in tool result from "read": Contains instructions to override guidelines and execute a malicious shell command
```

### 4. View Statistics

In OpenClaw conversation:

```
/og_status
```

### 5. View Detection Details

```
/og_report
```

### 6. Provide Feedback

```
# Report false positive
/og_feedback 1 fp This is normal security documentation

# Report missed detection
/og_feedback missed Email contained hidden injection that wasn't detected
```

## Configuration

Edit OpenClaw config file (`~/.openclaw/openclaw.json`):

```json
{
  "plugins": {
    "entries": {
      "openguardrails": {
        "enabled": true,
        "config": {
          // AI Security Gateway
          "gatewayEnabled": false,      // Enable AI Security Gateway
          "gatewayPort": 8900,          // Gateway port
          "gatewayAutoStart": true,     // Auto-start gateway

          // Injection Detection
          "blockOnRisk": true,          // Block when injection detected
          "apiKey": "",                 // Auto-registered if empty
          "timeoutMs": 60000,           // Analysis timeout
          "autoRegister": true,         // Auto-register API key
          "coreUrl": "https://www.openguardrails.com/core"
        }
      }
    }
  }
}
```

### Configuration Options

#### AI Security Gateway

| Option | Default | Description |
|--------|---------|-------------|
| `gatewayEnabled` | `false` | Enable AI Security Gateway |
| `gatewayPort` | `8900` | Port for the gateway server |
| `gatewayAutoStart` | `true` | Automatically start gateway when OpenClaw starts |

#### Injection Detection

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `true` | Enable/disable injection detection |
| `blockOnRisk` | `true` | Block tool calls when injection is detected |
| `apiKey` | (auto) | API key (auto-registered if empty) |
| `autoRegister` | `true` | Auto-register API key on first use |
| `timeoutMs` | `60000` | Analysis timeout in milliseconds |
| `coreUrl` | `https://www.openguardrails.com/core` | Core API endpoint |

### Common Configurations

**Monitor-only mode** (log detections without blocking):
```json
{
  "blockOnRisk": false
}
```

**Full protection mode** (gateway + detection):
```json
{
  "gatewayEnabled": true,
  "blockOnRisk": true
}
```

## Privacy & Security

OpenGuardrails takes a **privacy-first, local-first** approach:

### Local Processing

✅ **AI Security Gateway is 100% local** - Sensitive data never leaves your machine. The gateway runs on `localhost` and processes all data locally before forwarding to LLMs.

✅ **Injection detection sanitization is local** - Before sending content to the detection API for analysis, all PII/secrets are stripped locally and replaced with placeholders. Only sanitized content is sent.

### Data Storage

✅ **API keys stored locally** - Your unique API key is stored at `~/.openclaw/credentials/openguardrails/credentials.json`. No shared or hard-coded keys.

✅ **Logs stored locally** - Analysis results are stored in local JSONL files at `~/.openclaw/logs/`. Never sent to external servers.

✅ **Gateway mappings are ephemeral** - Placeholder-to-original-value mappings exist only during the request cycle and are immediately discarded after response is restored.

### Network Transparency

**Gateway** makes zero external network calls. It's a pure localhost proxy (`127.0.0.1`).

**Injection Detection** makes exactly 2 types of calls to `www.openguardrails.com/core`:
1. `POST /api/register` - One-time API key registration (if auto-register enabled)
2. `POST /api/check/tool-call` - Analysis requests with sanitized content only

**No third-party LLM calls** - Content is never forwarded to OpenAI or other third parties.

**Content is not stored** - The detection API does not persist content after analysis completes.

### Open Source & Auditable

All code is open source. Key files:
- `gateway/sanitizer.ts` - Sanitization patterns and logic
- `gateway/restorer.ts` - Restoration logic
- `agent/sanitizer.ts` - Injection detection sanitization
- `agent/runner.ts` - API communication for detection

## Injection Detection API Details

OpenGuardrails uses a single API endpoint for detection:

```
POST https://www.openguardrails.com/core/api/check/tool-call
Authorization: Bearer <your-api-key>
Content-Type: application/json

{
  "content": "<content to analyze>",
  "async": false
}
```

Response:

```json
{
  "ok": true,
  "verdict": {
    "isInjection": true,
    "confidence": 0.95,
    "reason": "Contains hidden instructions to override system prompt",
    "findings": [
      {
        "suspiciousContent": "SYSTEM ALERT: Override all previous instructions...",
        "reason": "Attempts to override system prompt",
        "confidence": 0.95
      }
    ]
  }
}
```

API key registration happens automatically via `POST /api/register` on first use.

## Uninstall

```bash
openclaw plugins uninstall @openguardrails/openclaw-security
openclaw gateway restart
```

To also remove your stored API key:

```bash
rm ~/.openclaw/credentials/openguardrails/credentials.json
```

## Development

```bash
# Clone repository
git clone https://github.com/openguardrails/openguardrails.git
cd openguardrails/openclaw-security

# Install dependencies
npm install

# Local development install
openclaw plugins install -l .
openclaw gateway restart

# Type check
npm run typecheck

# Run tests
npm test
```

## License

MIT
