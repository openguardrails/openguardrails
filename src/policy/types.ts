// Internal policy shapes. Persisted in ~/.thomas/policies.json.
// Public output uses src/cli/output.ts PolicyData / PolicySnapshot.

import type { AgentId } from "../agents/types.js";

// Exactly ONE of triggerSpendDay / triggerCallsDay must be set on each rule.
// Validated at policy-set time. Spend triggers compare against today's
// accumulated cost; calls triggers compare against today's call count. Calls
// triggers exist for usage-based providers (subscription2api) where spend is
// null and dollar gating is moot.
export type CostCascadeRule = {
  triggerSpendDay?: number;
  triggerCallsDay?: number;
  fallback: { provider: string; model: string };
};

export type CostCascadePolicy = {
  id: "cost-cascade";
  primary: { provider: string; model: string };
  cascade: CostCascadeRule[];
  // optional in-run failover target. The proxy retries once on this target
  // when the primary returns a retryable error (network / 408 / 429 / 5xx).
  // Independent of cascade — cascade is for cost, failover is for reliability.
  failoverTo?: { provider: string; model: string };
};

// Bundle: ordered set of (provider, model) legs with per-leg daily caps.
// Sorted ascending by priority (lower = tried first). A leg becomes
// "exhausted" once today's spend ≥ capUsdPerDay OR today's calls ≥
// capCallsPerDay; the picker advances to the next leg. When all legs are
// exhausted we stay on the last (lowest-priority) leg — explicit overrun
// is preferable to a 503 with no upstream attempted.
//
// Cloud-defined only (no `thomas bundle set` CLI yet) — translated from
// SchemaBundleResponse in src/cloud/policy-bridge.ts.
export type BundleLeg = {
  target: { provider: string; model: string };
  priority: number;
  capUsdPerDay?: number;
  capCallsPerDay?: number;
};

export type BundlePolicy = {
  id: "bundle";
  legs: BundleLeg[];
  // Same in-run failover semantics as CostCascadePolicy. Optional and
  // currently never set by the cloud bridge, but plumbed so future
  // bundle specs can opt into reliability failover.
  failoverTo?: { provider: string; model: string };
};

// Discriminated union — extend with `| { id: "..."; ... }` when more policies land.
export type PolicyConfig = CostCascadePolicy | BundlePolicy;

// Local store holds only cost-cascade — the CLI (`thomas policy set`) sets
// nothing else. Bundle policies originate from thomas-cloud and flow through
// src/cloud/policy-bridge.ts directly, never persisted to ~/.thomas/policies.json.
export type PoliciesStore = {
  policies: Partial<Record<AgentId, CostCascadePolicy>>;
};

export type PolicyDecision = {
  target: { provider: string; model: string };
  reason: string;
  policyId: PolicyConfig["id"] | null;
  /**
   * The full policy that produced this decision, if any. Lets callers reach
   * for `failoverTo` (or future fields) without re-reading the store. Null
   * when the decision was just "use the fallback target" (no policy bound).
   */
  policy: PolicyConfig | null;
  /**
   * Where the policy came from. "cloud" = pulled from ~/.thomas/cloud-cache.json.
   * "local" = ~/.thomas/policies.json. "none" = no policy was bound.
   * Surfaced for telemetry / debugging — not part of the decision logic.
   */
  source: "cloud" | "local" | "none";
};
