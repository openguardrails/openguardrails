# Degraded mode (runtime unreachable)

[Composition](composition.md) specifies what a runtime does when *detectors*
fail (`on_timeout`, `on_all_failed`) — the PDP side. This document specifies
the PEP side: what a conformant integration (agent-direct or gateway) does
when it cannot reach the runtime at all. Keywords per RFC 2119.

A runtime outage — or an attacker-induced network partition between agent
and runtime — must not silently become "every gated action allowed". The
integration's behavior while dark is ITS OWN configuration, set before the
outage, because the runtime is by definition not there to be asked.

## `fail_mode`

Configured per risk category (or category prefix):

```yaml
fail_mode:
  "security.*": closed        # gated actions are denied while the runtime is dark
  "safety.*":   open          # low-severity safety fails open
  default:      closed
```

| Value | Meaning while the runtime is unreachable |
|---|---|
| `closed` | Deny the gated action. |
| `open` | Permit the gated action (and record locally that it went unjudged). |

A category with no entry uses `default`; an absent `default` MUST be read as
`closed` for `security.*`. The same `fail_mode` governs the two partial
failures short of a full outage: an evaluate that times out, and a verdict
whose [`unjudged`](verdict.md#unjudged-what-this-verdict-could-not-judge)
names the very path being enforced — "could not look" is the same situation
at three sizes, and it would be incoherent to fail closed on one and open on
another.

## Normative requirements

1. **The decision is local and pre-configured.** An integration MUST apply
   its configured `fail_mode` without any runtime round-trip, and MUST NOT
   default to `open` for `security.*` categories absent explicit
   configuration.
2. **Loud signaling and reconciliation.** Entering and leaving degraded mode
   SHOULD be visible in the integration's own logs/counters, and events
   observed while degraded SHOULD be buffered and delivered through
   `/v1/ingest` on reconnect — delayed truth beats no truth. Together with
   the [heartbeat](runtime-api.md#post-v1heartbeat), reconnect delivery is
   what gives the runtime the "this integration went dark" signal.
3. **429 is an outage.** A rate-limited `/v1/evaluate` MUST be treated
   exactly like an unreachable runtime — back off and apply `fail_mode`,
   never fail open because "the runtime is technically up".

`fail_mode` (this document, PEP ↔ runtime link) and the runtime's
`on_all_failed` ([composition](composition.md#failure--latency), runtime ↔
detectors) are complementary and independent: the first decides what the
enforcement point does with no runtime; the second decides what a reachable
runtime does with no working detector.
