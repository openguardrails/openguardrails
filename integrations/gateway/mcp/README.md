# OpenGuardrails MCP gateway

An MCP server that sits in front of another MCP server and judges every tool call before
forwarding it. The first vantage in the OGR ecosystem that speaks MCP itself — the hooks
(`integrations/agent/*`) see an MCP call only as a name inside a harness; this gateway holds
the call, the credential, and the reply.

```
agent ──MCP over streamable-http, Bearer <principal token>──▶ ogr-mcp-gateway ──MCP over stdio──▶ upstream (e.g. Alpaca)
                                                                    │
                                                                    ├─ mandate   argument-level envelope per workspace   (specification/mandate.md)
                                                                    ├─ pretrade  stateful account limits — the OMS layer   (proposals/quant-agent-mandate.md, D9)
                                                                    ├─ runtime   POST /v1/evaluate — permission rules, semantic guards, console
                                                                    └─ audit     one JSONL line per call: who, what, verdict, why
```

## Why a gateway and not only a hook

| | hook (`PreToolUse`) | this gateway |
|---|---|---|
| Sees the call | yes, as `mcp__server__tool` | yes, with the upstream's real schema |
| Holds the upstream credential | no — the agent's MCP config does | **yes — only the gateway does** |
| Can the agent bypass it | yes (edit its own MCP config, or curl the API) | only by obtaining the credential it never had |
| Argument-level policy | no (`permissions.ts` matches tool names) | yes — the mandate spec, implemented |
| Stateful limits (exposure, daily loss) | no | yes — `pretrade`, deliberately outside the mandate |
| Works for dsh / Codex / Claude Code / anything | only harnesses with hooks | anything that speaks MCP |

The gateway does not replace the hooks; a harness can run both. It replaces the practice of
handing an agent a credential and hoping.

## Install and run

```sh
pip install -e integrations/gateway/mcp          # python >= 3.10; deps: mcp, uvicorn
cp config.example.json config.json               # secrets come from the environment, see below
export ALPACA_API_KEY=... ALPACA_SECRET_KEY=...  # upstream credential — the gateway's, never the agent's
export OGR_MCP_TOKEN_JUNIOR=$(openssl rand -hex 24) OGR_MCP_TOKEN_MID=... OGR_MCP_TOKEN_SENIOR=...
export OGR_RUNTIME_URL=http://localhost:3000 OGR_API_KEY=ogr_...   # optional; omit both to run without the runtime
ogr-mcp-gateway --check                          # boots the upstream, prints what each principal would see
ogr-mcp-gateway                                  # serves http://127.0.0.1:8790/mcp
```

Point an agent at it with its own token:

```sh
# Claude Code
claude -p "..." --strict-mcp-config --mcp-config '{"mcpServers":{"alpaca":{"type":"http","url":"http://127.0.0.1:8790/mcp","headers":{"Authorization":"Bearer '$OGR_MCP_TOKEN_SENIOR'"}}}}'
# Codex
codex mcp add alpaca --url http://127.0.0.1:8790/mcp --bearer-token-env-var OGR_MCP_TOKEN_MID
# dsh (profile cordis.patch.yml)
- id: mcp-alpaca
  name: '@deepseek-ai/dsh-mcp-client'
  config: { serverName: alpaca, transport: streamable-http, url: http://127.0.0.1:8790/mcp,
            headers: { Authorization: !!js '`Bearer ${process.env.OGR_MCP_TOKEN_JUNIOR}`' } }
```

`--stdio` serves a single principal over stdio (identity from `$OGR_MCP_TOKEN`) for a local
harness that cannot do HTTP.

## Configuration

One JSON file; every `${VAR}` is expanded from the gateway's environment so the file holds no
secret. See `config.example.json`.

| Key | Meaning |
|---|---|
| `upstream` | the server to spawn over stdio: `command`, `args`, `env` (the credential lives here) |
| `principals[]` | `token` → identity four-tuple (`agent_id`, `agent_type`, `workspace`, `user`). The token is the identity; one per agent |
| `mandates{}` | workspace → mandate document (path or inline). A workspace without one is granted **nothing** |
| `pretrade` | stateful order checks, `enabled: false` to run mandate-only. `halt_file`: create it to withhold every `order.*` except cancel |
| `runtime` | `url` + `api_key` to report each call as a canonical `step/response` and honour the verdict; `fail_mode` `closed` (default) or `open` |
| `hide_ungranted_tools` | `list_tools` omits tools whose capability the mandate does not grant (default true) |
| `audit_log`, `ledger` | JSONL audit; sqlite counters (rate windows) and small state (peak equity) |

### Mandates

Plain `schema/mandate.schema.json` documents, resolved by workspace — exactly the resolution the
spec prescribes, done at this enforcement point until the runtime holds them. The three shipped
examples bind every one of Alpaca's 72 tools and differ only in what they grant:

| workspace | capabilities | limits |
|---|---|---|
| `quant-junior` | `data.read` | 60 reads/min |
| `quant-mid` | + `order.cancel` | 20 cancels/day |
| `quant-senior` | + `order.place`, `order.close`; short/option/crypto/bracket/extended-hours/unwind/replace/cancel-all/account-config withheld | 15,000 USD per order, 5 orders/min, 40/day, RTH only; `close_all_positions` and `cancel_all_orders` reserved to a human |

Evaluator semantics follow `examples/mandate-agent/evaluate_mandate.py`, with two additions:
count windows persist in the ledger, and a ticket that carries only a quantity leaves the
notional limit `unjudged` — the mandate must not invent a price. `pretrade` may.

### Pre-trade (the OMS layer)

`specification/mandate.md` says a mandate is not a pre-trade risk control. This module is
one, kept separate so the boundary is visible. Before an `order.place` / `order.close` is
forwarded it reads the account and positions through the upstream's own tools, prices a
quantity-only ticket from the latest trade, and refuses: going short, buying beyond cash,
a position over `max_position_pct`, gross exposure over `max_gross_exposure`, a day down more
than `max_daily_loss_pct`, a book more than `max_drawdown_pct` below its peak (peak kept in
the ledger), order types / time-in-force / extended hours outside the allow-lists. Findings use
the neutral `security.mandate_violation.*` ids with `detector: "pretrade"`.

## What the agent sees on a refusal

An `isError` result whose text is `{"_ogr": {"decision": "block", "stage": ..., "reason": ...,
"findings": [...], "unjudged": [...], "instructions": "…do not retry with altered arguments…"}}`
— the refusal in the caller's own protocol, with the finding ids, not a stack trace.

## Honest limits

- The gateway judges the calls it is given. An agent with the upstream credential, or with
  shell access to a machine that has it, is outside its reach — keep credentials on the gateway
  host only and govern egress separately.
- Per-principal policy is by workspace, one mandate each, as the runtime does it. Three
  employees with different envelopes are three workspaces.
- Human approval is not an outcome (`mandate.md` declines it on purpose). An irreversible rule
  blocks; a human acts through their own channel.
- The runtime report is the hook's fragment vantage: one tool call, no model request/response
  around it. The gateway never sees the model's reasoning.
- Not a market-access control in the regulatory sense (SEC 15c3-5 / RTS 6); those belong at
  the broker. This is the layer above them.

## Tests

```sh
pip install -e ".[dev]" && pytest -q      # 26 tests: mandate dimensions, pretrade maths, gateway stages with a fake upstream
```
