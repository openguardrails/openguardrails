/**
 * The v0 Bayesian pipeline for one World Cup match:
 *
 *   Gamma event ──┬─► de-vigged market prior (devig.ts)
 *                 │
 *   Elo ratings ──┴─► Poisson model prior (elo.ts + poisson.ts)
 *                       │
 *                       ▼
 *           blend (λ = MARKET_BLEND) ─► three Forecast JSONs (contract §1.1)
 *
 * If either team has no Elo mapping/rating the model leg is skipped and the
 * forecast degrades to a market-only prior (method "market_devig").
 */

import { blend, marketBlendLambda } from "./blend.js";
import { devig } from "./devig.js";
import { eloForSlugCode, teamName, WC_HOSTS, type EloTable } from "./elo.js";
import { matchProbs } from "./poisson.js";
import { midPrice, type GammaMarket, type WcMatch } from "./gamma.js";
import { clampP, validateForecast, type EvidenceItem, type Forecast, type OutcomeProbs } from "./types.js";

export interface MatchForecasts {
  match: WcMatch;
  marketProbs: OutcomeProbs;
  modelProbs: OutcomeProbs | undefined;
  blended: OutcomeProbs;
  lambda: number;
  method: string;
  /** home, away, draw — one Forecast per sub-market. */
  forecasts: [Forecast, Forecast, Forecast];
}

function mustMid(market: GammaMarket): number {
  const mid = midPrice(market);
  if (mid === undefined || mid <= 0 || mid >= 1) {
    throw new Error(`no usable mid price for ${market.slug} (got ${mid})`);
  }
  return mid;
}

/**
 * Build the three §1.1 Forecast JSONs for a match. `workIds` maps each
 * sub-market slug to its WorkPnP work id; absent entries get "local" ids
 * (ledger-only forecasts that were never tied to a work item).
 */
export function buildMatchForecasts(
  match: WcMatch,
  eloTable: EloTable,
  opts: { workIds?: Record<string, string>; env?: NodeJS.ProcessEnv } = {},
): MatchForecasts {
  const env = opts.env ?? process.env;
  const ts = new Date().toISOString();

  // Market prior from de-vigged mids.
  const mids: OutcomeProbs = {
    home: mustMid(match.homeMarket),
    draw: mustMid(match.drawMarket),
    away: mustMid(match.awayMarket),
  };
  const { probs: marketProbs, overround } = devig(mids);

  // Model prior from Elo + Poisson, if both teams are rated.
  const eloHome = eloForSlugCode(eloTable, match.homeCode);
  const eloAway = eloForSlugCode(eloTable, match.awayCode);
  const haveElo = eloHome !== undefined && eloAway !== undefined;
  const modelProbs = haveElo
    ? matchProbs(eloHome, eloAway, WC_HOSTS.has(match.homeCode), WC_HOSTS.has(match.awayCode))
    : undefined;

  const lambda = marketBlendLambda(env);
  const blended = blend(modelProbs, marketProbs, lambda);
  const method = haveElo ? "elo_poisson+market_devig" : "market_devig";

  const evidence: EvidenceItem[] = [];
  if (haveElo) {
    evidence.push({
      source: "elo",
      claim: `${teamName(match.homeCode)} ${eloHome} vs ${teamName(match.awayCode)} ${eloAway} (${eloTable.source}, ${eloTable.sourcedAt})`,
      effect: `model prior ${fmtProbs(modelProbs!)}`,
      url: "https://www.eloratings.net/",
      ts,
    });
  }
  evidence.push({
    source: "gamma",
    claim: `devigged mids ${fmtProbs(marketProbs)} (overround ${overround.toFixed(4)})`,
    effect: `blended with λ=${lambda}`,
    url: `https://polymarket.com/event/${match.eventSlug}`,
    ts,
  });

  const mk = (market: GammaMarket, p: number, priorValue: number): Forecast => {
    const f: Forecast = {
      schema: "openthomas/forecast@0.1",
      workId: opts.workIds?.[market.slug] ?? `local_${market.slug}`,
      marketSlug: market.slug,
      tokenLabel: market.groupItemTitle ?? market.question,
      p: clampP(p),
      ci: heuristicCi(p, modelProbs, marketProbs, market.slug, match),
      prior: { value: clampP(priorValue), method },
      evidence,
      ts,
    };
    const errors = validateForecast(f);
    if (errors.length > 0) {
      throw new Error(`invalid forecast for ${market.slug}: ${errors.join("; ")}`);
    }
    return f;
  };

  const priors = modelProbs ?? marketProbs;
  return {
    match,
    marketProbs,
    modelProbs,
    blended,
    lambda,
    method,
    forecasts: [
      mk(match.homeMarket, blended.home, priors.home),
      mk(match.awayMarket, blended.away, priors.away),
      mk(match.drawMarket, blended.draw, priors.draw),
    ],
  };
}

/**
 * Heuristic 90% CI: centered on p, half-width = max(0.03, model↔market
 * disagreement on this outcome). Wide disagreement ⇒ wide interval. Documented
 * as a heuristic, not a posterior quantile — v0 has no sampling machinery.
 */
function heuristicCi(
  p: number,
  model: OutcomeProbs | undefined,
  market: OutcomeProbs,
  marketSlug: string,
  match: WcMatch,
): [number, number] {
  let disagreement = 0.03;
  if (model) {
    const key: keyof OutcomeProbs = marketSlug.endsWith("-draw")
      ? "draw"
      : marketSlug === `${match.eventSlug}-${match.homeCode}`
        ? "home"
        : "away";
    disagreement = Math.max(0.03, Math.abs(model[key] - market[key]));
  }
  const lo = Math.max(0.0001, p - disagreement);
  const hi = Math.min(0.9999, p + disagreement);
  return [Math.round(lo * 10000) / 10000, Math.round(hi * 10000) / 10000];
}

export function fmtProbs(p: OutcomeProbs): string {
  return `H ${p.home.toFixed(3)} / D ${p.draw.toFixed(3)} / A ${p.away.toFixed(3)}`;
}
