# AI Security Gateway

Secure proxy for LLM APIs with automatic PII sanitization, credential detection, and content security. Zero npm dependencies.

## Overview

Gateway intercepts LLM API requests locally, automatically sanitizes sensitive data before sending to providers (using numbered placeholders), and restores original values in responses.

**Core Features:**
- **Request Sanitization**: Sensitive data → Placeholder (e.g., `sk-abc123` → `__PII_SECRET_00000001__`)
- **Response Restoration**: Placeholder → Original value
- **Transparent Proxy**: No impact on OpenClaw's normal operation
- **Activity Monitoring**: Real-time tracking of sanitization events

## Integration with MoltGuard

Gateway runs **embedded** in the MoltGuard plugin process. It is NOT a standalone CLI tool.

### Enable/Disable

Users run commands in OpenClaw conversation:
```
/og_sanitize on    # Enable sanitization protection
/og_sanitize off   # Disable and restore configuration
/og_sanitize       # Check status
```

### Enable Flow

1. Read providers from `~/.openclaw/openclaw.json`
2. Backup original baseUrls to `~/.openclaw/extensions/moltguard/data/gateway-backup.json`
3. Modify all baseUrls to gateway URLs (e.g., `http://127.0.0.1:53669/backend/vllm`)
4. Auto-generate gateway config (`~/.openclaw/extensions/moltguard/data/gateway.json`)
5. Restart gateway to load new backends

### OpenClaw LLM Provider Configuration

Providers are configured in `~/.openclaw/openclaw.json`:
```json
{
  "models": {
    "providers": {
      "vllm": {
        "baseUrl": "https://api.xiangxinai.cn/coding/v1",
        "apiKey": "VLLM_API_KEY",
        "api": "openai-completions",
        "models": [...]
      },
      "anthropic": {
        "baseUrl": "https://api.anthropic.com",
        "apiKey": "sk-ant-...",
        "api": "anthropic",
        "models": [...]
      }
    }
  }
}
```

**Key Points:**
- Gateway modifies `baseUrl` to route through itself (e.g., `http://127.0.0.1:53669/backend/vllm`)
- API keys can be placeholders resolved from `auth-profiles.json`
- Original baseUrl is saved in backup file for restoration

## Architecture

```
OpenClaw Agent
    ↓ (request with sensitive data)
Gateway (http://127.0.0.1:53669/backend/{provider})
    ↓ (sanitize: "sk-abc" → "__PII_SECRET_00000001__")
LLM Provider (OpenAI/Anthropic/Gemini)
    ↓ (response with placeholder)
Gateway
    ↓ (restore: "__PII_SECRET_00000001__" → "sk-abc")
OpenClaw Agent
```

## Code Structure

```
src/
├── index.ts         # HTTP server, request routing, embedded mode support
├── config.ts        # Config loading (file + env vars)
├── types.ts         # TypeScript type definitions
├── sanitizer.ts     # Sensitive data detection and replacement
├── restorer.ts      # Placeholder restoration
├── activity.ts      # Activity event logging for dashboard
├── mapping-store.ts # Per-request mapping table storage
└── handlers/
    ├── anthropic.ts  # Anthropic Messages API
    ├── openai.ts     # OpenAI Chat Completions
    ├── gemini.ts     # Google Gemini API
    └── models.ts     # GET /v1/models proxy
```

## Request Routing

| Path Pattern | Handler | Description |
|------|---------|-------------|
| `POST */messages` | anthropic.ts | Anthropic Messages API |
| `POST */chat/completions` | openai.ts | OpenAI/OpenRouter Chat Completions |
| `POST */models/{model}:generateContent` | gemini.ts | Google Gemini API |
| `GET /v1/models` | models.ts | Models list proxy |
| `POST /backend/{name}/chat/completions` | openai.ts | Named backend routing |

### Backend Resolution Priority

1. **URL Path**: `/backend/{name}/...` extracts backend name from URL
2. **Path Prefix**: Match by configured `pathPrefix` in backend config
3. **API Key Match**: Request API key matches a backend's apiKey
4. **Default Backend**: Configured in `defaultBackends` or auto-matched by API type

## Configuration

### Config File

Location: `~/.openclaw/extensions/moltguard/data/gateway.json`

```json
{
  "port": 53669,
  "backends": {
    "anthropic": {
      "baseUrl": "https://api.anthropic.com",
      "apiKey": "sk-ant-...",
      "type": "anthropic"
    },
    "vllm": {
      "baseUrl": "https://api.xiangxinai.cn/coding/v1",
      "apiKey": "your-vllm-key",
      "type": "openai",
      "pathPrefix": "/coding/v1"
    },
    "openrouter": {
      "baseUrl": "https://openrouter.ai/api",
      "apiKey": "sk-or-...",
      "type": "openai",
      "referer": "https://yourapp.com",
      "title": "Your App"
    }
  }
}
```

### Backend Config Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `baseUrl` | string | Yes | Provider API URL |
| `apiKey` | string | Yes | API key |
| `type` | string | No | API type: `anthropic`, `openai`, `gemini` (auto-inferred) |
| `pathPrefix` | string | No | URL path prefix for routing |
| `models` | string[] | No | List of model IDs supported by this backend |
| `referer` | string | No | HTTP-Referer (OpenRouter attribution) |
| `title` | string | No | X-Title (OpenRouter attribution) |

### Environment Variables

As fallback for config file:
- `GATEWAY_PORT` (default: 53669)
- `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`
- `OPENAI_API_KEY`, `OPENAI_BASE_URL`
- `GEMINI_API_KEY` / `GOOGLE_API_KEY`, `GEMINI_BASE_URL`
- `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL`, `OPENROUTER_REFERER`, `OPENROUTER_TITLE`

## Sanitization Rules

### Detection Patterns

| Type | Example | Placeholder |
|------|---------|-------------|
| URL | `https://example.com` | `__PII_URL_00000001__` |
| Email | `user@example.com` | `__PII_EMAIL_ADDRESS_00000001__` |
| Credit Card | `4111-1111-1111-1111` | `__PII_CREDIT_CARD_00000001__` |
| SSN | `123-45-6789` | `__PII_SSN_00000001__` |
| IP Address | `192.168.1.1` | `__PII_IP_ADDRESS_00000001__` |
| Phone | `+1-555-123-4567` | `__PII_PHONE_00000001__` |
| Secret Prefix | `sk-abc123...` | `__PII_SECRET_00000001__` |
| Bearer Token | `Bearer eyJhbG...` | `__PII_SECRET_00000001__` |
| High-entropy | (Shannon entropy ≥4.0) | `__PII_SECRET_00000001__` |

### Secret Prefixes

Detects tokens starting with:
- `sk-`, `sk_`, `pk_` (API keys)
- `ghp_` (GitHub PAT)
- `AKIA` (AWS)
- `xox` (Slack)
- `SG.` (SendGrid)
- `hf_` (Hugging Face)
- `api-`, `token-`, `secret-`

## Activity Monitoring

Gateway emits activity events for dashboard integration:

```typescript
import { addActivityListener, type GatewayActivityEvent } from "./gateway/index.js";

addActivityListener((event: GatewayActivityEvent) => {
  console.log(`${event.type}: ${event.redactionCount} redactions`);
  // Report to dashboard
});
```

### Event Types

- `sanitize`: Request being sent out (contains redaction count and categories)
- `restore`: Response being returned (contains restoration count)

### Event Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique event ID |
| `timestamp` | string | ISO timestamp |
| `requestId` | string | Links sanitize/restore events |
| `type` | `"sanitize"` \| `"restore"` | Event type |
| `direction` | `"request"` \| `"response"` | Data flow direction |
| `backend` | string | Backend name |
| `endpoint` | string | API endpoint path |
| `model` | string | Model being called |
| `redactionCount` | number | Number of items redacted/restored |
| `categories` | Record<string, number> | Count by category (email, secret, etc.) |

## Programmatic API

Gateway can be started embedded (in-process) or standalone:

```typescript
import { startGateway, stopGateway, isGatewayServerRunning } from "./gateway/index.js";

// Embedded mode (don't exit process on errors)
startGateway("/path/to/config.json", true);

// Check status
if (isGatewayServerRunning()) {
  console.log("Gateway is running");
}

// Stop
await stopGateway();
```

### Exported Functions

| Function | Description |
|----------|-------------|
| `startGateway(configPath?, embedded?)` | Start the gateway server |
| `stopGateway()` | Stop the gateway server |
| `isGatewayServerRunning()` | Check if server is running |
| `sanitize(text)` | Sanitize text, returns result with mapping |
| `sanitizeMessages(messages)` | Sanitize message array |
| `restore(text, mapping)` | Restore placeholders in text |
| `restoreJSON(obj, mapping)` | Restore placeholders in JSON object |
| `restoreSSELine(line, mapping)` | Restore placeholders in SSE line |
| `addActivityListener(fn)` | Register activity callback |
| `removeActivityListener(fn)` | Remove activity callback |

## Development

```bash
# Install dependencies
npm install

# Development mode (standalone)
npm run dev

# Build
npm run build

# Type check
npm run typecheck

# Test
npm run test
```

## Security Design

1. **Local Only**: Listens on `127.0.0.1`, no external connections
2. **No Logging**: Sensitive data not written to disk
3. **In-Memory Mapping**: Sanitization mapping table kept in memory only
4. **Zero Dependencies**: No npm dependencies, minimizing supply chain risk
5. **Per-Request Isolation**: Each request has its own mapping table

## Supported LLM Providers

- **Anthropic**: Claude models
- **OpenAI**: GPT models
- **OpenAI Compatible**: Kimi, DeepSeek, vLLM, etc.
- **Google Gemini**: Gemini models
- **OpenRouter**: Multi-model routing

## Streaming Support

- Anthropic/OpenAI: Server-Sent Events (SSE) format
- Response restoration happens at complete chunk level
- Mapping table persists across streaming chunks via `mapping-store.ts`

## Notes

- Gateway only proxies and sanitizes/restores, does not modify request structure
- Different providers have different message structures, each handler processes accordingly
- Maintains compatibility with OpenClaw's original LLM call logic
- Embedded mode is preferred for MoltGuard integration (no process management needed)
