# examples — a mandate (the authorization envelope)

The runnable form of [`specification/mandate.md`](../../specification/mandate.md):
how a runtime judges an agent's tool calls against the envelope its operator
declared. This is the control for the failure mode that content judgment cannot
see — **drift**, where the agent keeps doing its own job outside the bounds it was
given. It is the dominant risk in the two domains where agents are handed real
work: **money** (a quant/trading agent) and **infrastructure** (a
security-operations agent).

The headline point the two mandates here make together: **the same tool call is
compliant for one agent and a violation for the next.** `place_order(NVDA, 5000)`
and `nmap 203.0.113.5` are not dangerous in themselves — they are dangerous
*relative to an envelope*, and the envelope is the thing OGR adds.

```
mandate-agent/
  equities-mandate.json   a trading desk's envelope (schema/mandate.schema.json)
  pentest-mandate.json    a web-app engagement's rules of engagement — same schema
  sample_calls.json       place_order/get_quote calls that exercise each dimension
  pentest_calls.json      scan/probe/report calls for the engagement mandate
  evaluate_mandate.py     a ~200-line reference evaluator: (mandate, calls) -> findings
  demo.sh                 runs both, offline, zero dependencies
```

## Quickstart (offline, no dependencies)

```bash
cd examples/mandate-agent && ./demo.sh
```

Each row prints the effective decision, the tool call, and the
[`security.mandate_violation.*`](../../specification/taxonomy.md#securitymandate_violation--envelope-dimension-subcategories)
category each violation maps to. The two mandates exercise the same five
dimensions:

| Dimension | Trading | Security operations |
|---|---|---|
| **scope** — what it may act on | `equity:us:*`, minus `GME` and crypto | `10.20.0.0/16` + `app.acme.example`, minus `.1` |
| **capability** — what it may do | no `order.short`, no `funds.withdraw` | no `denial_of_service`, `phishing` |
| **limit** — how much | ≤500 shares/order, ≤200 orders/day, ≤10/min | ≤30 scans/min |
| **window** — when | regular US trading hours | the agreed 02:00–06:00 maintenance window |
| **irreversible** — reserved to a human | liquidating the book (`sell_all`) | destructive techniques (`drop`/`encrypt`/`wipe`) |

## The three things the evaluator is careful about

These are the parts of [`mandate.md`](../../specification/mandate.md) that are
easy to get wrong, made concrete:

1. **A capability can depend on an argument, not just the tool.** A short sale is
   `place_order` with `side=sell_short`; a DoS is `run_shell` with
   `technique=denial_of_service`. `bindings[].capability_map` expresses that, so
   `capabilities.deny` bites without inventing a separate tool.
2. **An unbound tool is not permitted by default.** `withdraw` is in neither the
   bindings nor the capability allow-list, so under a closed allow-list it is
   **blocked** — and every dimension the evaluator could not read is reported in
   `unjudged`, never silently passed.
3. **A read is not a bounded value.** A field a binding names but a call omits is
   `unjudged`, never zero — "the order had no quantity" and "the order was for
   zero shares" are different facts, and only one is safe to pass.

## What this is not

A teaching implementation, not a conformance target, and — the point
[`mandate.md`](../../specification/mandate.md#what-a-mandate-cannot-do) insists on
— **not a pre-trade risk control and not a firewall.** It judges the tool CALL
(L2) before the harness runs it; it cannot recall an order or a packet a process
holding the credential already sent (L1). It reads only what the call carries: it
does not resolve a live price, a position, or whether a host is truly in the
customer's netblock, and it reports anything it cannot read as `unjudged` rather
than guessing. Market-access limits (SEC Rule 15c3-5, MiFID II RTS 6) belong at
the broker/OMS; a mandate complements them by seeing the reasoning and the
instruction flow those systems never do.
