---
name: openguardrails
description: "Behavioral anomaly detection for OpenClaw agents. Detects data exfiltration patterns, credential access, shell escapes, and intent-action mismatch. Source: github.com/openguardrails/openguardrails"
metadata: {"openclaw":{"emoji":"🛡️","homepage":"https://github.com/openguardrails/openguardrails"}}
---

# OpenGuardrails

Behavioral anomaly detection for OpenClaw agents. Monitors tool call sequences and blocks suspicious patterns (data exfiltration, credential access, shell injection) before they execute.

## How It Works

The plugin hooks into every `before_tool_call` event. It tracks each session's tool chain and computes local signals (sensitive file reads, external network calls, shell escapes). High-risk patterns are blocked immediately; borderline cases are sent to the cloud API for a second opinion.

```
Agent calls tool
      ↓
[openguardrails] checks local signals
  • sensitive file read → then network call?  → BLOCK
  • shell escape in params ($(), backtick)?   → BLOCK
  • unusual sequence for stated intent?       → ask cloud
      ↓
Allow or block with reason
```

No content is sent externally until the plugin is registered and activated.

---

## Step 1: Install

Install from npm or directly from source:

```bash
# From npm
openclaw plugins install @openguardrails/openclaw-security

# From source (audit first, then install)
git clone https://github.com/openguardrails/openguardrails.git
openclaw plugins install -l ./openguardrails/openclaw-security
```

**Installation completes immediately — no network calls are made at install time.** The plugin loads, creates a `BehaviorDetector`, and waits.

Verify it's loaded:
```bash
/og_status
```

Expected output when not yet registered:
```
OpenGuardrails Status

- Not registered (autoRegister: true)
- Platform:  https://platform.openguardrails.com

- blockOnRisk: true
```

---

## Step 2: Register

Registration happens automatically on the first tool call (if `autoRegister: true`, the default). It calls `POST /api/v1/agents/register` on the platform and saves credentials to:

```
~/.openclaw/credentials/openguardrails/credentials.json
```

To register immediately without waiting for a tool call, run:

```bash
/og_activate
```

If the platform is reachable, you'll see:

```
OpenGuardrails: Claim Your Agent

Agent ID: <id>

Complete these steps to activate behavioral detection:

  1. Visit:  https://platform.openguardrails.com/claim/<token>
  2. Code:   <6-digit code>
  3. Email:  provide address for alerts and quota notifications

You get 100,000 free detections after verification.
```

### Pointing to a local platform

For local development, override the platform URL in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "openguardrails": {
        "enabled": true,
        "config": {
          "platformUrl": "http://localhost:3002"
        }
      }
    }
  }
}
```

Then start the platform:
```bash
cd openguardrails/core && npm run db:migrate && npm run dev
# Listening on port 3002
```

### Using an existing API key

If you already have a key (e.g. from a previous registration or from the dashboard), set it directly — no `/og_activate` needed:

```json
{
  "plugins": {
    "entries": {
      "openguardrails": {
        "config": {
          "apiKey": "sk-og-<your-key>"
        }
      }
    }
  }
}
```

---

## Step 3: Activate

After registration, visit the claim URL shown by `/og_activate` and enter the verification code. Once claimed, behavioral detection is fully active.

Check status anytime:

```bash
/og_status
```

Active output:
```
OpenGuardrails Status

- Agent ID:  <id>
- API Key:   sk-og-xxxxxxxxxxxx...
- Platform:  https://platform.openguardrails.com
- Status:    active

- blockOnRisk: true
```

---

## Commands

| Command | Description |
|---------|-------------|
| `/og_status` | Show registration status, platform URL, blockOnRisk setting |
| `/og_activate` | Show claim URL and activation instructions (or confirm active) |

---

## Configuration Reference

All options go in `~/.openclaw/openclaw.json` under `plugins.entries.openguardrails.config`:

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `true` | Enable/disable the plugin |
| `blockOnRisk` | `true` | Block the tool call when risk is detected |
| `apiKey` | `""` | Explicit API key (`sk-og-...`). Run `/og_activate` if empty |
| `agentName` | `"OpenClaw Agent"` | Name shown in the dashboard |
| `platformUrl` | `https://platform.openguardrails.com` | Platform API endpoint |
| `timeoutMs` | `60000` | Cloud assessment timeout (ms). Fails open on timeout |

---

## What Gets Detected

### Fast-path blocks (local, no cloud round-trip)

| Pattern | Example |
|---------|---------|
| Read sensitive file → network call | Read `~/.ssh/id_rsa`, then call `WebFetch` |
| Read credentials → network call | Read `~/.aws/credentials`, then `Bash curl ...` |
| Shell escape in params | `Bash` with `` `cmd` ``, `$(cmd)`, or newline injection |

### Cloud-assessed patterns

| Tag | Description |
|-----|-------------|
| `READ_SENSITIVE_WRITE_NETWORK` | Sensitive read followed by outbound call |
| `MULTI_CRED_ACCESS` | Multiple credential files accessed in one session |
| `SHELL_EXEC_AFTER_WEB_FETCH` | Shell command executed after fetching external content |
| `DATA_EXFIL_PATTERN` | Large data read, then sent externally |
| `INTENT_ACTION_MISMATCH` | Tool sequence doesn't match stated user goal |
| `UNUSUAL_TOOL_SEQUENCE` | Statistical anomaly in tool ordering |

### Sensitive file categories recognized

`SSH_KEY`, `AWS_CREDS`, `GPG_KEY`, `ENV_FILE`, `CRYPTO_CERT`, `SYSTEM_AUTH`, `BROWSER_COOKIE`, `KEYCHAIN`

---

## Privacy

- Tool params are sanitized (PII and secrets stripped) before being sent to the cloud API
- The cloud API receives: sanitized params, tool names, session signals — **not** raw file contents or user messages
- Credentials are stored locally at `~/.openclaw/credentials/openguardrails/credentials.json`
- The plugin fails open: if the cloud API is unreachable, the tool call is allowed

---

## Uninstall

```bash
openclaw plugins uninstall openguardrails

# Optionally remove credentials
rm -rf ~/.openclaw/credentials/openguardrails
```
