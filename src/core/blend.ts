/**
 * Blend the structural model prior with the market-implied prior:
 *
 *   p_final = (1 − λ) · p_model + λ · p_market,   λ = MARKET_BLEND (default 0.3)
 *
 * ── The consensus-copy tension ───────────────────────────────────────────────
 * Anchoring on the market (λ > 0) almost always improves Brier score, because
 * a liquid market is itself a strong aggregator — but a forecast that merely
 * copies the market price carries zero marginal information. In a syndicate
 * that pays for *marginal contribution* (Numerai-style MMC, which WorkPnP aims
 * for), pure consensus-copying earns nothing; and as a trader, p ≈ p_market
 * means edge ≈ 0, so you never trade. λ therefore trades calibration safety
 * against informational value: λ=1 is a perfectly safe, perfectly useless
 * parrot; λ=0 is a pure model that will be sharply wrong whenever the market
 * knows something Elo doesn't (injuries, lineups, weather). v0 defaults to
 * λ=0.3 — mostly model, market-tempered.
 */

import type { OutcomeProbs } from "./types.js";

/** Default λ when MARKET_BLEND is unset. */
export const DEFAULT_MARKET_BLEND = 0.3;

/** Read λ from the MARKET_BLEND env var, clamped to [0,1]. */
export function marketBlendLambda(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["MARKET_BLEND"];
  if (raw === undefined || raw === "") return DEFAULT_MARKET_BLEND;
  const v = Number(raw);
  if (!Number.isFinite(v)) return DEFAULT_MARKET_BLEND;
  return Math.min(1, Math.max(0, v));
}

/**
 * Convex per-outcome combination, renormalized. If `model` is undefined
 * (e.g. a team has no Elo rating), degrades cleanly to the market prior.
 */
export function blend(
  model: OutcomeProbs | undefined,
  market: OutcomeProbs,
  lambda: number,
): OutcomeProbs {
  if (!model) return { ...market };
  const l = Math.min(1, Math.max(0, lambda));
  const home = (1 - l) * model.home + l * market.home;
  const draw = (1 - l) * model.draw + l * market.draw;
  const away = (1 - l) * model.away + l * market.away;
  const sum = home + draw + away;
  return { home: home / sum, draw: draw / sum, away: away / sum };
}
