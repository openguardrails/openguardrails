# Identity attestation

How strongly an identity claim is verified. One ladder serves both faces of
the same trust root: **who asserted `subject.agent_id` / `subject.principal`**
(the identity face, carried per event) and **how a channel proved itself**
(the service-auth face, established at [enrollment](enrollment-and-receipts.md)).
An identity without presentation is a label; presentation without identity is
an anonymous bearer token — the ladder names where a deployment sits between
those failure modes.

## Levels

Weakest → strongest. `inferred` deliberately ranks above `self_declared`: a
runtime's own derivation (e.g. from the agent's system-prompt self-definition)
is more trustworthy than an unverified claim.

| Level | Meaning |
|---|---|
| `self_declared` | Bare claim by the sender; nothing verified it. |
| `inferred` | Derived by the runtime from observed content (signature library). |
| `network` | Backed only by network signals (source IP, machine account). |
| `mtls` | Client authenticated to the observer via mutual TLS. |
| `gateway_api_key` | Asserted by a gateway that authenticated the client with a per-client credential it issued (virtual-key pattern). |
| `client_key` | Backed by a credential the client itself holds and presented end-to-end. |

## `subject.attestation`

A PEP MAY declare how it verified the `subject` identity fields by setting
`subject.attestation` to a level above ([GuardEvent](guard-event.md#subject)).

A claim is only as strong as the channel that carried it. A runtime MUST clamp
`subject.attestation` to the **channel ceiling** — the strongest level the
event channel itself can prove:

- events from an unenrolled PEP (e.g. authenticated only by a shared
  workspace API key) have a ceiling of `self_declared`;
- events from an enrolled PEP have the ceiling recorded in that PEP's
  enrollment (its channel credential strength and granted assertion scope).

A runtime SHOULD persist the clamped level per identity (and MAY per event)
and SHOULD surface it wherever agents are listed, so operators see posture,
not just names. Policy decisions MAY condition on the level (e.g. "deny
resource X below `gateway_api_key`").

## Assertion scopes

Enrollment records what a PEP is allowed to assert
([enrollment](enrollment-and-receipts.md#enrollment)): the workspaces it may
write into, the `principal` namespaces it may name (exact values or prefix
patterns such as `acme/*`), and the maximum attestation level it may declare.
A compromised PEP can then impersonate only within its registered scope.

For an assertion outside the PEP's scope, or one the runtime cannot verify,
the runtime MUST NOT accept the assertion at its claimed strength: it MUST
either reject the event or downgrade the assertion to `self_declared` (and
MAY fall back to its own inference).

## Gateway multiplexing

One gateway PEP fronting many agents/users can prove only "this event came
from gateway G"; who sits behind it is bounded by what the gateway itself can
authenticate. The contract does not create signals — it standardizes the slot
(`subject.principal` / `subject.agent_id`), labels the strength honestly, and
lets policy act on it:

| Gateway capability | Level to declare |
|---|---|
| Issues per-user/app credentials and authenticates them (virtual keys) | `gateway_api_key` |
| Authenticates clients via mutual TLS | `mtls` |
| Distinguishes clients only by network signals | `network` |
| Transparent proxy, no client signal | omit (runtime infers → `inferred`) |

Upgrade path: a client that carries its own credential (e.g. a lightweight
hook adding an `X-OGR-Client-Assertion` header the gateway forwards untouched)
raises its events to `client_key` without changing the gateway's own posture.
