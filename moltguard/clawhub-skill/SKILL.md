---
name: moltguard
version: 6.6.17
description: "MoltGuard — runtime security plugin for OpenClaw agents by OpenGuardrails. Helps users install, register, activate, and check the status of MoltGuard. Use when the user asks to: install MoltGuard, check MoltGuard status, register or activate MoltGuard, configure the AI Security Gateway, or understand what MoltGuard detects. Provides local-first protection against data exfiltration, credential theft, command injection, and sensitive data leakage. Source: https://github.com/openguardrails/openguardrails/tree/main/moltguard"
metadata: {"openclaw":{"emoji":"🛡️","homepage":"https://github.com/openguardrails/openguardrails/tree/main/moltguard","keywords":["security","prompt-injection","data-exfiltration","pii","credential-theft","command-injection","guardrails","safety","agent-security","moltguard"]}}
---

# MoltGuard

Runtime security guard for OpenClaw agents by [OpenGuardrails](https://github.com/openguardrails/openguardrails). Open source (Apache 2.0), fully auditable.

**ClawHub**: [`ThomasLWang/moltguard`](https://clawhub.ai/ThomasLWang/moltguard) · **npm**: [`@openguardrails/moltguard`](https://www.npmjs.com/package/@openguardrails/moltguard) · **GitHub**: [`openguardrails/openguardrails/tree/main/moltguard`](https://github.com/openguardrails/openguardrails/tree/main/moltguard)

---

## Security & Provenance

**Verify provenance before installing.** The npm package should match the auditable GitHub source. To check:
```bash
# Download and inspect the package contents
npm pack @openguardrails/moltguard --dry-run

# Or do a full diff against the cloned repo:
mkdir /tmp/moltguard-audit && cd /tmp/moltguard-audit
npm pack @openguardrails/moltguard
tar -xzf openguardrails-moltguard-*.tgz
git clone https://github.com/openguardrails/openguardrails
diff -r package/scripts openguardrails/moltguard/scripts
```
Prefer source install if you have low trust in the publisher: `openclaw plugins install -l ./openguardrails/moltguard`

**What `activate.mjs` does:** Makes an outbound call to `https://www.openguardrails.com/core` to register the agent. Once you visit the claim URL and verify your email, the returned API key is written to `~/.openclaw/credentials/moltguard/credentials.json`. Do not activate if you do not trust this endpoint. All local protections work without activation.

**Network behavior:**
- _Before activation_: no outbound calls are made. Fully air-gapped local detection.
- _After activation_: each agent tool call sends a behavioral assessment request to `https://www.openguardrails.com/core`. No message content is sent — only tool names, sequence, and metadata.

**Least privilege:** Treat the API key written by activation as sensitive. Rotate or revoke it via the account portal (`https://www.openguardrails.com/core/login`) if needed. You can keep local-only protections indefinitely by simply not activating the cloud component.

---

## What to Consider Before Installing

Before installing or running `activate.mjs`:

**1. Verify provenance.**
Compare the npm package to the GitHub source (`npm pack` + diff) as described in the Security & Provenance section above. Only proceed if the contents match the source you trust.

**2. Inspect the scripts yourself.**
`scripts/activate.mjs` and `scripts/status.mjs` are short and readable. Review them directly before running.

**3. Understand what activation writes.**
Activation writes an API key to `~/.openclaw/credentials/moltguard/credentials.json`. If you later distrust the endpoint, delete that file and revoke the key via the platform portal.

**4. Activate from a monitored environment if you need high assurance.**
Use `tcpdump`, `mitmproxy`, or Little Snitch to confirm outbound destinations and that payloads contain only sanitized metadata — not message content.

> **Local protections remain fully functional without activation** — no outbound calls, no credentials written.

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
After running, show the user the claim URL. Tell them to visit the URL and provide their email to complete activation. On success, an API key is written to `~/.openclaw/credentials/moltguard/credentials.json` — inform the user so they know a credential file was created.

---

## Installation

When the user asks to install MoltGuard, run these steps:

```bash
# 1. Install the plugin
openclaw plugins install @openguardrails/moltguard

# 2. Restart the gateway to load the plugin
openclaw gateway restart

# 3. Register and show activation link
node {baseDir}/scripts/activate.mjs
```

After running step 3, show the user the **claim URL** from the output. Tell them to visit the URL and enter their email to complete activation.

Local protections are active immediately after restart — no registration required. Cloud behavioral detection requires activation.

## Update

```bash
# 1. Update the plugin
openclaw plugins update moltguard

# 2. Restart the gateway to load the plugin
openclaw gateway restart

# 3. Check status
node {baseDir}/scripts/status.mjs
```

After updating, run step 3 to confirm the plugin is loaded and show the current activation status.

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
| `dashboardUrl` | `https://www.openguardrails.com/dashboard` | Dashboard URL for observation reporting |
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
rm -rf ~/.openclaw/extensions/moltguard
# Remove moltguard configs from ~/.openclaw/openclaw.json
rm -rf ~/.openclaw/credentials/moltguard   # optional
```

---

## Reference

For detailed information on security & trust, detection patterns, privacy policy, and gateway data types, read `references/details.md`.
