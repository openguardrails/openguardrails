# Mandate (the authorization envelope)

This document uses the keywords MUST, MUST NOT, SHOULD, MAY as defined in
RFC 2119. **Status: OGR 1.3, additive-optional and CONFIGURATION-ONLY.** Nothing
here changes the wire: a [`GuardEvent`](guard-event.md) is unchanged, and a
[`Verdict`](verdict.md) carries mandate results as ordinary `findings`. A runtime
that implements none of this stays conformant.

## The gap this closes

Every control in this specification so far judges an action **on its own merits**:
is this command dangerous, did this instruction arrive through data, is this a
credential. There is a class of failure none of them can see, because the action
is not dangerous in itself and is not dangerous for every agent:

```
place_order({"symbol": "NVDA", "side": "buy", "quantity": 5000})
nmap -sV 10.20.0.0/16
```

Neither is malicious. Whether either is a violation depends on something no
detector can read out of the payload: **what this agent was authorized to do**.
An equities agent whose desk covers US large-cap and whose per-order cap is 500
shares has just breached both; the agent next to it has not. A security agent
whose engagement scope is `10.20.0.0/16` is doing its job; the one scoped to a
single host is now scanning a network nobody consented to.

This is the failure mode operators describe as **drift**: the agent keeps doing
its own job, competently, outside the envelope it was given. It is the dominant
risk in exactly the domains where agents are given real work — money and
infrastructure — and it is invisible to content judgment by construction.

A **mandate** is the operator's declaration of that envelope, held by the
runtime, evaluated against the tool calls the agent actually made.

## It is configuration, and it is never on the wire

⚠️ **A mandate MUST NOT be carried in a `GuardEvent`, and a runtime MUST NOT accept
one from a producer.** An envelope an agent asserts about itself is not an
envelope: the same process that would exceed it supplies it, and a compromised or
merely buggy agent widens its own authority by editing a string. This is the
[`integration` rule](guard-event.md#integration) applied to the one field where
getting it wrong is unrecoverable.

A mandate is therefore resolved the way policy already is — **by workspace**, from
the runtime's own configuration, inside the tenant the API key proves:

```
agent_workspace ──▶ policy set ──▶ mandate  (0 or 1)
```

A workspace with no mandate is the ordinary case and means **no envelope is
declared**, not an empty envelope: a runtime MUST NOT treat a missing mandate as
"nothing is permitted". Refusing every action of every unconfigured agent is how a
protocol gets turned off.

## Shape

The normative schema is [`schema/mandate.schema.json`](../schema/mandate.schema.json).
A mandate has five parts, each optional; an absent part constrains nothing.

```yaml
mandate: desk-a-equities            # a name, for findings and audit
workspace: quant-agents             # the policy set this belongs to
on_violation: block                 # block | flag  — see below

bindings:                           # HOW to read the agent's own tool calls
  - tool: place_order
    capability: order.place
    fields: {instrument: symbol, quantity: quantity, side: side, venue: venue}
  - tool: cancel_order
    capability: order.cancel

scope:                              # WHAT it may act on
  allow: ["equity:us:*"]
  deny:  ["equity:us:GME", "crypto:*"]

capabilities:                       # WHAT it may do
  allow: [order.place, order.cancel, data.read]
  deny:  [order.short, funds.withdraw]

limits:                             # HOW MUCH
  - {id: per-order-qty, metric: quantity, window: per_call,   max: 500}
  - {id: daily-orders,  metric: count,    window: per_day,    max: 200}
  - {id: order-rate,    metric: count,    window: per_minute, max: 10}

windows:                            # WHEN
  - {id: rth, timezone: America/New_York, days: [mon,tue,wed,thu,fri],
     from: "09:30", to: "16:00"}      #   a clock range, OR ...
  - {id: session, sessions: [regular]} #   ... a set of allowed session labels

irreversible:                       # WHAT ONLY A HUMAN MAY DECIDE
  - {id: unwind, capability: order.place, when: {side: sell_all}}
```

The same five parts describe an engagement scope with no change of mechanism —
`bindings` on `run_shell`/`http_request`, `scope` on hosts and domains,
`capabilities` on technique classes, `windows` on the agreed testing hours. Two
worked mandates ship at [`examples/mandate-agent/`](../examples/mandate-agent/).

### `bindings`: the part that makes the rest honest

A runtime holds a raw provider body. It sees `place_order` with an arguments
object; it does not know which key is the instrument, and it MUST NOT guess.
`bindings` is the operator stating the correspondence between the agent's own tool
schema and the mandate's dimensions.

⚠️ **A tool with no binding is UNBOUND, and unbound is not permitted-by-default.**
A runtime MUST evaluate an unbound tool call against `capabilities` only (an
unlisted capability is denied when an `allow` list is present), and MUST report
the call's path in the verdict's [`unjudged`](verdict.md#unjudged-what-this-verdict-could-not-judge)
list for every mandate dimension it could not read. A mandate that silently
ignores the one tool the operator forgot to bind is worse than no mandate: it
reports coverage it does not have.

⚠️ **A field a binding names but the call does not carry is also unjudged**, never
zero and never compliant. "The order had no `quantity` key" and "the order was for
zero shares" are different facts, and only one of them is safe to pass.

### Windows: a clock range OR a session label

A window is either a clock range (`timezone` + `from` + `to`, checked against the
runtime's clock) or a set of allowed **session labels** the call itself carries
(`sessions`), matched against the value a binding maps to the `session` dimension.

⚠️ **The session form is often the more honest one.** The wire carries no
trustworthy event timestamp — the spec already forbids ordering events by producer
time ([guard-event](guard-event.md#usage-and-timing)) — and "which trading session"
or "which maintenance window" is a label the venue or scheduler attaches to the
action, not something to reconstruct from wall-clock. Where the action names its
own session, reading that label is both simpler and less fragile than a timezone
comparison. A runtime MAY support either form; a window declaring neither is
invalid.

## Evaluation, and the three time scales

| Check | Reads | Needs |
|---|---|---|
| **scope**, **capabilities**, **windows**, **irreversible** | the one call in front of it | the event only |
| **limits** with `window: per_call` | the one call | the event only |
| **limits** with `per_turn` / `per_session` / `per_minute` / `per_hour` / `per_day` | every call the runtime has already seen for this agent | the runtime's derived ledger (L5 turn, L6 session) |

Cumulative limits are the reason this belongs in the runtime rather than in a
plugin. The enforcement point holds one step; **the runtime holds the sequence**,
because it derives sessions and turns server-side already
([overview](overview.md#the-layer-model)). A limit counted per agent, per window,
across every integration reporting for that agent is a number no single PEP can
compute.

Counting rules a runtime MUST follow:

1. **Count CALLS observed, not effects.** The unit is the tool call in a
   `step/response`, counted once when it is judged. A retried step that produces
   the same call twice is two observations of intent and MUST be counted twice —
   the runtime cannot know whether the first one executed.
2. **A blocked call still counts as an observation, and MUST NOT count against a
   volume limit** whose subject is what the agent did. A runtime SHOULD keep both
   figures; only one of them belongs in the limit.
3. **The count is a FLOOR.** It covers the traffic that was reported. An agent
   with a second, unguarded path to the same broker or the same network is
   underreported by exactly that path, and no runtime-side arithmetic can detect
   it.

## What a violation produces

A mandate check produces ordinary [`findings`](verdict.md#findings):

```json
{ "category": "security.mandate_violation.limit", "severity": "high",
  "path": "payload.choices.0.message.tool_calls.0.function.arguments",
  "score": 1.0, "detector": "mandate:desk-a-equities",
  "subject": "quantity=5000 > per-order-qty (500)" }
```

- `category` is one of the [`security.mandate_violation.*`](taxonomy.md#securitymandate_violation--envelope-dimension-subcategories)
  ids — the dimension crossed, not the vertical.
- `detector` SHOULD name the mandate, so a finding is traceable to the document
  that produced it.
- `path` names the offending tool call, which is what lets an enforcement point
  refuse **that call and execute the rest** ([verdict](verdict.md#findings)).
- `score` is not a probability here. A mandate check is a deterministic
  comparison against a declared bound; a runtime SHOULD emit `1.0` and MUST NOT
  present the result as a model's confidence.

`on_violation` is `block` (the finding contributes a block to
[composition](composition.md), like any other blocking detector) or `flag` (an
`allow` carrying the finding). It is per-mandate and MAY be overridden per rule.

⚠️ **There is no "ask a human" outcome, deliberately.** `require_approval` was
removed from the wire in v0.8 and its composition semantics are still unresolved
([verdict](verdict.md#decisions-two)) — so `irreversible` rules express "a human
must decide this" the only honest way available: they **block**, and a person
re-runs the action through whatever approval path the operator already has. A
mandate MUST NOT be read as implementing an approval workflow.

## What a mandate cannot do

This section is normative for how an implementation may DESCRIBE itself. Each
limit below is a place where claiming more than the position affords would make an
operator stop building the control that actually works.

1. **It judges CALLS, not EXECS.** OGR observes the model plane: it refuses the
   tool call (L2) before the harness runs it. It has no view of L1 — what actually
   happened on the machine — and it cannot recall an order, a packet or a delete
   that a process holding the credential has already sent. **A mandate is not a
   pre-trade risk control and not a firewall.** Where a regime requires controls at
   the point of access (SEC Rule 15c3-5, MiFID II RTS 6) those controls belong at
   the broker or OMS, and a mandate complements them by seeing the reasoning and
   the instruction flow those systems cannot.
2. **It is only as complete as the traffic reported to it.** An agent with an
   unguarded second path is outside every count and every scope check.
   [Heartbeat](runtime-api.md#post-v1heartbeat) coverage and the shadow-agent
   signal are how that gap becomes visible; the mandate itself cannot detect it.
3. **It cannot evaluate what it cannot read.** Anything requiring state outside
   the payload — a live price, a current position, an account balance, whether a
   host is really in the customer's netblock — is not computable in the model
   plane. A mandate SHOULD be written on the dimensions the call itself carries
   (instrument, quantity, count, rate, side, target, technique, time), and a
   runtime MUST report anything else as `unjudged` rather than approximating it.
4. **It does not establish authorization.** A mandate records what an operator
   said the agent may do. Whether the operator had the right to authorize it —
   a signed engagement, a client agreement, a regulatory permission — is outside
   this contract and outside any detector's reach.
5. **It is not a sandbox.** Blocking a call does not contain a process. An agent
   that can reach the network or the broker directly is bounded by that reach, not
   by this document.

## Conformance (conditional)

A runtime that advertises mandate support MUST: resolve mandates by workspace and
never from an event; evaluate unbound tools against `capabilities` only and report
the unread dimensions in `unjudged`; emit `security.mandate_violation.*` findings
with the mandate named in `detector`; and count cumulative limits from observed
traffic without presenting the count as complete. A runtime that implements no
mandate support is unaffected — this is not a conformance requirement of the
[Runtime API](runtime-api.md).

Enforcement points need no changes at all: a mandate finding arrives as a finding,
and a mandate block arrives as a `block`. A PEP that already honors verdicts
already honors mandates.
