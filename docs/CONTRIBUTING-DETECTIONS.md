# Contributing detections

OpenGuardrails-OSS ships **local signature-based detections** only. No
cloud telemetry, no remote rule fetch, no heuristic LLM calls. A detection
lands in the open-source tree only after it has been publicly reported by
someone else (CVE, GHSA advisory, upstream GitHub issue, or a
named-vendor threat-intel writeup).

New detections are a single YAML entry plus a reference link. No
TypeScript changes needed.

## Scan signatures

Location:

```
src/scan/packs/<pack>/
├── pack.yaml                        # pack metadata
└── signatures/
    ├── malicious_skill_ioc.yaml     # one file per category
    ├── dangerous_config.yaml
    ├── prompt_injection_itw.yaml
    ├── vulnerable_version.yaml
    └── supply_chain.yaml
```

Each `signatures/*.yaml` is a YAML list of rule entries:

```yaml
- id: OGR-OC-SKILL-001                # uppercase, dash-separated, unique
  category: malicious-skill           # one of: malicious-skill |
                                      #   malicious-mcp-server |
                                      #   vulnerable-plugin |
                                      #   dangerous-config |
                                      #   suspicious-permission
  severity: critical                  # low | medium | high | critical
  title: "short one-liner shown in reports"
  description: >-
    Why this pattern matters. Link the threat actor / advisory in words here
    and the URL in references below.
  patterns:                           # regex strings (JS RegExp syntax)
    - "91\\.92\\.242\\.30"
  exclude_patterns:                   # optional: suppress false positives
    - "openclaw\\s+doctor"
  filename_matches:                   # optional: exact basename match
    - "openclaw.json"
  sha256:                             # optional: exact file hash
    - "…"
  references:                         # required — at least one
    - "https://github.com/openclaw/openclaw/security/advisories/GHSA-…"
    - "https://nvd.nist.gov/vuln/detail/CVE-…"
  remediation: "What the operator should do once this fires."
```

**A rule without `references` is rejected at load time.** That is the
bar: we only encode what someone public has already said. If you have a
novel finding, report it upstream first and link your advisory here.

### What each match knob is for

- `patterns` is the primary mechanism. Combined as `(?:p1)|(?:p2)|…`
  against the raw file text.
- `exclude_patterns` suppresses the finding when the same file also
  matches an allow-list regex. Use sparingly and cite the false positive.
- `filename_matches` is an exact case-insensitive basename compare, for
  rules that fire on "this specific config file exists at all".
- `sha256` is for byte-identical malicious artifacts you have a hash for.

## Redteam attacks

Location:

```
src/redteam/packs/<pack>/attacks/<suite>.yaml
```

Schema:

```yaml
- id: OGR-OC-ATT-001
  suite: openclaw-prompt-injection
  severity: high
  title: "short one-liner"
  prompt: |
    The exact text sent to the target.
  hit_patterns:                       # response regex(es) that mark a hit
    - "OGR-OC-CANARY-30448"
  hit_require_all: false              # default false (any pattern hits).
                                      # true means all patterns must hit.
  remediation: "What to change in the target."
  references:
    - "https://github.com/openclaw/openclaw/issues/30448"
```

## Reference-quality bar

References must be stable, attributable, and not authored by us. In order
of preference:

1. CVE / NVD entry.
2. Published GHSA advisory (upstream project's security tab).
3. Upstream GitHub issue with engagement from maintainers.
4. Named-vendor threat-intel post (Trend Micro, Bitdefender, SentinelOne,
   Snyk, The Hacker News, etc.) that cites the original research.
5. Academic or coordinated-disclosure writeup.

A Medium post, screenshot-only tweet, or self-authored blog post does
**not** qualify on its own. If the only source is your own analysis, file
it upstream with the affected project first.

## Checklist before opening a PR

- [ ] One rule per PR, unless the rules are a single campaign batch.
- [ ] `id` is globally unique. Prefix with the pack (`OGR-OC-*` for
      OpenClaw) so conflicts are obvious.
- [ ] `references` points at something the maintainer of the affected
      project (or a named research team) published.
- [ ] The pattern was tested against a real sample or an upstream PoC,
      not just written from memory.
- [ ] `remediation` tells the operator what to actually do — not just
      "remove it".
- [ ] `bun test` and `bun src/cli.ts scan` still pass on a clean tree.
