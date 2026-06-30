# Risk Taxonomy (semantic conventions)

Category IDs referenced by `Verdict.categories[].id`. Versioned and **swappable**:
the contract references IDs; it stays neutral on what is "unsafe" for a given use
case. In `v1` this graduates to its own repo
(`openguardrails-semantic-conventions`), mirroring OpenTelemetry.

Keywords per RFC 2119. IDs are namespaced `domain.category[.subcategory]`.

## `safety.*`

Harmful content/behavior, judged at the content I/O boundary.

| ID | Description |
|---|---|
| `safety.toxicity` | Harassment, hate, demeaning content. |
| `safety.self_harm` | Self-harm / suicide promotion or instructions. |
| `safety.sexual` | Sexual content; `safety.sexual.minors` (CSAM) is always block. |
| `safety.violence` | Violent threats or instructions. |
| `safety.weapons` | Illicit weapons / CBRN uplift. |
| `safety.illicit` | Other illicit-activity facilitation. |
| `safety.pii` | Personal data exposure (often `redact`). |
| `safety.brand` | Brand-safety / off-policy persona. |
| `safety.topic_violation` | Out-of-scope topic for a constrained agent. |
| `safety.hallucination` | Unsupported factual claim (where checkable). |

## `security.*`

System compromise, judged on actions and data flow.

| ID | Description |
|---|---|
| `security.prompt_injection` | Instruction in *data* attempting to change agent behavior. |
| `security.jailbreak` | Attempt to subvert the agent's own guardrails/policy. |
| `security.malicious_command` | Dangerous shell/exec (pipe-to-shell, destructive ops, obfuscation). |
| `security.data_exfiltration` | Sensitive data leaving the trust boundary. |
| `security.secret_leak` | Credentials/keys exposed in output, args, or env. |
| `security.ssrf` | Server-side request forgery / unexpected egress. |
| `security.privilege_escalation` | `sudo`, capability or scope escalation. |
| `security.sandbox_escape` | Attempt to break out of the sandbox. |
| `security.supply_chain` | Untrusted package / MCP / skill / model source. |
| `security.tool_poisoning` | Malicious tool/MCP **definition** (hidden instructions in descriptions/schemas). |

## Conventions

- A detector MUST use the most specific ID it can justify.
- Unknown/experimental categories MUST be namespaced under
  `x.<vendor>.<name>` and MUST NOT collide with `safety.*` / `security.*`.
- `score` is a detector-reported `0.0`–`1.0`; it is **not** comparable across
  vendors except through the [benchmark](https://github.com/openguardrails/openguardrails-bench),
  which is the entire reason the leaderboard exists.
