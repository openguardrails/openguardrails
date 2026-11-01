# Proposal: a quant/trading-agent profile of the authorization envelope

> **Status: DRAFT — non-normative.** This is a discussion document, not part of
> the standard. It carries no RFC-2119 weight. Its purpose is to give a
> collaborator a concrete framework and a candidate set of dimensions to react to.
> If accepted, its neutral parts fold into
> [`specification/mandate.md`](../specification/mandate.md) and
> [`specification/taxonomy.md`](../specification/taxonomy.md) and this file is
> retired.
>
> **Owner:** _(you)_ · **Discussion:** _(link the GitHub Discussion / Draft PR here)_

## 1. What already exists, so we don't re-litigate it

OGR already models the core of this. Please read these first; this proposal only
adds the trading-specific *profile* and the open questions.

- **The framework** — [`specification/mandate.md`](../specification/mandate.md):
  a **mandate** is the operator's declared *authorization envelope*, held by the
  runtime and resolved by workspace, **never on the wire**. It judges tool CALLS
  (L2), not executions (L1); it is explicitly **not** a pre-trade risk control or a
  firewall. Five dimensions: `scope`, `capability`, `limit`, `window`,
  `irreversible`.
- **The schema** — [`schema/mandate.schema.json`](../schema/mandate.schema.json).
- **The neutral taxonomy ids** — `security.mandate_violation.*`,
  `security.market_manipulation.*`, `security.restricted_information.*`,
  `security.persistence` in [`taxonomy.md`](../specification/taxonomy.md), plus the
  informative **agentic-trading mapping** table.
- **A runnable reference** — [`examples/mandate-agent/`](../examples/mandate-agent/)
  (`equities-mandate.json` + a ~200-line evaluator) and the scored corpus
  [`benchmarks/suites/security/mandate_violation_trading.jsonl`](../benchmarks/suites/security/mandate_violation_trading.jsonl).

The one design commitment worth restating, because every dimension below inherits
it: **a mandate is not a risk engine.** It reads what a tool call carries. Anything
needing live state the model plane cannot see — a current position, a mark price, a
realised P&L, an account balance — is out of scope for the mandate and belongs at
the broker/OMS (where SEC Rule 15c3-5 and MiFID II RTS 6 already put it). The
mandate's job is the layer those systems can't see: the reasoning and the
instruction flow that produced the order.

## 2. Candidate standard dimensions for a trading agent

Each row is a proposed *standard* field of a trading mandate, the OGR category a
violation maps to, and — critically — whether it is **readable from the call**
(mandate can own it) or **needs external state** (belongs to the OMS, mandate can
at most flag intent).

| # | Dimension | Example bound field(s) | Maps to | Call-readable? |
|---|---|---|---|---|
| D1 | **Instrument scope** — asset class, symbol, restricted list | `asset_class`, `symbol` | `mandate_violation.scope` | ✅ |
| D2 | **Venue / account scope** | `venue`, `account` | `mandate_violation.scope` | ✅ |
| D3 | **Side & order-type capability** — long/short, margin, derivatives | `side`, `order_type` | `mandate_violation.capability` | ✅ |
| D4 | **Fund-movement capability** — withdraw, transfer | tool identity | `mandate_violation.capability` | ✅ |
| D5 | **Per-order size** — quantity / notional on the ticket | `quantity`, `notional` | `mandate_violation.limit` | ✅ (notional only if the ticket carries it) |
| D6 | **Order rate / concurrency** | count of calls | `mandate_violation.limit` → `resource_exhaustion` | ✅ (from the runtime's own ledger) |
| D7 | **Session / window** | `session` label or clock | `mandate_violation.window` | ✅ |
| D8 | **Irreversible actions** — liquidation, unwind, transfer | `side: sell_all`, tool identity | `mandate_violation.irreversible` | ✅ |
| D9 | **Cumulative exposure** — position, net notional, leverage, daily loss | — | `mandate_violation.limit` | ⚠️ needs external state — **OMS-owned** |
| D10 | **Market-data integrity** — a price/fundamental the model invented | `rationale`, quoted figures | `safety.hallucination` | partial — a separate detector |
| D11 | **Restricted information** — MNPI, client order flow | `rationale`, provenance taint | `restricted_information.mnpi` / `.client_order_flow` | partial — needs provenance labelling |
| D12 | **Manipulative patterns** — spoofing, wash, layering, marking | sequence of calls | `market_manipulation.*` | ❌ per-call — a **sequence** detector over L6 |

**The line that matters for the discussion is the last column.** D1–D8 are the
mandate's to own cleanly today. D9–D12 are the interesting boundary: they are why a
trading guardrail is more than a mandate, and deciding where each one lives is the
substance of a collaboration.

## 3. A straw-man trading mandate (for reaction, not adoption)

Building on `examples/mandate-agent/equities-mandate.json`, extended with the
dimensions above that are call-readable:

```jsonc
{
  "mandate": "desk-a-equities",
  "workspace": "quant-agents",
  "on_violation": "block",
  "bindings": [
    { "tool": "place_order", "capability": "order.place",
      "fields": { "asset_class": "asset_class", "instrument": "symbol",
                  "quantity": "quantity", "notional": "notional",
                  "side": "side", "venue": "venue", "account": "account",
                  "session": "session" },
      "capability_map": { "side": { "sell_short": "order.short" },
                          "order_type": { "margin": "order.margin" } } }
  ],
  "scope":        { "allow": ["equity:us:*"], "deny": ["equity:us:GME", "crypto:*"] },
  "capabilities": { "allow": ["order.place", "order.cancel", "data.read"],
                    "deny":  ["order.short", "order.margin", "funds.withdraw"] },
  "limits": [
    { "id": "per-order-qty",  "metric": "quantity", "window": "per_call",   "max": 500 },
    { "id": "per-order-notl", "metric": "notional", "window": "per_call",   "max": 50000, "unit": "USD" },
    { "id": "daily-orders",   "metric": "count",    "window": "per_day",    "max": 200 },
    { "id": "order-rate",     "metric": "count",    "window": "per_minute", "max": 10 }
  ],
  "windows":      [ { "id": "rth", "sessions": ["regular"],
                      "applies_to": { "capabilities": ["order.place"] } } ],
  "irreversible": [ { "id": "unwind", "capability": "order.place",
                      "when": { "side": "sell_all" } } ]
}
```

## 4. Open questions (this is what to discuss)

1. **Cumulative exposure (D9).** How much, if any, belongs in a mandate? Options:
   (a) leave it entirely to the OMS; (b) let a mandate declare the limit and mark
   the call `unjudged` for it, so coverage is *measured* even though the runtime
   can't enforce it; (c) let the enforcement point feed a position snapshot back
   the way `obligation_results` are fed back. Recommendation to debate: (b) now,
   (c) as a future obligation type.
2. **Notional without a price (D5/D10).** A ticket that carries `notional` is
   checkable; one that carries only `quantity` is not, unless a price is supplied —
   which the runtime must not invent. Do we standardise a `notional` ticket field,
   or accept that price-derived limits are OMS-only?
3. **Manipulation as sequence (D12).** `market_manipulation.*` is real but invisible
   per-call. Is it in-scope for a *mandate* at all, or is it a separate
   session-level detector that a mandate merely coexists with? (Current draft:
   separate detector; the benchmark scores it in a different lane.)
4. **Kill-switch / halt.** MiFID II RTS 6 requires kill functionality. In OGR terms
   that is `fail_mode: closed` on the trading categories plus an operator flip of
   the workspace policy — not a mandate field. Does that satisfy a collaborator's
   compliance framing, or do they need an explicit `halt` primitive?
5. **Provenance for MNPI (D11).** Catching `restricted_information.mnpi` needs the
   information's origin to be labelled (a taint tag). Where does that labelling come
   from in a real agent, and is it in scope for us to specify?

## 5. Non-goals

- **Not** a pre-trade risk control, market-access gateway, or OMS. (See
  `mandate.md § what a mandate cannot do`.)
- **Not** a compliance determination. OGR names *what was detected*, never *whether
  it was lawful* — that depends on venue, jurisdiction and intent, none of which
  reach a detector.
- **Not** a new top-level `finance.*` taxonomy domain. Trading is an application
  vertical mapped onto neutral ids, exactly as healthcare and security-operations
  are.

## How to give feedback

Open a **GitHub Discussion** (Ideas/RFC) or a **Draft PR** that touches only this
file — a Draft PR gives line-level comment threads, which is the best way to argue a
specific dimension. Do **not** open a normative PR against `specification/` until
the dimension set has settled here.
