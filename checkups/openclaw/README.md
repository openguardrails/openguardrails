# openclaw checkups

Static checkups targeting [**OpenClaw**](https://github.com/openclaw/openclaw)
and the ClawHub skill ecosystem.

- **Upstream:** https://github.com/openclaw/openclaw
- **Install locations walked:** `~/.openclaw`, `~/.clawdbot`, project-local
  `.openclaw.json`, and lockfiles mentioning `openclaw` / `clawdbot`
- **ID prefix:** `OGR-OC-*`

## Files

| File                          | Category                   | What it catches                                               |
| ----------------------------- | -------------------------- | ------------------------------------------------------------- |
| `malicious-skill-ioc.yaml`    | `malicious-skill`          | ClawHub campaign IoCs (AMOS stealer C2, webhook exfil, typosquats) |
| `prompt-injection-itw.yaml`   | `malicious-skill`          | In-the-wild prompt-injection payloads seeded in agent-visible content |
| `dangerous-config.yaml`       | `dangerous-config`         | Gateway / Control UI / sandbox hardening gaps                 |
| `supply-chain.yaml`           | `vulnerable-plugin` / `dangerous-config` | ClawHub integrity pinning and trust-root escapes |
| `vulnerable-version.yaml`     | `vulnerable-plugin`        | Version pins matching published OpenClaw CVEs                 |

Every rule cites at least one public reference. See [`../README.md`](../README.md)
for the rule schema and contribution flow.
