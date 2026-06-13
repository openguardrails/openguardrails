/**
 * De-vig the three Polymarket moneyline mid prices into market-implied
 * probabilities by proportional normalization (sum to 1).
 *
 * On a negRisk event the three YES prices already sum to ~1 (the overround is
 * tiny compared to a bookmaker), so plain normalization is appropriate here —
 * no need for Shin's method at these vig levels.
 */

import type { OutcomeProbs } from "./types.js";

export interface DevigResult {
  probs: OutcomeProbs;
  /** Sum of the raw prices before normalization (≈1.00 on negRisk books). */
  overround: number;
}

/** Normalize three mid prices to a probability distribution. Throws on invalid input. */
export function devig(prices: OutcomeProbs): DevigResult {
  const { home, draw, away } = prices;
  for (const [label, v] of Object.entries({ home, draw, away })) {
    if (!Number.isFinite(v) || v <= 0 || v >= 1) {
      throw new Error(`devig: ${label} price out of (0,1): ${v}`);
    }
  }
  const sum = home + draw + away;
  return {
    probs: { home: home / sum, draw: draw / sum, away: away / sum },
    overround: sum,
  };
}
