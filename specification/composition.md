# Composition

When multiple detectors judge one event, the runtime must combine their
answers into the one **effective verdict** the integration point enforces.
Composition is the deployer's real policy — not "write rules," but
"orchestrate detectors." OGR standardizes the *mechanism*; the choices stay
the deployer's. Keywords per RFC 2119.

## Policy shape

Composition is configured per risk category (or category prefix). A runtime
MUST support at least the `deny-wins`, `quorum`, and `first-available`
strategies.

```yaml
composition:
  # security defaults conservative: any detector blocking blocks the action
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

With [two decisions](verdict.md#decisions-two) the strategies compose
decisions, redaction spans, and findings separately:

| Strategy | Effective decision |
|---|---|
| `deny-wins` | `block` if any contributing detector blocks, else `allow`. |
| `quorum` | `block` only if ≥ `count` detectors agree (optionally above `min_score`); otherwise `allow`. |
| `weighted` | Sum provider weights for each decision; highest wins. Weights set per provider. |
| `first-available` | First provider to answer (others may be `fallback`). |

## Composing findings and modifications

- **Findings union.** The effective verdict's `findings` are the union of
  every contributing detector's findings, each keeping its own `detector`
  attribution. Whitelisted findings are carried (marked), never dropped.
- **Spans union.** The effective `modifications.spans` are the union of
  spans from all contributing verdicts. Overlapping spans on the same `path`
  merge to the covering range.
- **Unjudged union.** The effective `unjudged` is the union of every
  detector's unjudged paths — a path is covered only when every guardrail
  routed to it answered.

## Failure & latency

- `timeout_ms` bounds each provider. A provider exceeding it is dropped per
  `on_timeout` (`degrade` = decide on the rest AND report the dropped
  provider's paths in `unjudged`; `block` = fail closed).
- `on_all_failed` sets the decision when every provider errors or times out.
  Security categories SHOULD fail closed (`block`); low-severity safety MAY
  fail open (`allow` with the affected paths in `unjudged`). This choice is
  the deployer's and MUST be explicit.
- `short_circuit: true` lets the runtime stop once a `block` is reached, so
  an expensive model provider is skipped when a cheap rule already blocked.

## Attribution

The effective verdict MUST record which providers contributed (`provider` on
each underlying answer, `detector` on each finding). This is what makes
per-vendor metering, billing, and the
[benchmark leaderboard](https://github.com/openguardrails/openguardrails/tree/main/benchmarks)
possible — the same attribution data, viewed two ways.
