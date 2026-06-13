/**
 * Edge computation and fractional-Kelly sizing. DRY RUN ONLY in v0:
 * TradeIntents are printed, never sent to any exchange.
 *
 * Edge model:
 *   edge = |p − marketMid| − spread/2 − takerFee(p)
 * where takerFee(p) = 0.03 · p · (1 − p) approximates Polymarket's 2026 sports
 * taker-fee curve: it peaks at 0.0075 (0.75% of notional) at p = 0.50 and
 * vanishes at the extremes, matching the published "~0.75% peak at 50¢" shape.
 * (Maker flow is rebated 100%; v0 conservatively prices every fill as taker.)
 *
 * Sizing: binary-outcome Kelly. Buying YES at effective price a with belief p:
 *   f* = (p − a) / (1 − a)        (fraction of bankroll at full Kelly)
 * Buying NO is the mirror image at price (1 − a) with belief (1 − p).
 * We then scale by KELLY_FRACTION (default 0.25) and cap the stake at
 * MAX_BANKROLL_SHARE = 15% of BANKROLL_USD per market.
 */

import type { TradeIntent, TradeSide } from "./types.js";

export const MAX_BANKROLL_SHARE = 0.15;

export interface DecisionConfig {
  bankrollUsd: number;
  kellyFraction: number;
  edgeThreshold: number;
}

export function decisionConfig(env: NodeJS.ProcessEnv = process.env): DecisionConfig {
  const num = (key: string, fallback: number): number => {
    const v = Number(env[key]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    bankrollUsd: num("BANKROLL_USD", 100),
    kellyFraction: num("KELLY_FRACTION", 0.25),
    edgeThreshold: num("EDGE_THRESHOLD", 0.03),
  };
}

/** Polymarket sports taker-fee approximation (fraction of $1 notional). */
export function takerFee(p: number): number {
  return 0.03 * p * (1 - p);
}

/** Net edge after spread and fee haircuts. Can be negative. */
export function computeEdge(p: number, marketMid: number, spread: number): number {
  return Math.abs(p - marketMid) - spread / 2 - takerFee(p);
}

/** Full-Kelly fraction for buying a binary claim at price `price` with belief `belief`. */
export function kellyFraction(belief: number, price: number): number {
  if (price <= 0 || price >= 1) return 0;
  return (belief - price) / (1 - price);
}

/**
 * Decide whether to (dry-run) trade one market.
 * Returns null when the net edge is below the threshold or Kelly is non-positive.
 */
export function decide(
  args: { marketSlug: string; p: number; marketMid: number; spread: number },
  cfg: DecisionConfig,
): TradeIntent | null {
  const { marketSlug, p, marketMid, spread } = args;
  if (!(p > 0 && p < 1) || !(marketMid > 0 && marketMid < 1)) return null;

  const edge = computeEdge(p, marketMid, spread);
  if (edge < cfg.edgeThreshold) return null;

  const side: TradeSide = p > marketMid ? "BUY_YES" : "BUY_NO";
  // Effective entry price: cross half the spread and pay the taker fee.
  const fee = takerFee(p);
  const effPrice =
    side === "BUY_YES"
      ? Math.min(0.999, marketMid + spread / 2 + fee)
      : Math.min(0.999, 1 - marketMid + spread / 2 + fee);
  const belief = side === "BUY_YES" ? p : 1 - p;

  const fullKelly = kellyFraction(belief, effPrice);
  if (fullKelly <= 0) return null;

  const stakeRaw = cfg.kellyFraction * fullKelly * cfg.bankrollUsd;
  const stakeUsd = Math.min(stakeRaw, MAX_BANKROLL_SHARE * cfg.bankrollUsd);
  if (stakeUsd <= 0) return null;

  return {
    marketSlug,
    side,
    p: round4(p),
    marketPrice: round4(marketMid),
    edge: round4(edge),
    stakeUsd: Math.round(stakeUsd * 100) / 100,
  };
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
