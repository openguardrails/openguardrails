/**
 * Elo → expected goals → independent Poisson → P(home win / draw / away win).
 *
 * Model (deliberately simple, fully documented):
 * 1. Elo win expectancy  We = 1 / (1 + 10^(-d/400)) with d = eloHome − eloAway
 *    (+ HOME_ADVANTAGE_ELO for a host nation; WC 2026 is on neutral ground
 *    except when USA/CAN/MEX themselves play).
 * 2. Map We to an expected goal difference. From the Elo identity,
 *    d = 400·log10(We/(1−We)); we set  λdiff = d/200 = 2·log10(We/(1−We)).
 *    Calibration anchors: We=0.50 → λdiff 0;  We=0.76 → λdiff ≈ +1.00 goal
 *    (log10(0.76/0.24) ≈ 0.5006). This is the documented "We=0.76 ≈ +1 goal"
 *    rule of thumb.
 * 3. Split a total-goals baseline TOTAL_GOALS = 2.6 (typical World Cup average)
 *    around that difference:  λhome = (2.6 + λdiff)/2, λaway = (2.6 − λdiff)/2,
 *    floored at MIN_LAMBDA so extreme mismatches stay well-defined.
 * 4. Independent Poisson goals, truncated at MAX_GOALS = 10 per side, summed
 *    into P(home), P(draw), P(away). Renormalized (truncation loss is tiny).
 *
 * All functions are pure.
 */

import type { OutcomeProbs } from "./types.js";

/** Elo bonus for a WC 2026 host nation playing on home soil (~standard home edge). */
export const HOME_ADVANTAGE_ELO = 100;
/** Baseline total goals per match. */
export const TOTAL_GOALS = 2.6;
/** Truncate Poisson goal distributions at this many goals per team. */
export const MAX_GOALS = 10;
/** Floor for either side's goal expectation. */
export const MIN_LAMBDA = 0.2;

/** Elo win expectancy: We = 1/(1+10^(-d/400)). */
export function winExpectancy(eloDiff: number): number {
  return 1 / (1 + Math.pow(10, -eloDiff / 400));
}

/** Expected goal difference for a given win expectancy (We=0.5→0, We=0.76→≈+1). */
export function goalDiffFromWinExpectancy(we: number): number {
  const clamped = Math.min(0.999, Math.max(0.001, we));
  return 2 * Math.log10(clamped / (1 - clamped));
}

/** Poisson pmf P(X=k) for mean lambda. */
export function poissonPmf(k: number, lambda: number): number {
  if (k < 0) return 0;
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

/** Expected goals (λhome, λaway) for an Elo difference d (already host-adjusted). */
export function expectedGoals(eloDiff: number): { lambdaHome: number; lambdaAway: number } {
  const we = winExpectancy(eloDiff);
  const diff = goalDiffFromWinExpectancy(we);
  return {
    lambdaHome: Math.max(MIN_LAMBDA, (TOTAL_GOALS + diff) / 2),
    lambdaAway: Math.max(MIN_LAMBDA, (TOTAL_GOALS - diff) / 2),
  };
}

/** P(home win / draw / away win) from two independent Poisson goal counts. */
export function outcomeProbsFromLambdas(lambdaHome: number, lambdaAway: number): OutcomeProbs {
  const ph: number[] = [];
  const pa: number[] = [];
  for (let k = 0; k <= MAX_GOALS; k++) {
    ph.push(poissonPmf(k, lambdaHome));
    pa.push(poissonPmf(k, lambdaAway));
  }
  let home = 0;
  let draw = 0;
  let away = 0;
  for (let i = 0; i <= MAX_GOALS; i++) {
    for (let j = 0; j <= MAX_GOALS; j++) {
      const p = (ph[i] ?? 0) * (pa[j] ?? 0);
      if (i > j) home += p;
      else if (i === j) draw += p;
      else away += p;
    }
  }
  const total = home + draw + away;
  return { home: home / total, draw: draw / total, away: away / total };
}

/**
 * Full model: Elo ratings → moneyline probabilities.
 * `homeIsHost` / `awayIsHost`: WC 2026 venues are neutral unless USA/CAN/MEX play;
 * the host side gets HOME_ADVANTAGE_ELO (if both flags were set they cancel out).
 */
export function matchProbs(
  eloHome: number,
  eloAway: number,
  homeIsHost = false,
  awayIsHost = false,
): OutcomeProbs {
  let d = eloHome - eloAway;
  if (homeIsHost) d += HOME_ADVANTAGE_ELO;
  if (awayIsHost) d -= HOME_ADVANTAGE_ELO;
  const { lambdaHome, lambdaAway } = expectedGoals(d);
  return outcomeProbsFromLambdas(lambdaHome, lambdaAway);
}
