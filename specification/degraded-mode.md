# Degraded mode (runtime unreachable)

[Composition](composition.md) specifies what a runtime does when *detectors*
fail (`on_timeout`, `on_all_failed`) — the PDP side. This document specifies
the PEP side: what a conformant integration does when it cannot reach the
runtime at all. Keywords per RFC 2119.

## The default is OPEN

**An integration that configures nothing fails open**: a step whose evaluate
got no answer (timeout, 429, 5xx, network) proceeds, and the integration
logs/counts that it went unjudged. This is deliberate — the minimal
integration is an observability instrument first, and an instrument that can
halt the agent it observes would never be adopted. Guardrails must earn the
right to stop production traffic through explicit configuration, not acquire
it as a side effect of a network blip.

The trade is stated plainly: while the runtime is dark, a fail-open
integration is unprotected. A deployment that gates dangerous actions makes
the opposite trade by configuring `closed`.

## `fail_mode`

Configured per risk category (or category prefix):

```yaml
fail_mode:
  "security.cmd.*": closed    # gated actions are denied while the runtime is dark
  default:          open      # everything else proceeds, recorded as unjudged
```

| Value | Meaning while the runtime is unreachable |
|---|---|
| `open` | Permit the action; record locally that it went unjudged. **The default.** |
| `closed` | Deny the gated action until the runtime answers again. |

A category with no entry uses `default`; an absent `default` is `open`. The
same `fail_mode` governs the two partial failures short of a full outage: an
evaluate that times out, and a verdict whose
[`unjudged`](verdict.md#unjudged-what-this-verdict-could-not-judge) names the
very path being enforced — "could not look" is the same situation at three
sizes, and it would be incoherent to fail closed on one and open on another.

## Normative requirements

1. **The decision is local and pre-configured.** An integration MUST apply
   its configured `fail_mode` without any runtime round-trip. An integration
   MUST make its fail mode configurable so a deployment CAN choose `closed`;
   it MUST NOT hard-code open as the only behavior.
2. **Loud signaling.** Entering and leaving degraded mode SHOULD be visible
   in the integration's own logs and counters, and the
   [heartbeat](runtime-api.md#post-v1heartbeat)'s `evaluate_errors` counter
   is how the runtime learns an integration went dark. Events observed while
   degraded are lost observations (v0.8 has no replay channel); the
   heartbeat counters are what make the gap visible instead of silent.
3. **429 is an outage.** A rate-limited `/v1/evaluate` MUST be treated
   exactly like an unreachable runtime — back off and apply `fail_mode`.

`fail_mode` (this document, PEP ↔ runtime link) and the runtime's
`on_all_failed` ([composition](composition.md#failure--latency), runtime ↔
detectors) are complementary and independent: the first decides what the
enforcement point does with no runtime; the second decides what a reachable
runtime does with no working detector.
