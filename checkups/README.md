# Checkups

Static, offline **security checkups** for AI agents. The `thomas` CLI
loads every `*.yaml` file under this directory and runs the rules inside
against the target agent's install (skills, plugins, config files, MCP
servers, lockfiles…).

Checkups are the defender-side equivalent of malware signatures: cheap,
reproducible, and auditable. They answer *"is this agent running anything
known-bad?"*

## Layout

```
checkups/
└── <target-agent>/           # one directory per agent product
    ├── README.md             # target metadata (upstream, scope, contact)
    ├── <category>.yaml       # YAML list of rules
    └── ...
```

`<target-agent>` is the name of the agent being audited (e.g., `openclaw`).
Each YAML file groups rules by category so large files stay browsable.

Suggested categories:

| Category              | What fires                                                |
| --------------------- | --------------------------------------------------------- |
| `malicious-skill`     | Known-bad skills, IoCs, campaign artifacts                |
| `malicious-mcp-server`| Known-bad MCP server images, commands, or endpoints       |
| `vulnerable-plugin`   | Version pins that match a published advisory              |
| `dangerous-config`    | Settings that weaken the agent's default security posture |
| `suspicious-permission`| Grants that exceed the agent's principle of least priv   |
| `supply-chain`        | Registry, integrity, or trust-root hygiene                |

## Rule schema

```yaml
- id: OGR-OC-SKILL-001                # uppercase, dash-separated, unique
  category: malicious-skill
  severity: critical                  # low | medium | high | critical
  title: "short one-liner shown in reports"
  description: >-
    Why this pattern matters. State the threat model, name the actor or
    advisory, and explain what the agent loses if this fires.
  patterns:                           # regex strings (JS RegExp syntax)
    - "91\\.92\\.242\\.30"
  exclude_patterns:                   # optional: suppress false positives
    - "openclaw\\s+doctor"
  filename_matches:                   # optional: exact basename match
    - "openclaw.json"
  sha256:                             # optional: exact file hash
    - "abc123..."
  references:                         # required — at least one
    - "https://github.com/openclaw/openclaw/security/advisories/GHSA-..."
    - "https://nvd.nist.gov/vuln/detail/CVE-..."
  remediation: "What the operator should do once this fires."
```

**A rule without `references` is rejected at load time.** Every rule must
cite a CVE, GHSA advisory, upstream issue, or named-vendor threat-intel
writeup. We encode public knowledge; novel research goes upstream first.

### Field reference

- `patterns` — primary match. Combined as `(?:p1)|(?:p2)|…` against the
  raw file text. Write them in JS `RegExp` syntax (as a string — escape
  backslashes).
- `exclude_patterns` — allow-list regex. Suppresses the finding when the
  same file also matches. Cite the false positive you're suppressing.
- `filename_matches` — case-insensitive basename compare. Use when the
  rule fires on *"this specific config file exists at all"*.
- `sha256` — byte-identical artifact hashes. Use when you have a sample.

## Contributing

See [`docs/CONTRIBUTING.md`](../docs/CONTRIBUTING.md) for the human-facing
flow. The fastest path is to let your agent do it — paste this to any
agent that has read/write access to the repo:

> Add a new checkup to `thomas-security` using the `contribute` skill
> at `skills/contribute/SKILL.md`. Target: `<agent>`. The advisory is
> at `<URL>`.

The skill walks the agent through rule drafting, ID assignment, local
validation, and PR submission.

## Adding a new target agent

To audit an agent we don't cover yet (e.g., `cursor`, `hermes`):

1. `mkdir checkups/<agent>`
2. Create `checkups/<agent>/README.md` with the agent's name, upstream
   URL, install locations the scanner should walk, and any maintainer
   notes.
3. Add at least one rule YAML file.
4. Open a PR.
