// Bundle leg picker. Pure logic — given a BundlePolicy and per-leg usage
// for the current UTC day, return the highest-priority leg whose caps are
// not yet exhausted.
//
// Exhaustion rules per leg:
//   capUsdPerDay set  AND legSpend !== null AND legSpend  ≥ capUsdPerDay   → exhausted
//   capCallsPerDay set                       AND legCalls ≥ capCallsPerDay → exhausted
//
// legSpend === null (the leg recorded calls but at least one had cost: null —
// subscription provider, no price entry) means the dollar cap can't be
// evaluated honestly. We DON'T exhaust on null spend; the calls cap (if set)
// still applies. This mirrors the cost-cascade rule's null-spend handling
// in src/policy/decide.ts:71.
//
// All-exhausted fallback: stick with the lowest-priority leg (the tail).
// Returning a 503 here would be worse — the cap is the user's preference,
// not a hard wall. The reason string makes the overrun explicit so the user
// sees it in `thomas runs` / explain.

import type { RunRecord } from "../runs/types.js";
import type { BundleLeg, BundlePolicy } from "./types.js";

export type LegUsage = {
  calls: number;
  // null when at least one matching run had cost: null. Same semantics as
  // Usage.spend in src/metering/types.ts.
  spend: number | null;
};

export const ZERO_LEG_USAGE: LegUsage = { calls: 0, spend: 0 };

/** Aggregate matching today's runs into per-leg usage, keyed by `provider/model`. */
export function legUsageFromRuns(records: RunRecord[]): Map<string, LegUsage> {
  const out = new Map<string, LegUsage>();
  for (const r of records) {
    const key = legKey(r.outboundProvider, r.outboundModel);
    const prev = out.get(key) ?? { calls: 0, spend: 0 };
    const calls = prev.calls + 1;
    let spend: number | null;
    if (prev.spend === null || r.cost === null) spend = null;
    else spend = prev.spend + r.cost;
    out.set(key, { calls, spend });
  }
  return out;
}

export function legKey(provider: string, model: string): string {
  return `${provider}/${model}`;
}

export type BundleResult = {
  target: { provider: string; model: string };
  reason: string;
  /** Index in policy.legs. Useful for telemetry / tests. */
  legIndex: number;
};

export function decideBundle(
  policy: BundlePolicy,
  usageByLeg: Map<string, LegUsage>,
): BundleResult {
  const legs = policy.legs;
  if (legs.length === 0) {
    // Caller (policy-bridge) guards against this; defensive fallback to
    // a synthetic 0/0 target would create an unusable PolicyDecision.
    throw new Error("decideBundle: bundle has no legs");
  }
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i]!;
    const usage = usageByLeg.get(legKey(leg.target.provider, leg.target.model)) ?? ZERO_LEG_USAGE;
    const exhausted = isExhausted(leg, usage);
    if (!exhausted) {
      return {
        target: leg.target,
        reason: describeBelow(leg, usage),
        legIndex: i,
      };
    }
  }
  // All exhausted — stick on the tail and surface the overrun.
  const tail = legs[legs.length - 1]!;
  const tailUsage =
    usageByLeg.get(legKey(tail.target.provider, tail.target.model)) ?? ZERO_LEG_USAGE;
  return {
    target: tail.target,
    reason: `all ${legs.length} bundle legs exhausted; staying on tail (${describeUsage(tail, tailUsage)})`,
    legIndex: legs.length - 1,
  };
}

function isExhausted(leg: BundleLeg, usage: LegUsage): string | null {
  if (
    leg.capUsdPerDay !== undefined &&
    usage.spend !== null &&
    usage.spend >= leg.capUsdPerDay
  ) {
    return `spend $${usage.spend.toFixed(4)}/day ≥ cap $${leg.capUsdPerDay.toFixed(2)}`;
  }
  if (leg.capCallsPerDay !== undefined && usage.calls >= leg.capCallsPerDay) {
    return `calls ${usage.calls}/day ≥ cap ${leg.capCallsPerDay}`;
  }
  return null;
}

function describeBelow(leg: BundleLeg, usage: LegUsage): string {
  const parts: string[] = [];
  if (leg.capUsdPerDay !== undefined) {
    const spend = usage.spend !== null ? `$${usage.spend.toFixed(4)}` : "$?";
    parts.push(`spend ${spend}/$${leg.capUsdPerDay.toFixed(2)}`);
  }
  if (leg.capCallsPerDay !== undefined) {
    parts.push(`calls ${usage.calls}/${leg.capCallsPerDay}`);
  }
  if (parts.length === 0) parts.push("uncapped leg");
  return `bundle leg ${leg.target.provider}/${leg.target.model} (${parts.join(", ")})`;
}

function describeUsage(leg: BundleLeg, usage: LegUsage): string {
  const parts: string[] = [];
  if (leg.capUsdPerDay !== undefined) {
    const spend = usage.spend !== null ? `$${usage.spend.toFixed(4)}` : "$?";
    parts.push(`spend ${spend} ≥ $${leg.capUsdPerDay.toFixed(2)}`);
  }
  if (leg.capCallsPerDay !== undefined) {
    parts.push(`calls ${usage.calls} ≥ ${leg.capCallsPerDay}`);
  }
  return parts.join(", ");
}
