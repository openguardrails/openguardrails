# Enrollment & approval receipts

How a PEP proves who it is, and how an approval becomes something a PEP can
verify rather than believe. Keywords per RFC 2119.

## Why one mechanism

Two `v0.1` gaps share a root cause:

1. **Unauthenticated events** — `subject.agent_id` is a claim, not an identity.
   Events can be spoofed by any local process and selectively suppressed by a
   compromised agent.
2. **Unverifiable approvals** — guard-context flags bit 1 ("approval already
   granted") was propagated by the agent: the party OGR defends against could
   assert its own approval.

Both reduce to the same missing primitive: a key relationship between PEP and
runtime. Establish it once, at enrollment, and both events and approvals become
verifiable.

## Roles and keys

| Party | Holds after enrollment | Used for |
|---|---|---|
| Runtime (PDP) | its signing keypair(s); registry of enrolled PEPs | signing receipts; authenticating PEP channels |
| PEP (adapter) | a short-lived PEP credential; the runtime's verification keys, each with a stable `kid` | authenticating its event channel; verifying receipts, including offline |

## Enrollment

How trust is bootstrapped (enrollment tokens, device posture, attestation) is a
deployment concern and out of scope. The **outcome** is normative. After
enrollment a PEP MUST hold:

1. a credential binding it to an identity the runtime recognizes on every
   connection — an mTLS client certificate or equivalent channel credential.
   Credentials SHOULD be short-lived and renewed automatically;
2. the runtime's current verification keys.

Rotation: a runtime MUST publish a new verification key before retiring the old
one, and MUST keep a retired key available until every receipt signed with it
has expired. PEPs SHOULD refresh verification keys on every reconnect.

## Event authenticity

1. A PEP MUST send events over a channel authenticated with its enrollment
   credential. mTLS is RECOMMENDED; the contract stays transport-neutral.
2. A runtime MUST bind the channel identity to the `subject` values that PEP is
   allowed to assert, and MUST reject events where the two disagree.
3. A runtime MAY accept events from unenrolled PEPs for observability, but MUST
   treat them as unverified and MUST NOT mint receipts for them or derive
   enforcement authority from them.
4. Store-and-forward: events buffered while the runtime is unreachable SHOULD
   be signed per batch (JWS, PEP credential) so delayed delivery is
   tamper-evident (see [degraded mode](degraded-mode.md)).

## Liveness (heartbeat)

Uninstalling or silencing a PEP is the cheapest bypass of an altitude, and a
runtime cannot otherwise distinguish "agent idle" from "PEP went dark". An
enrolled PEP SHOULD emit a periodic **heartbeat** over its authenticated
channel, with the cadence declared at enrollment:

```
heartbeat: { interval_s: 30, counters: { events_emitted: 1420, degraded: false } }
```

- A runtime SHOULD alert when a PEP misses heartbeats beyond a tolerance and
  MUST treat the gap as a **coverage loss**, not as "no risk". Fleet coverage
  metrics depend on this signal.
- Heartbeat is a **transport/enrollment-level** signal, not a `GuardEvent`
  `kind`: it authenticates like any event on the PEP's channel but carries no
  guarded action.
- `counters` let the runtime reconcile against delivered events and catch
  selective suppression (a PEP reporting N emitted while N−k arrived). Combined
  with reconnect replay of [degraded-mode](degraded-mode.md) buffers, this is
  what makes the "selective event suppression" row of the threat model
  detectable.

## Approval receipts

When the effective verdict is `require_approval`, the action suspends until the
approval flow completes. The result is not a flag — it is a **receipt**: a
runtime-signed statement of *what* was approved, *by whom*, *until when*.

### Claims

| Claim | Req | Description |
|---|---|---|
| `ogr_version` | MUST | `"0.4"`. |
| `receipt_id` | MUST | Unique id for this receipt. |
| `issuer` | MUST | Runtime identity; pairs with the JWS `kid`. |
| `scope` | MUST | `single_action` \| `pre_authorization`. |
| `guard_id` | MUST for `single_action` | The logical action approved. |
| `session_id` | SHOULD | Session binding. |
| `bindings` | MUST for `single_action` | Array of `{ kind, payload_digest }` — one entry per altitude-projection of the approved action the runtime can derive. |
| `constraints` | MUST for `pre_authorization` | See below. |
| `approver` | MUST | Principal who approved, e.g. `user:tom`. |
| `approved_at` | MUST | RFC 3339. |
| `expires_at` | MUST | RFC 3339. `single_action` expiry SHOULD be minutes. |

The normative JSON Schema is
[`schema/approval-receipt.schema.json`](../schema/approval-receipt.schema.json).

### Envelope

A receipt is the claims object signed as a JWS (compact serialization) with
header `{"alg": "...", "kid": "...", "typ": "ogr-receipt+jws"}`. `EdDSA`
(Ed25519) is the MUST-implement baseline; other algorithms MAY be offered. The
receipt travels in the `ogr-receipt` companion header next to
`ogr-guardcontext` (see
[guard-context propagation](provenance-and-context.md#guard-context-propagation)),
or by reference where a header is impractical.

### Scopes

**`single_action`** — approves one logical action, identified by `guard_id`
and bound to the exact payload via `bindings`. This is what satisfying a
`require_approval` decision produces.

**`pre_authorization`** — a time-boxed, constrained grant minted in advance
("up to 10 tool calls matching X in the next hour"): the JIT pattern.
`constraints` fields:

| Field | Description |
|---|---|
| `session_id` / `principal` | Binds the grant to a session or principal. |
| `kinds` | Event kinds the grant covers. |
| `max_uses` | Use budget. Accounted by the runtime when online; best-effort locally in degraded mode, reconciled on reconnect. |
| `match` | Opaque, deployment-defined matcher evaluated by the PEP (e.g. compiled policy). A PEP that cannot interpret `match` MUST NOT honor the grant offline. |

### Cross-altitude bindings

The same logical action surfaces with different payloads at different altitudes
— a `tool_call` at the agent hook becomes an `exec` in the sandbox. A
`single_action` receipt therefore carries one binding **per projection the
runtime can derive** at minting time. Verification requires a binding that
matches the verifying PEP's own event. When none matches — the runtime could
not project the payload for that altitude — the receipt does not apply, and the
PEP MUST fall back to asking the runtime (which holds approval state for the
`guard_id`) or, if unreachable, to its configured
[unreachable-mode policy](degraded-mode.md).

### Receipt verification

A PEP MUST verify **all** of the following before treating an action as
approved:

1. the JWS signature is valid against an enrolled runtime verification key
   (`kid`);
2. `expires_at` has not passed;
3. scope match —
   - `single_action`: the event's `guard_id` equals the receipt's, **and** a
     `bindings` entry matches the event's `kind` with a `payload_digest` equal
     to the digest the PEP **recomputes** from the event it is about to
     enforce;
   - `pre_authorization`: every present constraint is satisfied.

On any failure the PEP MUST treat the action as unapproved.

Recomputing the digest is the point: approve-X-then-execute-X′ fails closed.
Replaying a receipt against the same action is harmless — the digest matches
because the action is identical; against any other action the digest cannot
match.

## Payload canonicalization

`payload_digest` = `"sha256:" + lowercase-hex(SHA-256(JCS(digest input)))`,
where JCS is RFC 8785 and the digest input is the kind-specific subset of
`payload`:

| `kind` | Digest input |
|---|---|
| `tool_call` | `{ name, arguments }` |
| `exec` | `{ argv, cwd }` |
| `network` | `{ host, port, direction }` |
| `file` | `{ op, path }` |
| `tool_register` | `{ name, description, schema }` |
| `mcp_connect` | `{ server, url }` |
| `skill_load` | `{ name, source, content_ref }` |

Subsets exclude fields that legitimately differ between observation and
execution (e.g. `env_keys`) so digests are stable across altitudes for the same
action. Kinds not listed are not approvable in `v0.2`.

## What the approver sees

The approval UI SHOULD render from the canonical digest input — decoded and
human-readable — never from an agent-supplied description of the action. An
agent that can write its own approval prompt can lie in it; the digest input is
what will actually execute, and it is what the receipt binds.

## Threat model

| Attack | `v0.1` | `v0.2` |
|---|---|---|
| Agent sets the "approval granted" bit itself | Succeeds | Fails — no verifiable receipt |
| Approve X, execute X′ (TOCTOU) | Undetected | Digest recompute fails closed |
| Receipt replayed against a different action | — | Digest cannot match |
| Spoofed GuardEvents from a local process | Accepted | Rejected, or marked unverified |
| Tampering with buffered degraded-mode events | Undetected | Batch signature fails |
| Selective event suppression | Undetected | Detectable via [liveness](#liveness-heartbeat) signals + reconciliation on reconnect |

## Out of scope

- **Approver authentication** (passkeys, biometrics, hardware-backed approval
  devices) and where approvals are displayed — deployment concerns. The receipt
  records *that* and *what* the runtime's approval flow approved; it is
  agnostic to *how* the approver was authenticated.
- **Key custody** (HSM, secure enclave) for runtime signing keys — recommended,
  not mandated by the wire.
- Enrollment bootstrap trust and the transport wire format.
