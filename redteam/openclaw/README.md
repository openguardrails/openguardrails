# openclaw red-team suites

Attack suites that target [**OpenClaw**](https://github.com/openclaw/openclaw)
agents. Each attack reproduces a technique that has been seen in the
wild or documented upstream.

- **Upstream:** https://github.com/openclaw/openclaw
- **ID prefix:** `OGR-OC-ATT-*`
- **Canary prefix:** `OGR-OC-CANARY-*` (embed in prompt + detector)

## Files

| File                         | What it exercises                                              |
| ---------------------------- | -------------------------------------------------------------- |
| `prompt-injection-itw.yaml`  | Fake system banners and gatewayUrl lures that have appeared in channel content and web pages OpenClaw agents fetch |

See [`../README.md`](../README.md) for the attack schema and contribution
flow.
