---
name: openguardrails
description: "Behavioral anomaly detection for OpenClaw agents. Detects data exfiltration patterns, credential access, shell escapes, and intent-action mismatch. Source: github.com/openguardrails/openguardrails"
metadata: {"openclaw":{"emoji":"🛡️","homepage":"https://github.com/openguardrails/openguardrails"}}
---

# OpenGuardrails

Behavioral anomaly detection for OpenClaw agents. Monitors tool call sequences and blocks suspicious patterns (data exfiltration, credential access, shell injection) before they execute.

## How It Works

The plugin hooks into `before_tool_call` and `after_tool_call` events. It tracks each session's tool chain and computes local signals (sensitive file reads, external network calls, shell escapes). Critical patterns are blocked instantly on the local fast path; medium-risk signals are sent to the cloud API for assessment.

```
Agent calls tool
      ↓
[openguardrails] classifies tool + updates session state
  • sensitive file read → then network call?      → BLOCK (local)
  • shell escape in params ($(), backtick)?        → BLOCK (local)
  • credential access + low intent overlap?        → assess via cloud
  • external domains + intent mismatch?            → assess via cloud
      ↓
Allow, alert, or block — with explanation
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

- Status:    not registered — run `/og_activate` to register
- Platform:  https://platform.openguardrails.com

- blockOnRisk: true
```

---

## Step 2: Register

Registration is triggered by running `/og_activate`. It calls `POST /api/v1/agents/register` on the platform and saves credentials to:

```
~/.openclaw/credentials/openguardrails/credentials.json
```

Run:

```bash
/og_activate
```

If the platform is reachable, you'll see:

```
OpenGuardrails: Claim Your Agent

Agent ID: <uuid>

Complete these steps to activate behavioral detection:

  1. Visit:  https://platform.openguardrails.com/claim/<token>
  2. Code:   <word-XXXX>  (e.g. reef-X4B2)
  3. Email:  your email becomes your dashboard login

After claiming you get 30,000 free detections.
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

If you already have a key (e.g. from a previous registration or from the account portal), set it directly — no `/og_activate` needed:

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

After registration, complete these steps to activate:

1. **Visit the claim URL** shown by `/og_activate`
2. **Enter the verification code** (the `word-XXXX` code displayed in the terminal)
3. **Enter your email** — this becomes your account identity
4. **Click the verification link** sent to your email

Once your email is verified, the agent status changes to `active` and behavioral detection begins. The plugin polls for activation status automatically — no restart needed.

Check status anytime:

```bash
/og_status
```

Active output:
```
OpenGuardrails Status

- Agent ID:  <uuid>
- API Key:   sk-og-xxxxxxxxxxxx...
- Email:     you@example.com
- Platform:  https://platform.openguardrails.com
- Status:    active

- blockOnRisk: true
```

---

## Account & Portal

After activation, sign in to the account portal with your **email + API key**:

```
https://platform.openguardrails.com/login
```

The portal shows:

- **Account overview** — plan, quota usage, all agents under your email
- **Agent management** — view API keys, regenerate keys
- **Usage logs** — per-agent request history with latency and endpoint breakdown
- **Plan upgrades** — upgrade from Free to Starter, Pro, or Business

### Plans

| Plan | Price | Detections/mo |
|------|-------|---------------|
| Free | $0 | 30,000 |
| Starter | $19/mo | 100,000 |
| Pro | $49/mo | 300,000 |
| Business | $199/mo | 2,000,000 |

If you register multiple agents with the same email, they all share one account and quota.

---

## Commands

| Command | Description |
|---------|-------------|
| `/og_status` | Show registration status, email, platform URL, blockOnRisk setting |
| `/og_activate` | Register (if needed) and show claim URL and activation instructions |

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

| Pattern | Example | Block reason |
|---------|---------|--------------|
| Read sensitive file → network call | Read `~/.ssh/id_rsa`, then `WebFetch` to external URL | `sensitive file read followed by network call to <domain>` |
| Read credentials → network call | Read `~/.aws/credentials`, then `Bash curl ...` | `sensitive file read followed by network call to <domain>` |
| Shell escape in params | `Bash` with `` `cmd` ``, `$(cmd)`, `;`, `&&`, `\|`, or newline injection | `suspicious shell command detected — potential command injection` |

### Cloud-assessed patterns

| Tag | Risk | Action | Description |
|-----|------|--------|-------------|
| `READ_SENSITIVE_WRITE_NETWORK` | critical | block | Sensitive read followed by outbound call |
| `DATA_EXFIL_PATTERN` | critical | block | Large data read, then sent externally |
| `MULTI_CRED_ACCESS` | high | block | Multiple credential files accessed in one session |
| `SHELL_EXEC_AFTER_WEB_FETCH` | high | block | Shell command executed after fetching external content |
| `INTENT_ACTION_MISMATCH` | medium | alert | Tool sequence doesn't match stated user goal |
| `UNUSUAL_TOOL_SEQUENCE` | medium | alert | Statistical anomaly in tool ordering |

### Risk levels and actions

| Risk Level | Action | Meaning |
|------------|--------|---------|
| critical | **block** | Tool call is blocked, agent sees block reason |
| high | **block** | Tool call is blocked, agent sees block reason |
| medium | **alert** | Tool call is allowed, warning logged |
| low / no_risk | **allow** | Tool call proceeds normally |

### Block reason format

When a tool call is blocked, the agent receives a message like:

```
OpenGuardrails blocked [critical]: Sensitive file read followed by data
sent to external server. Agent accessed credentials despite low relevance
to user intent "fetch weather for user". (confidence: 97%)
```

### Sensitive file categories recognized

`SSH_KEY`, `AWS_CREDS`, `GPG_KEY`, `ENV_FILE`, `CRYPTO_CERT`, `SYSTEM_AUTH`, `BROWSER_COOKIE`, `KEYCHAIN`

---

## Privacy

- Tool params are **sanitized** (PII and secrets stripped) before being sent to the cloud API
- The cloud API receives: sanitized params, tool names, session signals — **not** raw file contents or user messages
- Credentials are stored locally at `~/.openclaw/credentials/openguardrails/credentials.json`
- The plugin **fails open**: if the cloud API is unreachable or times out, the tool call is allowed
- Only medium+ risk signals trigger a cloud call — low-risk / no-risk tool calls never leave the machine
- Fast-path blocks (shell escape, read-then-exfil) are fully local — no cloud round-trip

---

## Uninstall

```bash
openclaw plugins uninstall openguardrails

# Optionally remove credentials
rm -rf ~/.openclaw/credentials/openguardrails
```
