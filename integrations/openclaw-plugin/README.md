# MoltGuard

[![npm version](https://img.shields.io/npm/v/@openguardrails/moltguard.svg)](https://www.npmjs.com/package/@openguardrails/moltguard)
[![GitHub](https://img.shields.io/github/license/openguardrails/moltguard)](https://github.com/openguardrails/moltguard)

**Comprehensive AI security for OpenClaw**: Local prompt sanitization + Prompt injection detection.

Powered by the [MoltGuard](https://moltguard.com) detection API.

**GitHub**: [https://github.com/openguardrails/moltguard](https://github.com/openguardrails/moltguard)

**npm**: [https://www.npmjs.com/package/@openguardrails/moltguard](https://www.npmjs.com/package/@openguardrails/moltguard)

## Features

✨ **NEW: Local Prompt Sanitization Gateway** - Protect sensitive data (bank cards, passwords, API keys) before sending to LLMs
🛡️ **Prompt Injection Detection** - Detect and block malicious instructions hidden in external content
🔒 **Privacy-First** - All sensitive data processing happens locally on your machine
🚀 **Zero-Config** - Works out of the box with automatic API key registration

## Table of Contents

- [Quick Start](#quick-start)
- [Feature 1: Local Prompt Sanitization Gateway](#feature-1-local-prompt-sanitization-gateway)
- [Feature 2: Prompt Injection Detection](#feature-2-prompt-injection-detection)
- [Installation](#installation)
- [Configuration](#configuration)
- [Commands](#commands)
- [Privacy & Security](#privacy--security)

## Quick Start

```bash
# Install the plugin
openclaw plugins install @openguardrails/moltguard

# Restart OpenClaw
openclaw gateway restart

# Enable prompt sanitization (optional, protects sensitive data)
# Edit ~/.openclaw/openclaw.json and add:
{
  "plugins": {
    "entries": {
      "moltguard": {
        "config": {
          "sanitizePrompt": true  // ← Enable local sanitization gateway
        }
      }
    }
  }
}
```

## Feature 1: Local Prompt Sanitization Gateway

**NEW in v6.0** - Protect sensitive data in your prompts before sending to LLMs.

### What It Does

The Gateway is a **local HTTP proxy** that automatically:

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
      "moltguard": {
        "config": {
          "sanitizePrompt": true,      // Enable gateway
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
| `/mg_status` | View gateway status and config examples |
| `/mg_start` | Start the gateway |
| `/mg_stop` | Stop the gateway |
| `/mg_restart` | Restart the gateway |

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

Then the sanitized content is sent to MoltGuard API for analysis:

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
   │  MoltGuard  │  POST /api/check/tool-call
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

The plugin hooks into OpenClaw's `tool_result_persist` and `message_received` events. When your agent reads external content, MoltGuard sanitizes it locally, sends to API for analysis, and blocks if injection is detected.

## Installation

```bash
# Install from npm
openclaw plugins install @openguardrails/moltguard

# Restart gateway to load the plugin
openclaw gateway restart
```

On first use, the plugin automatically registers an API key with MoltGuard — no email, password, or manual setup required.

## Verify Installation

```bash
# Check plugin list, confirm moltguard status is "loaded"
openclaw plugins list
```

You should see:
```
| MoltGuard | moltguard | loaded | ...
```

## Commands

### Gateway Management

| Command | Description |
|---------|-------------|
| `/mg_status` | View gateway status and configuration |
| `/mg_start` | Start the sanitization gateway |
| `/mg_stop` | Stop the sanitization gateway |
| `/mg_restart` | Restart the sanitization gateway |

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
curl -L -o /tmp/test-email.txt https://raw.githubusercontent.com/openguardrails/moltguard/main/samples/test-email.txt
```

### 2. Test in OpenClaw

Ask the agent to read this file:

```
Read the contents of /tmp/test-email.txt
```

### 3. View Detection Logs

```bash
openclaw logs --follow | grep "moltguard"
```

If detection succeeds, you'll see:

```
[moltguard] tool_result_persist triggered for "read"
[moltguard] Analyzing tool result from "read" (1183 chars)
[moltguard] Analysis complete in 312ms: INJECTION DETECTED
[moltguard] INJECTION DETECTED in tool result from "read": Contains instructions to override guidelines and execute a malicious shell command
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
      "moltguard": {
        "enabled": true,
        "config": {
          // Gateway (Prompt Sanitization)
          "sanitizePrompt": false,      // Enable local prompt sanitization
          "gatewayPort": 8900,          // Gateway port
          "gatewayAutoStart": true,     // Auto-start gateway

          // Injection Detection
          "blockOnRisk": true,          // Block when injection detected
          "apiKey": "",                 // Auto-registered if empty
          "timeoutMs": 60000,           // Analysis timeout
          "autoRegister": true,         // Auto-register API key
          "apiBaseUrl": "https://api.moltguard.com"
        }
      }
    }
  }
}
```

### Configuration Options

#### Gateway (Prompt Sanitization)

| Option | Default | Description |
|--------|---------|-------------|
| `sanitizePrompt` | `false` | Enable local prompt sanitization gateway |
| `gatewayPort` | `8900` | Port for the gateway server |
| `gatewayAutoStart` | `true` | Automatically start gateway when OpenClaw starts |

#### Injection Detection

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `true` | Enable/disable injection detection |
| `blockOnRisk` | `true` | Block tool calls when injection is detected |
| `apiKey` | (auto) | MoltGuard API key (auto-registered if empty) |
| `autoRegister` | `true` | Auto-register API key on first use |
| `timeoutMs` | `60000` | Analysis timeout in milliseconds |
| `apiBaseUrl` | `https://api.moltguard.com` | MoltGuard API endpoint |

### Common Configurations

**Monitor-only mode** (log detections without blocking):
```json
{
  "blockOnRisk": false
}
```

**Full protection mode** (sanitization + detection):
```json
{
  "sanitizePrompt": true,
  "blockOnRisk": true
}
```

## Privacy & Security

MoltGuard takes a **privacy-first, local-first** approach:

### Local Processing

✅ **Gateway sanitization is 100% local** - Sensitive data never leaves your machine. The gateway runs on `localhost` and processes all data locally before forwarding to LLMs.

✅ **Injection detection sanitization is local** - Before sending content to the MoltGuard API for analysis, all PII/secrets are stripped locally and replaced with placeholders. Only sanitized content is sent.

### Data Storage

✅ **API keys stored locally** - Your unique API key is stored at `~/.openclaw/credentials/moltguard/credentials.json`. No shared or hard-coded keys.

✅ **Logs stored locally** - Analysis results are stored in local JSONL files at `~/.openclaw/logs/`. Never sent to external servers.

✅ **Gateway mappings are ephemeral** - Placeholder-to-original-value mappings exist only during the request cycle and are immediately discarded after response is restored.

### Network Transparency

**Gateway** makes zero external network calls. It's a pure localhost proxy (`127.0.0.1`).

**Injection Detection** makes exactly 2 types of calls to `api.moltguard.com`:
1. `POST /api/register` - One-time API key registration (if auto-register enabled)
2. `POST /api/check/tool-call` - Analysis requests with sanitized content only

**No third-party LLM calls** - Content is never forwarded to OpenAI or other third parties.

**Content is not stored** - The MoltGuard API does not persist content after analysis completes.

### Open Source & Auditable

All code is open source. Key files:
- `gateway/sanitizer.ts` - Sanitization patterns and logic
- `gateway/restorer.ts` - Restoration logic
- `agent/sanitizer.ts` - Injection detection sanitization
- `agent/runner.ts` - API communication for detection

## Injection Detection API Details

MoltGuard uses a single API endpoint for detection:

```
POST https://api.moltguard.com/api/check/tool-call
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
openclaw plugins uninstall @openguardrails/moltguard
openclaw gateway restart
```

To also remove your stored API key:

```bash
rm ~/.openclaw/credentials/moltguard/credentials.json
```

## Development

```bash
# Clone repository
git clone https://github.com/openguardrails/moltguard.git
cd moltguard

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
