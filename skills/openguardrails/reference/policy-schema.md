# OGR policy schema (reference)

An OGR `policy.json` is the single source of truth for both **detection**
(allow/block/require_approval) and **enforcement** (what the sandbox permits). One
file drives every altitude and compiles to whichever sandbox backend you use. Write a
different policy per deployment (different threat model) — always in the same model.

Top-level keys: `composition`, `sandbox`, `config_rules`.

## composition — merge detector verdicts

Per risk category, choose how multiple detectors combine and how to fail.

```json
"composition": {
  "security.*":      { "strategy": "deny-wins", "on_all_failed": "block" },
  "safety.toxicity": { "strategy": "quorum", "quorum": { "count": 2, "min_score": 0.8 }, "on_all_failed": "allow" },
  "default":         { "strategy": "deny-wins" }
}
```

- `strategy`: `deny-wins` (any block blocks) or `quorum` (N detectors must agree).
- Fail **closed** (`on_all_failed: block`) for `security.*`; **open** for low-risk.

## sandbox — the enforcement boundary

Described once; OGR compiles it to the backend (srt for personal, OpenShell for
multi-tenant).

```json
"sandbox": {
  "workspace_write":  [".", "/tmp"],
  "deny_read":        ["~/.ssh", "~/.aws", "~/.netrc", "~/.hermes/auth.json"],
  "deny_write":       [".env", "~/.gitconfig"],
  "egress_allowlist": ["api.github.com", "*.github.com", "pypi.org"],
  "deny_egress":      [],
  "resource_limits":  { "cpus": 2, "memory_mb": 2048, "pids": 256 }
}
```

| Field | Meaning | srt | OpenShell |
| --- | --- | --- | --- |
| `egress_allowlist` | deny-by-default network; allow these (`*.` wildcards) | `network.allowedDomains` | Rego `allowed_domains` |
| `deny_read` | paths the agent can't read | `filesystem.denyRead` | sandbox `deny_read` |
| `workspace_write` | the only writable paths | `filesystem.allowWrite` | workspace mount |
| `deny_write` | carve-outs inside the workspace | `filesystem.denyWrite` | sandbox `deny_write` |
| `resource_limits` | cpu / memory / pids caps | (single process) | container limits |

## config_rules — the deterministic detector

Regex command rules + markers, evaluated at the agent-hook and sandbox altitudes.
Prefer **resource-based** rules (match the sensitive path/host) over verb-based ones,
so a rephrased command can't slip past.

```json
"config_rules": {
  "egress_allowlist": ["api.github.com", "pypi.org"],
  "secret_env_markers": ["SECRET", "TOKEN", "AWS_", "PASSWORD", "PRIVATE_KEY"],
  "command_rules": [
    {
      "id": "secret-file-access",
      "regex": "(\\.env\\b|/\\.aws/credentials|/\\.ssh/id_|auth\\.json)",
      "category": "security.secret_leak", "domain": "security",
      "decision": "block", "score": 0.95,
      "why": "command references a credential file — independent of the reader"
    }
  ]
}
```

Each rule: `id`, `regex`, `category`, `domain`, `decision`
(`allow` | `block` | `require_approval`), `score`, `why`.

## Where the policy lives

- Point `OGR_POLICY=/path/to/policy.json` at your file. With no override, the
  runtime's bundled default is used. An explicit `OGR_POLICY` wins.
- `OGR_SANDBOX=srt` (personal) enables OS-level enforcement; multi-tenant uses the
  container backend.

Full machine schema: https://github.com/openguardrails/openguardrails
(`schema/guard-event.schema.json`, `schema/verdict.schema.json`).
