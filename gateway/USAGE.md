# AI Security Gateway - Usage Guide

## Overview

The AI Security Gateway sanitizes sensitive data before sending to LLM providers, protecting:

- **API keys** → `<SECRET_TOKEN>`
- **Email addresses** → `<EMAIL>`
- **SSH keys** → `<SSH_PRIVATE_KEY>`
- **Credit cards** → `<CREDIT_CARD>`
- **Phone numbers** → `<PHONE>`
- **Social Security Numbers** → `<SSN>`
- **And more...**

## For OpenClaw Users (via MoltGuard)

### Prerequisites

1. Install MoltGuard plugin (it includes the gateway)
2. Have at least one configured LLM provider

### Quick Start

Enable data sanitization with a single command:

```bash
/og_sanitize on
```

This will:
- ✅ Start the AI Security Gateway (http://127.0.0.1:8900)
- ✅ Modify all your agents' configs to route through the gateway
- ✅ Auto-configure the gateway with your providers' API keys
- ✅ Create a backup of your original configs

### Disable

Restore original configuration:

```bash
/og_sanitize off
```

This will:
- ✅ Restore original provider URLs in all agents
- ✅ Keep the gateway process running (in case you want to re-enable)

### Check Status

See current gateway status:

```bash
/og_sanitize
```

Shows:
- ✅ Enabled/disabled state
- ✅ Running/stopped state
- ✅ Protected agents and providers
- ✅ Gateway URL and PID

## How It Works

### Architecture

```
Your Agent
    ↓
  (sends LLM request with sensitive data)
    ↓
AI Security Gateway (http://127.0.0.1:8900)
    ↓
  (sanitizes: "sk-abc123" → "<SECRET_TOKEN>")
    ↓
LLM Provider (OpenAI, Anthropic, etc.)
    ↓
  (response with placeholder)
    ↓
AI Security Gateway
    ↓
  (restores: "<SECRET_TOKEN>" → "sk-abc123")
    ↓
Your Agent
```

### Configuration Changes

When you run `/og_sanitize on`, the following happens:

1. **Reads all agents' models.json files** (`~/.openclaw/agents/*/agent/models.json`)
2. **Backs up original baseUrls** to `~/.openclaw/credentials/moltguard/gateway-backup.json`
3. **Changes all baseUrls** to `http://127.0.0.1:8900`
4. **Creates gateway config** at `~/.openguardrails/gateway.json` with your providers' API keys
5. **Starts gateway process** (if not already running)

### Example Configuration

**Before (direct to provider):**
```json
{
  "providers": {
    "vllm": {
      "baseUrl": "https://api.xiangxinai.cn/coding/v1",
      "apiKey": "YOUR_API_KEY",
      ...
    }
  }
}
```

**After (through gateway):**
```json
{
  "providers": {
    "vllm": {
      "baseUrl": "http://127.0.0.1:8900",
      "apiKey": "YOUR_API_KEY",
      ...
    }
  }
}
```

**Gateway config (auto-generated):**
```json
{
  "port": 8900,
  "backends": {
    "vllm": {
      "baseUrl": "https://api.xiangxinai.cn/coding/v1",
      "apiKey": "YOUR_API_KEY",
      "type": "openai"
    }
  }
}
```

The gateway automatically routes requests to the correct backend by matching the API key in the request headers.

## Multi-Agent Support

The gateway automatically handles multiple agents:

```bash
# If you have agents: main, tina, alice
/og_sanitize on

# Output:
# - Agents configured: main, tina, alice
# - Providers protected: vllm, custom-api-xiangxinai-cn
```

All agents will route through the same gateway instance.

## Standalone Usage (Without OpenClaw)

You can also use the gateway directly:

### Install

```bash
npm install -g @openguardrails/gateway
```

### Configure

Create `~/.openguardrails/gateway.json`:

```json
{
  "port": 8900,
  "backends": {
    "openai": {
      "baseUrl": "https://api.openai.com",
      "apiKey": "sk-your-key"
    },
    "anthropic": {
      "baseUrl": "https://api.anthropic.com",
      "apiKey": "sk-ant-your-key"
    }
  }
}
```

Or use environment variables:

```bash
export GATEWAY_PORT=8900
export OPENAI_API_KEY=sk-your-key
export ANTHROPIC_API_KEY=sk-ant-your-key
```

### Start

```bash
og-gateway
```

### Use

Point your LLM client to `http://127.0.0.1:8900` instead of the provider's URL.

## Troubleshooting

### Gateway won't start

**Error:** `Gateway executable not found`

**Solution:** Make sure gateway is installed:
```bash
cd /path/to/openguardrails/gateway
npm install
npm run build
```

### Already enabled

**Error:** `Gateway is already enabled`

**Solution:** Disable first:
```bash
/og_sanitize off
```

### Gateway process won't stop

**Solution:** Restart your OpenClaw gateway:
```bash
openclaw gateway restart
```

Or manually kill the process:
```bash
ps aux | grep gateway
kill <PID>
```

## Security Notes

1. **Local only:** Gateway runs on `127.0.0.1` and is not accessible from network
2. **No logging:** Sensitive data is not logged to disk
3. **In-memory only:** Sanitization mappings are kept in memory only
4. **Zero dependencies:** Gateway has no npm dependencies to minimize supply chain risk

## Development

### Build

```bash
cd gateway
npm run build
```

### Test

```bash
npm run test
```

### Type-check

```bash
npm run typecheck
```
