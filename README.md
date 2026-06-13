# OpenThomas

An open-source **Bayesian trading worker** for prediction markets, named after Thomas Bayes.

v0 scope: forecast **2026 World Cup match moneyline markets on Polymarket** with statistical
priors (Elo → Poisson), de-vigged market prices, and a transparent blend — then keep every
belief on an **append-only ledger** and work as a forecaster on a
[WorkPnP](../workpnp) pool. Trade decisions are computed **dry-run only**.

Hard limits in v0 (by design, see `CONTRACT_v0.md` §6):

- **No LLM calls.** Priors are pure statistics: Elo win expectancy → expected goals →
  independent Poisson → outcome probabilities.
- **No private keys, no real orders.** `openthomas edge` prints intended trades
  (edge / fractional Kelly) and stops there.
- **No invented numbers.** If a team has no Elo rating, the model leg is skipped and the
  forecast degrades to a market-only prior.

## The belief ledger philosophy

Most trading bots are black boxes that remember only their PnL. OpenThomas treats the
*belief* as the primary artifact: every forecast it ever emits is appended to
`~/.openthomas/forecasts.jsonl` as a self-contained JSON record — probability, prior,
method, and evidence chain (which Elo ratings, which market prices, which blend λ).
Outcomes are back-filled into a separate `settlements.jsonl`; the original belief is never
edited. That makes calibration honest and auditable: `openthomas calib` computes Brier
score and a 10-bucket calibration curve from the raw record, and anyone can recompute it.

The same Forecast JSON (`openthomas/forecast@0.1`, frozen in `CONTRACT_v0.md` §1.1) is
simultaneously the ledger entry and the deliverable WorkPnP scores — one format, three uses.

## The model (v0)

1. **Elo prior** — national-team ratings from [eloratings.net](https://www.eloratings.net/)
   (live TSV fetch with a bundled snapshot fallback in `data/elo-snapshot.json`).
   Win expectancy `We = 1/(1+10^(−d/400))`; WC 2026 venues are neutral except when a host
   (USA/CAN/MEX) plays, which earns +100 Elo.
2. **Poisson** — `We` maps to an expected goal difference (`We=0.76 ≈ +1 goal`), split
   around a 2.6 total-goals baseline; independent Poisson goals (truncated at 10) give
   P(home/draw/away).
3. **Market prior** — the three Polymarket moneyline mids, de-vigged by normalization
   (negRisk books already sum to ≈1).
4. **Blend** — `p = (1−λ)·model + λ·market`, `λ = MARKET_BLEND` (default 0.3). See the
   comment in `src/core/blend.ts` for why copying the market is safe but worthless.

## Quickstart

```sh
npm install
npm run build
npm link        # optional: puts `openthomas` on your PATH

# What's playing, and what does the market think?
openthomas scan

# Full pipeline for one match → three Forecast JSONs + ledger write
openthomas forecast fifwc-usa-par-2026-06-12

# Dry-run trade intents from your ledgered forecasts vs current prices
openthomas edge

# Calibration: first backfill resolutions from Gamma, then report
openthomas calib settle-sync
openthomas calib
```

(Or run from source without building: `npm run dev -- scan`.)

## Connecting to WorkPnP

WorkPnP is the research-syndicate side: sponsors fund pools of forecast work; workers
submit probabilities and get paid wages per accepted submission plus a profit-linked bonus.

```sh
export WORKPNP_URL=http://localhost:8787

# 1. Register (the apiKey is shown exactly once — the server stores a hash)
openthomas register --name thomas --wallet 0xYourPayoutAddress
export WORKPNP_API_KEY=<the printed key>

# 2. Work: poll open forecast work, forecast each market, submit, ledger
openthomas work              # one pass
openthomas work --loop --interval 600   # keep polling
```

Already-submitted work items are tracked in `~/.openthomas/state.json` and skipped.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `WORKPNP_URL` | `http://localhost:8787` | WorkPnP server |
| `WORKPNP_API_KEY` | — | worker key from `openthomas register` |
| `MARKET_BLEND` | `0.3` | λ: weight of the market prior in the blend |
| `BANKROLL_USD` | `100` | dry-run bankroll for Kelly sizing |
| `KELLY_FRACTION` | `0.25` | fraction of full Kelly |
| `EDGE_THRESHOLD` | `0.03` | minimum net edge to emit a TradeIntent |
| `LEDGER_DIR` | `~/.openthomas` | belief-ledger directory |

## Repository layout

```
src/core/gamma.ts     Gamma API client (discovery method documented in comments)
src/core/elo.ts       Elo ratings: live fetch → snapshot fallback; 48-team slug mapping
src/core/poisson.ts   Elo → expected goals → Poisson → outcome probabilities
src/core/devig.ts     market mids → implied probabilities
src/core/blend.ts     model/market blend (λ)
src/core/pipeline.ts  match → three contract-valid Forecast JSONs
src/core/ledger.ts    append-only forecasts.jsonl / settlements.jsonl + calibration
src/core/decision.ts  edge, taker-fee model, fractional Kelly (DRY RUN ONLY)
src/workpnp/client.ts WorkPnP worker API client (contract §2)
src/cli.ts            commander CLI (`openthomas`)
data/elo-snapshot.json  frozen eloratings.net snapshot (see its sourcedAt field)
```

## Development

```sh
npm test          # vitest
npm run build     # tsc → dist/
```

MIT © 2026
