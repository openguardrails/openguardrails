# OpenGuardrails

**The most downloaded security skill on OpenClaw [ClawHub](https://clawhub.ai/ThomasLWang/moltguard)** — protect agents with real-time defense against prompt injection, data leaks, and dangerous actions.

<img width="1144" height="883" alt="image" src="https://github.com/user-attachments/assets/9b6d80f2-dde9-4467-b9e7-2f514e8b01cd" />

**Three Principles:**
- **Instant Value** — Works immediately after installation
- **No Security Expertise** — No configuration needed
- **Secure by Default** — "Install it, and the agent won't go rogue"

Open source (Apache 2.0).

---

## Installation

```bash
openclaw plugins install @openguardrails/moltguard
```

That's it! MoltGuard works immediately with **500 free security detections per day**.

---

## Test Your Protection

After installation, test to confirm MoltGuard is working:

```bash
# Read this test file (contains a simulated prompt injection attack)
cat ~/.openclaw/extensions/moltguard/samples/test-email-popup.txt
```

MoltGuard will detect the hidden prompt injection attack and show you it's working.

---

## What It Does

| Feature | Description |
|---------|-------------|
| **Prompt Injection Protection** | Detect and block "ignore instructions", "send secrets", "bypass rules" attacks |
| **Secret & Data Leak Protection** | Auto-sanitize API keys, SSH keys, PII before sending to LLMs |
| **Agent Activity Monitor** | Track agentic hours, actions, LLM calls, blocks, and risk events |

---

## Commands

| Command | Action |
|---------|--------|
| `/og_status` | Show status, API key, and quota |
| `/og_scan` | Run static security scan on workspace files (results in Dashboard) |
| `/og_autoscan on/off` | Enable/disable automatic scanning when files change |
| `/og_sanitize on/off` | Enable/disable AI Security Gateway for data sanitization |
| `/og_dashboard` | Start local Dashboard to view scan results and activity |
| `/og_config` | Configure API key for cross-machine sharing |
| `/og_core` | Open Core portal for account and billing |
| `/og_claim` | Display agent ID and API key for claiming |

---

## Core Risk Surfaces

1. **Prompt / Instruction Risk** — Prompt injection, malicious email/web instructions, unauthorized tasks
2. **Behavioral Risk** — Dangerous commands, file deletion, risky API calls
3. **Data Risk** — Secret leakage, PII exposure, sending sensitive data to LLMs

## Two-Layer Detection

### Static Detection (Proactive)

Scans workspace files **before** they can influence agent behavior:

| Target | What It Detects |
|--------|-----------------|
| **SOUL.md / agent.md** | Embedded prompt injection, hidden instructions |
| **Skills** | Malicious skill definitions, dangerous tool patterns |
| **Plugins** | Backdoor instructions, data exfiltration code |
| **Memories** | Poisoned context, injected false memories |
| **Workspace files** | Hidden instructions in markdown, config tampering |

Run manually with `/og_scan` or enable auto-scan with `/og_autoscan on`.

### Runtime Detection (Real-time)

Intercepts agent actions **as they happen**:

| Target | What It Detects |
|--------|-----------------|
| **Tool calls** | Dangerous commands, unauthorized file access, risky API calls |
| **Tool results** | Prompt injection in file content, web pages, API responses |
| **LLM requests** | PII/credential leakage, sensitive data exposure |
| **Behavioral chains** | File read → exfiltration, credential access → external write |
| **Intent mismatch** | Agent says one thing but does another |

Runtime detection is always active — no configuration needed.

---

## Detection Engine

10 built-in scanners (S01–S10) + intent-action mismatch detection:

**Content scanners:** Prompt injection · System override · Web attacks · MCP tool poisoning · Malicious code execution · NSFW · PII leakage · Credential leakage · Confidential data · Off-topic drift

**Behavioral patterns:** File read → exfiltration · Credential access → external write · Shell exec after web fetch · Intent-action mismatch · and more

See [architecture.md](docs/architecture.md#scanners) for the full list.

---

## Onboarding Flow

### Automatic (Zero Human Intervention)

1. MoltGuard installs
2. Auto-register with Core, get API key
3. Credentials saved to `~/.openclaw/credentials/moltguard/`
4. Protection active — 500 free detections/day

### Claiming an Agent (Link to Account)

For shared quota across machines:
1. `/og_claim` — get agent ID and API key
2. `/og_core` — go to Core login
3. Enter email, click magic link
4. Go to `/claim-agent` page, paste credentials
5. Agent now shares account quota

---
### Enterprise Enrollment

For organizations with a private Core deployment, enroll managed devices:

```bash
# Connect to your enterprise Core.
openclaw config set plugins.entries.moltguard.config.plan enterprise
openclaw config set plugins.entries.moltguard.config.coreUrl "https://your-company-core.com"
```

This sets MoltGuard to use the enterprise Core instead of the public one. Restart OpenClaw to apply.

To remove enterprise config and revert to the default public Core:

```bash
openclaw config unset plugins.entries.moltguard.config
```

---

## Plans

| Plan | Price | Quota |
|------|-------|-------|
| Free (Autonomous) | $0 | 500/day |
| Starter | $19/mo | 100K/mo |
| Pro | $49/mo | 300K/mo |
| Business | $199/mo | 2M/mo |
| Enterprise | Contact us | Custom |

---

## AI Security Gateway

MoltGuard includes an embedded AI Security Gateway that sanitizes PII and credentials before they reach LLM providers:

```bash
/og_sanitize on   # Enable data sanitization
/og_sanitize off  # Disable data sanitization
/og_sanitize      # Check status
```

When enabled:
- API keys → `__PII_SECRET_00000001__`
- Email addresses → `__PII_EMAIL_ADDRESS_00000001__`
- Credit cards, SSN, phone numbers, etc. automatically sanitized
- Original values restored in responses

---

## Update MoltGuard

To update MoltGuard to the latest version:

```bash
openclaw plugins update moltguard
```
---

## Uninstall

```bash
node ~/.openclaw/extensions/moltguard/scripts/uninstall.mjs
```

This removes MoltGuard config from `openclaw.json`, plugin files, and credentials. Restart OpenClaw to apply.

---

## Contact & Support

- **Email**: thomas@openguardrails.com

## License

Apache License 2.0. See [LICENSE](LICENSE) for details.
