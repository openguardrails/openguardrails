# MoltGuard — Detailed Reference

## Security & Trust

**Open source and auditable.** All code is Apache 2.0 licensed at [github.com/openguardrails/openguardrails](https://github.com/openguardrails/openguardrails). Key files to review:

- `index.ts` — plugin entry point, all event hooks
- `agent/sanitizer.ts` — what gets sanitized before cloud transmission
- `agent/content-injection-scanner.ts` — local-only regex patterns
- `platform-client/` — every outbound network call (all go to `openguardrails.com/core` only)
- `agent/config.ts:65-68` — registration request (sends only `{ name, description }`)

**Inspect before installing:**
```bash
npm pack @openguardrails/moltguard --dry-run
npm pack @openguardrails/moltguard
tar -xzf openguardrails-moltguard-*.tgz && ls package/
```

**Network behavior:**

| State | Network calls | What is sent |
|-------|---------------|--------------|
| Installed (not registered) | None | Nothing — all protections are local-only |
| Registered (not activated) | One `POST /api/v1/agents/register` | `{ "name": "OpenClaw Agent", "description": "" }` only |
| Activated | `POST /api/v1/detect` per borderline tool call | Sanitized tool metadata — all PII/secrets replaced with placeholders locally |

Verify with `tcpdump`, `mitmproxy`, or Little Snitch — only destination is `openguardrails.com`.

**Fail-open design.** If cloud API is unreachable or times out, tool calls are allowed. Network issues never block your workflow.

**Credentials.** Stored at `~/.openclaw/credentials/moltguard/credentials.json`. Revoke from account portal or delete the file.

---

## How It Works

Hooks into `before_tool_call`, `after_tool_call`, and `tool_result_persist` events. Classifies every tool call in real time across the session. When agent reads files or fetches web pages, scans content for injection patterns and redacts them before the agent processes the content.

```
Agent calls tool
      ↓
[moltguard] classifies tool + updates session state
  • sensitive file read → then network call?      → BLOCK (local)
  • shell escape in params ($(), backtick)?        → BLOCK (local)
  • prompt injection in file/web content?          → REDACT in-place (local)
  • credential access + low intent overlap?        → assess via cloud
  • external domains + intent mismatch?            → assess via cloud
      ↓
Allow, redact, alert, or block — with explanation returned to agent
```

---

## Fast-Path Blocks (local, no cloud)

| Pattern | Example | Block reason |
|---------|---------|--------------|
| Read sensitive file → network call | Read `~/.ssh/id_rsa`, then `WebFetch` | `sensitive file read followed by network call to <domain>` |
| Read credentials → network call | Read `~/.aws/credentials`, then `Bash curl` | `sensitive file read followed by network call to <domain>` |
| Shell escape in params | `` `cmd` ``, `$(cmd)`, `;`, `&&`, `\|`, newline | `suspicious shell command detected — potential command injection` |

---

## Content Injection Detection (local, in-place redaction)

| Pattern Category | Description | Redaction marker |
|-----------------|-------------|------------------|
| Instruction override | Override/discard prior context | `__REDACTED_BY_OPENGUARDRAILS_DUE_TO_PROMPT_INJECTION__` |
| Fake system message | Spoofed system-level directives | `__REDACTED_BY_OPENGUARDRAILS_DUE_TO_PROMPT_INJECTION__` |
| Mode switching | Change agent operating mode | `__REDACTED_BY_OPENGUARDRAILS_DUE_TO_PROMPT_INJECTION__` |
| Concealment directive | Hide output from user | `__REDACTED_BY_OPENGUARDRAILS_DUE_TO_PROMPT_INJECTION__` |
| Command execution | Embedded shell commands | `__REDACTED_BY_OPENGUARDRAILS_DUE_TO_COMMAND_EXECUTION__` |
| Task hijacking | Redirect agent's current objective | `__REDACTED_BY_OPENGUARDRAILS_DUE_TO_PROMPT_INJECTION__` |
| Data exfiltration | Shell substitution targeting sensitive files | `__REDACTED_BY_OPENGUARDRAILS_DUE_TO_DATA_EXFILTRATION__` |

A single high-confidence match or 2+ medium-confidence matches from different categories triggers redaction. See `agent/content-injection-scanner.ts` for the full pattern list.

---

## Cloud-Assessed Patterns

| Tag | Risk | Action | Description |
|-----|------|--------|-------------|
| `READ_SENSITIVE_WRITE_NETWORK` | critical | block | Sensitive read followed by outbound call |
| `DATA_EXFIL_PATTERN` | critical | block | Large data read, then sent externally |
| `MULTI_CRED_ACCESS` | high | block | Multiple credential files accessed in one session |
| `SHELL_EXEC_AFTER_WEB_FETCH` | high | block | Shell command after fetching external content |
| `INTENT_ACTION_MISMATCH` | medium | alert | Tool sequence doesn't match stated user goal |
| `UNUSUAL_TOOL_SEQUENCE` | medium | alert | Statistical anomaly in tool ordering |

**Risk levels:**

| Risk Level | Action |
|------------|--------|
| critical | **block** — tool call blocked, agent sees block reason |
| high | **block** — tool call blocked, agent sees block reason |
| medium | **alert** — tool call allowed, warning logged |
| low / no_risk | **allow** — tool call proceeds normally |

**Block reason format:**
```
OpenGuardrails blocked [critical]: Sensitive file read followed by data
sent to external server. Agent accessed credentials despite low relevance
to user intent "fetch weather for user". (confidence: 97%)
```

**Sensitive file categories:** `SSH_KEY`, `AWS_CREDS`, `GPG_KEY`, `ENV_FILE`, `CRYPTO_CERT`, `SYSTEM_AUTH`, `BROWSER_COOKIE`, `KEYCHAIN`

---

## AI Security Gateway — Data Types Sanitized

| Data Type | Placeholder | Examples |
|-----------|-------------|----------|
| Email addresses | `__email_N__` | `user@example.com` |
| Credit cards | `__credit_card_N__` | `1234-5678-9012-3456` |
| Bank cards | `__bank_card_N__` | 16-19 digit card numbers |
| Phone numbers | `__phone_N__` | `+1-555-123-4567`, `+86-138-1234-5678` |
| API keys & secrets | `__secret_N__` | `sk-...`, `ghp_...`, Bearer tokens |
| IP addresses | `__ip_N__` | `192.168.1.1` |
| SSN | `__ssn_N__` | `123-45-6789` |
| IBAN | `__iban_N__` | `GB82WEST12345698765432` |
| URLs | `__url_N__` | `https://example.com/path` |

---

## Privacy & Data Protection

**Not retained:** Detection request payloads (sanitized tool metadata) are discarded after the response.

**Stored (for billing):** Agent ID, API key, email (after activation), plan tier, per-agent usage counts.

**Local sanitization placeholders (before cloud transmission):**

| Data Type | Placeholder |
|-----------|-------------|
| Email addresses | `<EMAIL>` |
| Credit card numbers | `<CREDIT_CARD>` |
| SSNs | `<SSN>` |
| IBANs | `<IBAN>` |
| IP addresses | `<IP_ADDRESS>` |
| Phone numbers | `<PHONE>` |
| URLs | `<URL>` |
| API keys & secrets | `<SECRET>` |

---

## Verify npm ↔ GitHub Provenance

```bash
# Check npm package metadata
npm view @openguardrails/moltguard repository.url
# → https://github.com/openguardrails/openguardrails.git

# Compare tarball against GitHub source
npm pack @openguardrails/moltguard
tar -xzf openguardrails-moltguard-*.tgz
git clone https://github.com/openguardrails/openguardrails.git
diff -r package/ openguardrails/moltguard/
```

---

## Test Detection

After email verification, OpenGuardrails sends a test email (subject: "Design Review Request") containing a hidden prompt injection. Save it as a `.txt` file and ask the agent to read it — MoltGuard will redact the injection.

Alternative: use the sample file from the repo:
```
https://raw.githubusercontent.com/openguardrails/openguardrails/main/moltguard/samples/popup-injection-email.txt
```

---

## Contact

- **Email**: thomas@openguardrails.com
- **GitHub**: [github.com/openguardrails/openguardrails](https://github.com/openguardrails/openguardrails)
