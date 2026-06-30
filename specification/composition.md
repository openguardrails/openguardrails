# Composition

When multiple vendors judge one event, the runtime must combine their
[`Verdict`](verdict.md)s into one **effective verdict**. Composition is the
deployer's real policy — not "write rules," but "orchestrate vendors." OGR
standardizes the *mechanism*; the choices stay the deployer's. Keywords per
RFC 2119.

## Policy shape

Composition is configured per risk category (or category prefix). A runtime MUST
support at least the `deny-wins`, `quorum`, and `first-available` strategies.

```yaml
composition:
  # security defaults conservative: any vendor blocking blocks the action
  "security.*":
    providers: [vendorA, vendorB, ogr.poc.config_rules]
    strategy: deny-wins
    timeout_ms: 200
    on_timeout: degrade        # drop the slow provider, decide on the rest
    on_all_failed: block       # fail closed for security

  # safety toxicity tuned to reduce false positives via a vote
  "safety.toxicity":
    providers: [vendorX, vendorY, vendorZ]
    strategy: quorum
    quorum: { count: 2, min_score: 0.8 }
    on_all_failed: allow       # fail open for low-severity safety

  "security.malicious_command":
    providers: [ogr.poc.config_rules, ogr.poc.llm_judge]
    strategy: deny-wins
    short_circuit: true        # stop at first block; skip costlier providers

  conflict_default: most_severe
```

## Strategies

| Strategy | Effective decision |
|---|---|
| `deny-wins` | The most restrictive decision among providers (`block` > `require_approval` > `redact`/`modify` > `allow`). |
| `quorum` | A non-`allow` decision only if ≥ `count` providers agree (optionally above `min_score`); otherwise `allow`. |
| `weighted` | Sum provider weights for each decision; highest wins. Weights set per provider. |
| `first-available` | First provider to answer (others may be `fallback`). |

## Decision severity order

For `deny-wins` and `conflict_default: most_severe`, severity is:

```
block  >  require_approval  >  redact  >  modify  >  allow
```

## Failure & latency

- `timeout_ms` bounds each provider. A provider exceeding it is dropped per
  `on_timeout` (`degrade` = decide on the rest; `block` = fail closed).
- `on_all_failed` sets the decision when every provider errors or times out.
  Security categories SHOULD fail closed (`block`); low-severity safety MAY fail
  open (`allow`). This choice is the deployer's and MUST be explicit.
- `short_circuit: true` lets the runtime stop once a `block` is reached, so an
  expensive model provider is skipped when a cheap rule already blocked.

## Attribution

The effective verdict MUST record which providers contributed (`provider` on each
underlying verdict). This is what makes per-vendor metering, billing, and the
[benchmark leaderboard](https://github.com/openguardrails/openguardrails-bench)
possible — the same attribution data, viewed two ways.
