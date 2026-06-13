/**
 * Shared types. The Forecast shape is the protocol atom frozen in CONTRACT_v0.md §1.1:
 * it is simultaneously OpenThomas's belief-ledger entry and WorkPnP's scoreable deliverable.
 */

export interface EvidenceItem {
  source: string;
  claim: string;
  effect: string;
  url: string;
  ts: string;
}

export interface Forecast {
  schema: "openthomas/forecast@0.1";
  workId: string;
  /** Gamma market slug of the specific binary sub-market, e.g. fifwc-usa-par-2026-06-12-usa */
  marketSlug: string;
  /** What YES means in this binary market, e.g. "United States" or "Draw (...)" */
  tokenLabel: string;
  /** P(YES), open interval (0,1), at most 4 decimal places. */
  p: number;
  /** Optional 90% confidence interval. */
  ci?: [number, number];
  prior: { value: number; method: string };
  evidence?: EvidenceItem[];
  /** Client-side generation time (ISO 8601). Server enforces |now - ts| < 10 min. */
  ts: string;
}

/** WorkPnP work item, CONTRACT_v0.md §1.2. */
export interface WorkItem {
  id: string;
  poolId: string;
  kind: "forecast";
  marketSlug: string;
  marketId: string;
  conditionId: string;
  tokenLabel: string;
  question: string;
  eventTitle: string;
  /** = Gamma gameStartTime; submissions close at kickoff. */
  closesAt: string;
  wageUsd: number;
  status: "open" | "closed" | "scored" | "void";
}

export type TradeSide = "BUY_YES" | "BUY_NO";

export interface TradeIntent {
  marketSlug: string;
  side: TradeSide;
  /** Our blended P(YES). */
  p: number;
  /** Market mid price for YES at decision time. */
  marketPrice: number;
  /** Net edge after spread and taker-fee haircut. */
  edge: number;
  /** Fractional-Kelly stake in USD (capped). DRY RUN ONLY — never sent anywhere. */
  stakeUsd: number;
}

/** Outcome distribution over the three moneyline results of a match. */
export interface OutcomeProbs {
  home: number;
  draw: number;
  away: number;
}

/** Validate a Forecast against the server-enforced rules of CONTRACT_v0.md §1.1. */
export function validateForecast(f: Forecast): string[] {
  const errors: string[] = [];
  if (f.schema !== "openthomas/forecast@0.1") errors.push(`bad schema: ${f.schema}`);
  if (!f.workId) errors.push("missing workId");
  if (!f.marketSlug) errors.push("missing marketSlug");
  if (!f.tokenLabel) errors.push("missing tokenLabel");
  if (!(typeof f.p === "number" && f.p > 0 && f.p < 1)) errors.push(`p out of (0,1): ${f.p}`);
  // Tolerance for binary float representation (e.g. 0.2719*10000 === 2718.9999999999995).
  if (typeof f.p === "number" && Math.abs(f.p * 10000 - Math.round(f.p * 10000)) > 1e-6) {
    errors.push(`p has more than 4 decimal places: ${f.p}`);
  }
  if (f.ci) {
    const [lo, hi] = f.ci;
    if (!(lo >= 0 && hi <= 1 && lo <= hi)) errors.push(`bad ci: [${lo}, ${hi}]`);
  }
  if (!f.prior || typeof f.prior.value !== "number" || !f.prior.method) errors.push("bad prior");
  if (Number.isNaN(Date.parse(f.ts))) errors.push(`unparseable ts: ${f.ts}`);
  return errors;
}

/** Round to at most 4 decimals and clamp into the open interval (0,1) as required by §1.1. */
export function clampP(p: number): number {
  const r = Math.round(p * 10000) / 10000;
  return Math.min(0.9999, Math.max(0.0001, r));
}
