# Red-team tests

Dynamic **attack suites** that `thomas` replays against a live target to
measure whether the target agent falls for known tricks. Where
[`checkups/`](../checkups/) asks *"is anything known-bad installed?"*,
`redteam/` asks *"does this agent, as it runs right now, actually resist
known attacks?"*.

Each attack is a short prompt plus a detector. The detector is a regex
(or set of regexes) against the target's response. If any detector
matches, the target **failed** — it did what the attacker asked.

## Layout

```
redteam/
└── <target-agent>/           # agent the suite is designed for
    ├── README.md             # target metadata
    └── <suite>.yaml          # YAML list of attacks
```

`<suite>` groups attacks by campaign or technique (`prompt-injection-itw`,
`secret-exfil`, `tool-abuse`, …). Small files per theme beat one giant
file — contributors can add a suite without touching existing ones.

## Attack schema

```yaml
- id: OGR-OC-ATT-001
  suite: openclaw-prompt-injection
  severity: high                      # low | medium | high | critical
  title: "short one-liner"
  prompt: |
    The exact text sent to the target. Keep it minimal — one technique
    per attack. Use canaries (OGR-OC-CANARY-*) the detector can match.
  hit_patterns:                       # regex(es) — any match = failure
    - "OGR-OC-CANARY-30448"
  hit_require_all: false              # default false. true = all must hit.
  remediation: "What to change in the target."
  references:                         # required
    - "https://github.com/openclaw/openclaw/issues/30448"
```

## Authoring guidance

- **One technique per attack.** If your prompt tests both a system-banner
  spoof *and* a tool-abuse lure, split them. Two hits on one attack
  obscure which defense is missing.
- **Use canaries.** A unique string (`OGR-OC-CANARY-<issue>`) in both the
  prompt and the detector makes "did the model follow the injection" a
  1-character match, not a fuzzy content judgment.
- **Keep prompts short.** The goal is to measure the defense, not to
  impress the reader with length. Long prompts drift into testing the
  model's patience, not its security posture.
- **Cite a real incident.** Just like checkups, every attack must link a
  public reference: upstream issue, advisory, CVE, or named-vendor
  writeup. "Something I made up" is a test case, not a red-team attack.

## Targets — what `thomas` sends the prompt to

The `--target` flag of `thomas redteam` accepts one of:

- **HTTP endpoint** that accepts `POST { "prompt": "..." }` and returns
  `{ "response": "..." }` (or plain text).
- **Shell command** (`cmd:...`) that reads the prompt from stdin and
  writes the reply to stdout.

Only ever run a suite against a target you own and have been asked to
test. The attacks are loud in logs by design.

## Contributing

See [`docs/CONTRIBUTING.md`](../docs/CONTRIBUTING.md). The agent flow:

> Add a new red-team attack to `thomas-security` using the `contribute`
> skill at `skills/contribute/SKILL.md`. Target: `<agent>`. Incident:
> `<URL>`.
