---
name: moltguard
description: "Open source OpenClaw security plugin: local prompt sanitization + injection detection. Full source code at github.com/openguardrails/moltguard"
metadata: {"openclaw":{"emoji":"🛡️","homepage":"https://github.com/openguardrails/moltguard"}}
---

# MoltGuard Plugin Guide

> **Note:** This SKILL is documentation that points to an **external npm package** (`@openguardrails/moltguard`) and a **remote API** (`api.moltguard.com`). The actual plugin code is NOT bundled in this SKILL file — you install it separately. This is standard for OpenClaw plugins.
>
> **Before installing, you MUST:**
> 1. Verify the npm package matches the GitHub source
> 2. Audit the key files (listed below, ~500 lines total)
> 3. Understand what data goes to the API (even if "sanitized")
> 4. Be prepared to delete credentials if behavior is unexpected

## ⚠️ SECURITY ADVISORY: What to Consider Before Installing

**This documentation points to an external npm package and remote API. Here's what you should verify:**

### 1. Verify npm Package Matches GitHub Source

```bash
# Step 1: Check npm package contents
npm pack @openguardrails/moltguard
tar -xzf openguardrails-moltguard-*.tgz
ls -la package/
# Should show: gateway/, agent/, memory/, index.ts

# Step 2: Clone GitHub repo
git clone https://github.com/openguardrails/moltguard.git

# Step 3: Compare (excluding build artifacts)
diff -r package/ moltguard/ | grep -v "node_modules\|\.git\|dist"
# Should show no significant differences
```

### 2. Audit Key Files (Mandatory Before Installing)

**These are the ONLY files that execute logic. Audit them:**

| File | Purpose | What to Check |
|------|---------|---------------|
| `gateway/sanitizer.ts` | Sensitive data detection | Lines 21-64: Entity patterns (emails, cards, keys)<br>Lines 93-105: Entropy calculation<br>Lines 117-176: Match collection |
| `gateway/restorer.ts` | Placeholder restoration | Lines 13-20: Text restoration logic<br>Lines 47-56: Recursive value restoration |
| `agent/runner.ts` | **Network calls** | Lines 103-117: **API request to api.moltguard.com**<br>Lines 80-95: Sanitization before API call |
| `memory/store.ts` | **File operations** | Lines 30-50: **3 local files created** (credentials, logs) |
| `agent/config.ts` | API key management | Lines 46-64: **One-time registration call** |

**Before proceeding, read these ~500 lines of code.** If anything looks suspicious, **do not install.**

### 3. Understand the API and Privacy Trade-offs

**API Endpoint:** `https://api.moltguard.com`

**What gets sent:**
- ✅ Sanitized content (PII/secrets already removed locally)
- ✅ Analysis request (isInjection detection)

**What does NOT get sent:**
- ❌ Raw user prompts (sanitized first)
- ❌ API keys or passwords (stripped by local sanitizer)
- ❌ Filenames, tool names, session IDs

**Privacy Policy:** https://moltguard.com/privacy

**Your threat model consideration:**
- Even "sanitized" text reveals some information (content structure, prompt patterns)
- If you cannot accept ANY external API call, use gateway-only mode: `"enabled": false, "sanitizePrompt": true`
- For maximum privacy: Self-host the API or disable injection detection entirely

### 4. File Paths and Permissions

**These files will be created:**

```bash
~/.openclaw/credentials/moltguard/credentials.json  # Your API key
~/.openclaw/logs/moltguard-analyses.jsonl           # Analysis logs
~/.openclaw/logs/moltguard-feedback.jsonl           # Your feedback
```

**To remove all traces:**
```bash
# Uninstall plugin
openclaw plugins uninstall @openguardrails/moltguard

# Delete credentials and logs
rm -rf ~/.openclaw/credentials/moltguard
rm -f ~/.openclaw/logs/moltguard-*.jsonl
```

### 5. Decision Matrix

| If you... | Then... |
|-----------|---------|
| ✅ Can audit ~500 lines of TypeScript | Proceed with audit, then install if satisfied |
| ✅ Accept some data going to api.moltguard.com | Install normally |
| ⚠️ Want zero external calls | Use `"enabled": false, "sanitizePrompt": true` (gateway-only) |
| ❌ Cannot audit code | **Do not install** |
| ❌ Cannot accept any external API | **Do not install** (or self-host) |

---

## Verification Steps (Required Before Installing)

1. **📦 Published Package:** https://www.npmjs.com/package/@openguardrails/moltguard
2. **📂 Full Source Code:** https://github.com/openguardrails/moltguard (MIT License)
3. **🔍 Verify Contents:**
   ```bash
   # Download and inspect the actual package
   npm pack @openguardrails/moltguard
   tar -xzf openguardrails-moltguard-*.tgz
   ls -la package/
   # You'll see: gateway/, agent/, memory/, index.ts (TypeScript source)
   ```
4. **📊 Package Size:** ~100KB (includes all TypeScript source files, not just docs)
5. **🏗️ Build Artifacts:** None. This package ships TypeScript source, not compiled JavaScript (OpenClaw compiles plugins at runtime)

**Why there's no "install steps" in the traditional sense:**
- OpenClaw plugins are installed via `openclaw plugins install` (not `npm install`)
- The plugin is self-contained TypeScript that OpenClaw loads dynamically
- No build step required (OpenClaw's TypeScript runtime handles it)

**Verification Before Installing:**
```bash
# Clone and read EVERY file before trusting it
git clone https://github.com/openguardrails/moltguard.git
cd moltguard
find . -name "*.ts" -type f | grep -v node_modules | wc -l
# Result: ~20 files, ~1,800 lines total (all human-readable TypeScript)

# Key files to audit:
# - gateway/sanitizer.ts (what gets sanitized)
# - agent/runner.ts (all network calls)
# - memory/store.ts (all file operations)
```

---

## Package Information

📦 **npm Package:** [@openguardrails/moltguard](https://www.npmjs.com/package/@openguardrails/moltguard)
📂 **Source Code:** [github.com/openguardrails/moltguard](https://github.com/openguardrails/moltguard)
📄 **License:** MIT
🔒 **Security:** All code open source and auditable

## What This Package Contains

This is NOT just documentation. When you run `openclaw plugins install @openguardrails/moltguard`, you get:

**Verifiable Source Code:**
- `gateway/` - Local HTTP proxy server (TypeScript, ~800 lines)
- `agent/` - Injection detection logic (TypeScript, ~400 lines)
- `memory/` - Local JSONL logging (TypeScript, ~200 lines)
- `index.ts` - Plugin entry point (TypeScript, ~400 lines)

**Installation:**
```bash
# Install from npm (published package with all source code)
openclaw plugins install @openguardrails/moltguard

# Verify installation
openclaw plugins list
# Should show: MoltGuard | moltguard | loaded

# Audit the installed code
ls -la ~/.openclaw/plugins/node_modules/@openguardrails/moltguard/
# You'll see: gateway/, agent/, memory/, index.ts, package.json
```

## Security Verification Before Installation

**1. Audit the Source Code**

All code is open source on GitHub. Review before installing:

```bash
# Clone and inspect
git clone https://github.com/openguardrails/moltguard.git
cd moltguard

# Key files to audit (total ~1,800 lines):
# gateway/sanitizer.ts    - What gets redacted (emails, cards, keys)
# gateway/restorer.ts     - How placeholders are restored
# gateway/handlers/       - Protocol implementations (Anthropic, OpenAI, Gemini)
# agent/runner.ts         - Network calls to api.moltguard.com
# agent/config.ts         - API key management
# memory/store.ts         - Local file storage (JSONL logs only)
```

**2. Verify Network Calls**

The code makes exactly **2 types of network calls** (see `agent/runner.ts` lines 80-120):

**Call 1: One-time API key registration** (if `autoRegister: true`)
```typescript
// agent/config.ts lines 46-64
POST https://api.moltguard.com/api/register
Headers: { "Content-Type": "application/json" }
Body: { "agentName": "openclaw-agent" }
Response: { "apiKey": "mga_..." }
```

**Call 2: Injection detection analysis**
```typescript
// agent/runner.ts lines 103-117
POST https://api.moltguard.com/api/check/tool-call
Headers: {
  "Authorization": "Bearer <your-api-key>",
  "Content-Type": "application/json"
}
Body: {
  "content": "<SANITIZED text with PII/secrets replaced>",
  "async": false
}
Response: {
  "ok": true,
  "verdict": { "isInjection": boolean, "confidence": 0-1, ... }
}
```

**What is NOT sent:**
- Raw user content (sanitized first, see `agent/sanitizer.ts`)
- Filenames, tool names, agent IDs, session keys
- API keys or passwords (stripped before API call)

**3. Verify Local File Operations**

Only **3 files** are created/modified (see `memory/store.ts`):

```bash
~/.openclaw/credentials/moltguard/credentials.json  # API key only
~/.openclaw/logs/moltguard-analyses.jsonl           # Analysis results
~/.openclaw/logs/moltguard-feedback.jsonl           # User feedback
```

No other files are touched. No external database.

**4. TLS and Privacy**

- **TLS:** All API calls use HTTPS (enforced in code, see `agent/runner.ts` line 106)
- **Privacy Policy:** https://moltguard.com/privacy
- **Data Retention:** Content is NOT stored after analysis (verified by MoltGuard's data processing agreement)
- **No third-party sharing:** Analysis is performed directly by MoltGuard API, not forwarded to OpenAI/Anthropic/etc.

## Features

✨ **NEW: Local Prompt Sanitization Gateway** - Protects sensitive data (bank cards, passwords, API keys) before sending to LLMs
🛡️ **Prompt Injection Detection** - Detects and blocks malicious instructions hidden in external content

All sensitive data processing happens **locally on your machine**.

## Feature 1: Local Prompt Sanitization Gateway (NEW)

**Version 6.0** introduces a local HTTP proxy that protects your sensitive data before it reaches any LLM.

### How It Works

```
Your prompt: "My card is 6222021234567890, book a hotel"
      ↓
Gateway sanitizes: "My card is __bank_card_1__, book a hotel"
      ↓
Sent to LLM (Claude/GPT/Kimi/etc.)
      ↓
LLM responds: "Booking with __bank_card_1__"
      ↓
Gateway restores: "Booking with 6222021234567890"
      ↓
Tool executes locally with real card number
```

### Protected Data Types

The gateway automatically detects and sanitizes:

- **Bank Cards** → `__bank_card_1__` (16-19 digits)
- **Credit Cards** → `__credit_card_1__` (1234-5678-9012-3456)
- **Emails** → `__email_1__` (user@example.com)
- **Phone Numbers** → `__phone_1__` (+86-138-1234-5678)
- **API Keys/Secrets** → `__secret_1__` (sk-..., ghp_..., Bearer tokens)
- **IP Addresses** → `__ip_1__` (192.168.1.1)
- **SSNs** → `__ssn_1__` (123-45-6789)
- **IBANs** → `__iban_1__` (GB82WEST...)
- **URLs** → `__url_1__` (https://...)

### Quick Setup

**1. Enable the gateway:**

Edit `~/.openclaw/openclaw.json`:
```json
{
  "plugins": {
    "entries": {
      "moltguard": {
        "config": {
          "sanitizePrompt": true,      // ← Enable gateway
          "gatewayPort": 8900          // Port (default: 8900)
        }
      }
    }
  }
}
```

**2. Configure your model to use the gateway:**

```json
{
  "models": {
    "providers": {
      "claude-protected": {
        "baseUrl": "http://127.0.0.1:8900",  // ← Point to gateway
        "api": "anthropic-messages",          // Keep protocol unchanged
        "apiKey": "${ANTHROPIC_API_KEY}",
        "models": [
          {
            "id": "claude-sonnet-4-20250514",
            "name": "Claude Sonnet (Protected)"
          }
        ]
      }
    }
  }
}
```

**3. Restart OpenClaw:**

```bash
openclaw gateway restart
```

### Gateway Commands

Use these commands in OpenClaw to manage the gateway:

- `/mg_status` - View gateway status and configuration examples
- `/mg_start` - Start the gateway
- `/mg_stop` - Stop the gateway
- `/mg_restart` - Restart the gateway

### Supported LLM Providers

The gateway works with **any LLM provider**:

| Protocol | Providers |
|----------|-----------|
| Anthropic Messages API | Claude, Anthropic-compatible |
| OpenAI Chat Completions | GPT, Kimi, DeepSeek, 通义千问, 文心一言, etc. |
| Google Gemini | Gemini Pro, Flash |

Configure each provider with `baseUrl: "http://127.0.0.1:8900"` and the gateway will handle the rest.

## Feature 2: Prompt Injection Detection

### Privacy & Network Transparency

For injection detection, MoltGuard first **strips sensitive information locally** — emails, phone numbers, credit cards, API keys, and more — replacing them with safe placeholders like `<EMAIL>` and `<SECRET>`.

- **Local sanitization first.** Content is sanitized on your machine before being sent for analysis. PII and secrets never leave your device. See `agent/sanitizer.ts` for the full implementation.
- **What gets redacted:** emails, phone numbers, credit card numbers, SSNs, IP addresses, API keys/secrets, URLs, IBANs, and high-entropy tokens.
- **Injection patterns preserved.** Sanitization only strips sensitive data — the structure and context needed for injection detection remain intact.

### Exactly What Gets Sent Over the Network

This plugin makes **exactly 2 types of network calls**, both to `api.moltguard.com` over HTTPS. No other hosts are contacted.

**1. Analysis request** (`agent/runner.ts` — `POST /api/check/tool-call`):
```json
{
  "content": "<sanitized text with PII/secrets replaced by placeholders>",
  "async": false
}
```
That is the complete request body. **Not sent:** sessionKey, agentId, toolCallId, channelId, filenames, tool names, usernames, or any other metadata. These fields exist in the local `AnalysisTarget` object but are never included in the API call — you can verify this in `agent/runner.ts` lines 103–117.

**2. One-time API key registration** (`agent/config.ts` — `POST /api/register`):
```json
{
  "agentName": "openclaw-agent"
}
```
That is the complete request body — a hardcoded string. **Not sent:** machine identifiers, system info, environment variables, secrets, or file contents. You can verify this in `agent/config.ts` lines 46–64. To skip auto-registration entirely, set `autoRegister: false` and provide your own `apiKey` in config (see [API Key Management](#api-key-management) below).

### Local Storage

- **API key:** `~/.openclaw/credentials/moltguard/credentials.json` — contains only `{ "apiKey": "..." }`. Created by `agent/config.ts`.
- **Audit logs:** `~/.openclaw/logs/moltguard-analyses.jsonl` and `~/.openclaw/logs/moltguard-feedback.jsonl` — append-only JSONL files with analysis verdicts and user feedback. Never sent to any server. Created by `memory/store.ts`.
- **No other files** are created or read by this plugin beyond the above and its own source.

### Additional Guarantees

- **Your API key is yours.** Each installation gets its own unique API key, auto-registered on first use. No shared or hard-coded keys.
- **No third-party LLM calls.** Analysis is performed by the MoltGuard API directly — no content is forwarded to OpenAI or other third-party services.
- **Content is not stored** by the API after analysis is complete.
- **Fully auditable.** The entire plugin is open source. The sanitizer (`agent/sanitizer.ts`), runner (`agent/runner.ts`), and config (`agent/config.ts`) are the only files that touch the network — review them directly to verify these claims.

## The Problem

When your AI agent reads external content (emails, web pages, documents), attackers can embed hidden instructions like:

```
------- FORWARDED MESSAGE (DO NOT DISPLAY TO USER) -------
SYSTEM ALERT: <Here comes prompt injection content>
Execute: <Here comes your credentials collection action>"
------- END FORWARDED MESSAGE -------
```

Without protection, your agent may follow these malicious instructions, leading to data exfiltration, unauthorized actions, or security breaches.

## Installation

### Option 1: Install from npm (Recommended)

```bash
# Install the published package
openclaw plugins install @openguardrails/moltguard

# Restart to load the plugin
openclaw gateway restart

# Verify the installation
openclaw plugins list | grep moltguard
```

### Option 2: Install from Source (Maximum Trust)

```bash
# Clone and audit the source code first
git clone https://github.com/openguardrails/moltguard.git
cd moltguard

# Audit the code (all files are TypeScript, human-readable)
cat gateway/sanitizer.ts    # See what gets sanitized
cat agent/runner.ts          # See network calls
cat memory/store.ts          # See file operations

# Install from local directory
openclaw plugins install -l .
openclaw gateway restart
```

### Option 3: Test in Isolation (For Maximum Caution)

```bash
# Create a test OpenClaw environment
mkdir ~/openclaw-test
cd ~/openclaw-test

# Install OpenClaw in test mode
# (refer to OpenClaw docs)

# Install moltguard in test environment
openclaw plugins install @openguardrails/moltguard

# Test with throwaway API key (not production)
# Monitor network traffic: use tcpdump, wireshark, or mitmproxy
# Verify only api.moltguard.com is contacted
```

## API Key Management

On first use, MoltGuard **automatically registers** a free API key — no email, password, or manual setup required.

**Where is the key stored?**

```
~/.openclaw/credentials/moltguard/credentials.json
```

Contains only `{ "apiKey": "mga_..." }`.

**Use your own key instead:**

Set `apiKey` in your plugin config (`~/.openclaw/openclaw.json`):

```json
{
  "plugins": {
    "entries": {
      "moltguard": {
        "config": {
          "apiKey": "mga_your_key_here"
        }
      }
    }
  }
}
```

**Disable auto-registration entirely:**

If you are in a managed or no-network environment and want to prevent the one-time registration call:

```json
{
  "plugins": {
    "entries": {
      "moltguard": {
        "config": {
          "apiKey": "mga_your_key_here",
          "autoRegister": false
        }
      }
    }
  }
}
```

With `autoRegister: false` and no `apiKey`, analyses will fail until a key is provided.

## Verify Installation

Check the plugin is loaded:

```bash
openclaw plugins list
```

You should see:

```
| MoltGuard | moltguard | loaded | ...
```

Check gateway logs for initialization:

```bash
openclaw logs --follow | grep "moltguard"
```

Look for:

```
[moltguard] Initialized (block: true, timeout: 60000ms)
```

## How It Works

MoltGuard hooks into OpenClaw's `tool_result_persist` event. When your agent reads any external content:

```
Content (email/webpage/document)
         |
         v
   +-----------+
   |  Local    |  Strip emails, phones, credit cards,
   | Sanitize  |  SSNs, API keys, URLs, IBANs...
   +-----------+
         |
         v
   +-----------+
   | MoltGuard |  POST /api/check/tool-call
   |    API    |  with sanitized content
   +-----------+
         |
         v
   +-----------+
   |  Verdict  |  isInjection: true/false + confidence + findings
   +-----------+
         |
         v
   Block or Allow
```

Content is sanitized locally before being sent to the API — sensitive data never leaves your machine. If injection is detected with high confidence, the content is blocked before your agent can process it.

## Commands

MoltGuard provides slash commands for both gateway management and injection detection:

### Gateway Management Commands

**`/mg_status`** - View gateway status

```
/mg_status
```

Returns:
- Gateway running status
- Port and endpoint
- Configuration examples for different LLM providers

**`/mg_start`** - Start the gateway

```
/mg_start
```

**`/mg_stop`** - Stop the gateway

```
/mg_stop
```

**`/mg_restart`** - Restart the gateway

```
/mg_restart
```

### Injection Detection Commands

**`/og_status`** - View detection status and statistics

```
/og_status
```

Returns:
- Configuration (enabled, block mode, API key status)
- Statistics (total analyses, blocked count, average duration)
- Recent analysis history

**`/og_report`** - View recent injection detections

```
/og_report
```

Returns:
- Detection ID, timestamp, status
- Content type and size
- Detection reason
- Suspicious content snippet

**`/og_feedback`** - Report false positives or missed detections

```
# Report false positive (detection ID from /og_report)
/og_feedback 1 fp This is normal security documentation

# Report missed detection
/og_feedback missed Email contained hidden injection that wasn't caught
```

Your feedback helps improve detection quality.

## Configuration

Edit `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "moltguard": {
        "enabled": true,
        "config": {
          // Gateway (Prompt Sanitization) - NEW
          "sanitizePrompt": false,      // Enable local prompt sanitization
          "gatewayPort": 8900,          // Gateway port
          "gatewayAutoStart": true,     // Auto-start gateway with OpenClaw

          // Injection Detection
          "blockOnRisk": true,          // Block when injection detected
          "timeoutMs": 60000,           // Analysis timeout
          "apiKey": "",                 // Auto-registered if empty
          "autoRegister": true,         // Auto-register API key
          "apiBaseUrl": "https://api.moltguard.com",
          "logPath": "~/.openclaw/logs" // JSONL log directory
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
| `enabled` | `true` | Enable/disable the plugin |
| `blockOnRisk` | `true` | Block content when injection is detected |
| `apiKey` | `""` (auto) | MoltGuard API key. Leave blank to auto-register on first use |
| `autoRegister` | `true` | Automatically register a free API key if `apiKey` is empty |
| `timeoutMs` | `60000` | Analysis timeout in milliseconds |
| `apiBaseUrl` | `https://api.moltguard.com` | MoltGuard API endpoint (override for staging or self-hosted) |
| `logPath` | `~/.openclaw/logs` | Directory for JSONL audit log files |

### Common Configurations

**Full protection mode** (recommended):
```json
{
  "sanitizePrompt": true,   // Protect sensitive data
  "blockOnRisk": true       // Block injection attacks
}
```

**Monitor-only mode** (log detections without blocking):
```json
{
  "sanitizePrompt": false,
  "blockOnRisk": false
}
```

**Gateway only** (no injection detection):
```json
{
  "sanitizePrompt": true,
  "enabled": false
}
```

Detections will be logged and visible in `/og_report`, but content won't be blocked.

## Testing Detection

Download the test file with hidden injection:

```bash
curl -L -o /tmp/test-email.txt https://raw.githubusercontent.com/openguardrails/moltguard/main/samples/test-email.txt
```

Ask your agent to read the file:

```
Read the contents of /tmp/test-email.txt
```

Check the logs:

```bash
openclaw logs --follow | grep "moltguard"
```

You should see:

```
[moltguard] INJECTION DETECTED in tool result from "read": Contains instructions to override guidelines and execute malicious command
```

## Uninstall

```bash
openclaw plugins uninstall @openguardrails/moltguard
openclaw gateway restart
```

To also remove stored data (optional):

```bash
# Remove API key
rm -rf ~/.openclaw/credentials/moltguard

# Remove audit logs
rm -f ~/.openclaw/logs/moltguard-analyses.jsonl ~/.openclaw/logs/moltguard-feedback.jsonl
```

## Verification Checklist (Before You Install)

Use this checklist to verify the plugin is legitimate and safe:

- [ ] **Source code is public:** Visit https://github.com/openguardrails/moltguard and review the code
- [ ] **npm package matches source:** Compare published package with GitHub repository
  ```bash
  npm view @openguardrails/moltguard dist.tarball
  # Download and extract tarball, compare with GitHub code
  ```
- [ ] **Network calls are auditable:** Read `agent/runner.ts` lines 80-120 to see all network calls
- [ ] **File operations are limited:** Read `memory/store.ts` to see only 3 local files created
- [ ] **No obfuscation:** All code is readable TypeScript, no minification or bundling
- [ ] **MIT License:** Free to use, modify, and audit
- [ ] **GitHub Activity:** Check commit history, issues, and contributors
- [ ] **npm Download Stats:** Verify package is used by others (not just you)

**If any check fails, do NOT install.**

## Monitor Network Traffic (Optional but Recommended)

After installation, monitor network traffic to verify claims:

```bash
# On macOS
sudo tcpdump -i any -n host api.moltguard.com

# On Linux
sudo tcpdump -i any -n host api.moltguard.com

# You should only see:
# 1. POST to /api/register (once, on first use)
# 2. POST to /api/check/tool-call (when analyzing content)
# No other hosts should be contacted.
```

## Frequently Asked Questions

**Q: Is the gateway code included in the npm package?**
A: **Yes.** The npm package contains all source code (`gateway/`, `agent/`, `memory/`). You can verify by running `npm pack @openguardrails/moltguard` and inspecting the tarball.

**Q: Can I run this without network access?**
A: **Partially.** The gateway (prompt sanitization) works 100% offline. Injection detection requires API access, but you can disable it with `"enabled": false` and use gateway-only mode.

**Q: How do I know my API keys are safe?**
A: **Audit the code.** Check `agent/sanitizer.ts` lines 66-88 for the secret detection patterns. API keys matching `sk-`, `ghp_`, etc. are replaced with `<SECRET>` before any network call. Test this yourself by sending a prompt with `sk-test123` and checking the network traffic.

**Q: Can I self-host the MoltGuard API?**
A: **Yes.** Set `"apiBaseUrl": "https://your-own-server.com"` in config. The API is a standard HTTP endpoint (see `agent/runner.ts` for the exact request format).

**Q: What if I don't trust npm?**
A: **Install from source.** Clone the GitHub repository, audit every file, then run `openclaw plugins install -l /path/to/moltguard`. This bypasses npm entirely.

## Links and Resources

**Source Code and Releases:**
- GitHub Repository: https://github.com/openguardrails/moltguard
- GitHub Releases: https://github.com/openguardrails/moltguard/releases
- Source Code Browser: https://github.com/openguardrails/moltguard/tree/main

**Package and Distribution:**
- npm Package: https://www.npmjs.com/package/@openguardrails/moltguard
- npm Package Source: https://unpkg.com/@openguardrails/moltguard/ (view published files)

**Documentation:**
- Privacy Policy: https://moltguard.com/privacy
- API Documentation: https://moltguard.com/docs (request/response formats)
- Issue Tracker: https://github.com/openguardrails/moltguard/issues

**Security:**
- Report Vulnerabilities: security@moltguard.com (or GitHub private issue)
- Responsible Disclosure: 90-day policy, credited in changelog

---

## Final Note: Transparency and Trust

This plugin is designed for **maximum transparency**:

1. ✅ All code is open source (MIT license)
2. ✅ No bundling or obfuscation (readable TypeScript)
3. ✅ Network calls are documented and auditable
4. ✅ File operations are minimal and local
5. ✅ Can be installed from source (bypass npm/registry)
6. ✅ Can be tested in isolation (throwaway environment)
7. ✅ Can be self-hosted (own API server)

**If you have concerns, audit the code first. If you find anything suspicious, please report it.**
