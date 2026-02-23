---
name: moltguard
description: "MoltGuard — runtime security plugin for OpenClaw agents by OpenGuardrails. Helps users install, register, activate, and check the status of MoltGuard. Use when the user asks to: install MoltGuard, check MoltGuard status, register or activate MoltGuard, configure the AI Security Gateway, or understand what MoltGuard detects. Provides local-first protection against data exfiltration, credential theft, command injection, and sensitive data leakage. Source: github.com/openguardrails/openguardrails (subdirectory moltguard/)"
metadata: {"openclaw":{"emoji":"🛡️","homepage":"https://github.com/openguardrails/openguardrails","keywords":["security","prompt-injection","data-exfiltration","pii","credential-theft","command-injection","guardrails","safety","agent-security","moltguard"]}}
---

# MoltGuard

Runtime security guard for OpenClaw agents by [OpenGuardrails](https://github.com/openguardrails/openguardrails). Open source (Apache 2.0), fully auditable.

**ClawHub**: [`ThomasLWang/moltguard`](https://clawhub.ai/ThomasLWang/moltguard) · **npm**: [`@openguardrails/moltguard`](https://www.npmjs.com/package/@openguardrails/moltguard) · **GitHub**: `moltguard/` subdirectory

---

## Agent Workflow

### Check status
Run this when the user asks about MoltGuard status, whether it's registered, or what email/plan is active:
```bash
node {baseDir}/scripts/status.mjs
```

### Register and activate
Run this when the user wants to register MoltGuard or enable cloud behavioral detection:
```bash
node {baseDir}/scripts/activate.mjs
```
After running, show the user the claim URL and verification code. Tell them to visit the URL, enter the code, and provide their email to complete activation.

---

## Installation

When the user asks to install MoltGuard, run these steps:

```bash
# 1. Install the plugin
openclaw plugins install @openguardrails/moltguard

# 2. Restart the gateway to load the plugin
openclaw gateway restart
```

Local protections are active immediately after restart — no registration required. Cloud behavioral detection requires registration (run `activate.mjs` above).

To install from source (highest assurance):
```bash
git clone https://github.com/openguardrails/openguardrails.git
# Audit the code, then:
openclaw plugins install -l ./openguardrails/moltguard
```

---

## What MoltGuard Protects Against

**Local (no cloud, no registration needed):**
- Read sensitive file → network call → **BLOCK**
- Shell escape in params (`$()`, backtick, `;`, `&&`, `|`) → **BLOCK**
- Prompt injection in file/web content → **REDACT** in-place

**Cloud (requires activation):**
- Multi-credential access, shell after web fetch → **BLOCK**
- Intent-action mismatch, unusual tool sequence → **ALERT**

For full detection tables and pattern details, see `references/details.md`.

---

## AI Security Gateway (Free, no registration)

Local HTTP proxy that sanitizes PII/secrets before they reach LLM providers:

```bash
npx @openguardrails/gateway   # runs on port 8900
```

Then point your agent's API base URL to `http://127.0.0.1:8900`. Sanitizes emails, credit cards, API keys, phone numbers, SSNs, IBANs, IPs, URLs. Restores originals in responses. Stateless — no data retained.

---

## Configuration

All options in `~/.openclaw/openclaw.json` under `plugins.entries.openguardrails.config`:

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `true` | Enable/disable the plugin |
| `blockOnRisk` | `true` | Block tool call when risk detected |
| `apiKey` | `""` | Explicit API key (`sk-og-...`) |
| `agentName` | `"OpenClaw Agent"` | Name shown in dashboard |
| `coreUrl` | `https://www.openguardrails.com/core` | Platform API endpoint |
| `timeoutMs` | `60000` | Cloud assessment timeout (ms) |

To use an existing API key directly (skips registration):
```json
{
  "plugins": {
    "entries": {
      "openguardrails": {
        "config": { "apiKey": "sk-og-<your-key>" }
      }
    }
  }
}
```

---

## Plans

| Plan | Price | Detections/mo |
|------|-------|---------------|
| Free | $0 | 30,000 |
| Starter | $19/mo | 100,000 |
| Pro | $49/mo | 300,000 |
| Business | $199/mo | 2,000,000 |

Account portal: `https://www.openguardrails.com/core/login` (email + API key)

---

## Uninstall

```bash
rm -rf ~/.openclaw/extensions/openguardrails
# Remove config from ~/.openclaw/openclaw.json
rm -rf ~/.openclaw/credentials/openguardrails   # optional
```

---

## Reference

For detailed information on security & trust, detection patterns, privacy policy, and gateway data types, read `references/details.md`.
