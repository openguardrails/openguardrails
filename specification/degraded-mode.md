# Adapter degraded mode (runtime unreachable)

[Composition](composition.md) specifies what a runtime does when *detectors*
fail (`on_timeout`, `on_all_failed`) — the PDP side. This document specifies the
PEP side: what a conformant adapter (agent hook / gateway / sandbox) does when it
cannot reach the runtime at all. Keywords per RFC 2119.

A runtime outage — or an attacker-induced network partition between agent and
runtime — must not force a binary choice between blocking every unattended agent
(operational pressure that pushes operators toward fail-open) and silently
allowing gated actions (the worst outcome). OGR defines a third behavior between
`block` and `allow`: **degrade to local approval**.

## `on_unreachable`

Configured per risk category (or category prefix), mirroring composition's
failure vocabulary:

```yaml
on_unreachable:
  "security.*":                 require_local_approval   # gate every security action locally
  "safety.*":                   allow                    # low-severity safety fails open
  "security.malicious_command": block                    # never runnable without the runtime
  queue_timeout_action:         block                    # unattended: action after the queue times out
```

| Value | Meaning while the runtime is unreachable |
|---|---|
| `block` | Deny the gated action. |
| `allow` | Permit the gated action (fail open). |
| `require_local_approval` | Suspend the action; the human principal approves through a channel that does not depend on runtime availability. |

A category with no entry defaults to `block` for `security.*`; the `safety.*`
default is the deployer's explicit choice. A blanket hard-`block` default is
discouraged precisely because it pushes operators toward configuring fail-open —
the deployer MUST be able to set `require_local_approval` for any prefix.

## Normative requirements

1. **Runtime-independent approval.** `require_local_approval` MUST use an
   approval channel that does not depend on runtime availability — an in-terminal
   prompt, an in-session ask, or a local approval device. An approval that would
   itself require calling the runtime does not satisfy this.
2. **Local hard rules stay enforced.** Rules cached locally in the PEP —
   allow/deny lists, hard limits, and the policy-embedded redaction tier
   ([local redaction](local-redaction.md#redactor-tiers)) — pushed down at
   [enrollment](enrollment-and-receipts.md#enrollment), MUST remain enforced in
   degraded mode. Otherwise an attacker who can cut the runtime link downgrades
   the whole defense to approval fatigue.
3. **Loud signaling and reconciliation.** Entering and leaving degraded mode
   MUST emit events, and events buffered while degraded MUST be delivered to the
   runtime on reconnect — batch-signed per
   [event authenticity](enrollment-and-receipts.md#event-authenticity) so
   delayed delivery is tamper-evident. Reconnect delivery, together with the
   [liveness](enrollment-and-receipts.md#liveness-heartbeat) heartbeat, is what
   gives the runtime the "this PEP went dark" signal.
4. **Unattended agents.** A gated action in degraded mode is suspended. Adapters
   SHOULD support a queue-with-timeout; the timeout action is itself configurable
   (`queue_timeout_action`) and defaults to `block`.

## Relationship to pre-authorization

A `pre_authorization` receipt
([enrollment](enrollment-and-receipts.md#scopes)) minted while the runtime was
reachable MAY satisfy a gated action in degraded mode without a fresh local
approval, provided the PEP can evaluate its `constraints` offline (`max_uses` is
best-effort locally, reconciled on reconnect). This is the intended way to keep a
known-safe unattended workload running through a short outage without either
fail-open or approval fatigue.

`on_unreachable` (this document, PEP ↔ runtime link) and the runtime's
`on_all_failed` ([composition](composition.md#failure--latency), runtime ↔
detectors) are complementary and independent: the first decides what the
enforcement point does with no runtime; the second decides what a reachable
runtime does with no working detector.
