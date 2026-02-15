import { TIERS, type TierId, type Feature } from "@og/shared";

/** Check if a tier has a specific feature */
export function tierHasFeature(tier: TierId, feature: Feature): boolean {
  const config = TIERS[tier];
  return config ? config.features.includes(feature) : false;
}

/** Get all features available for a tier */
export function getTierFeatures(tier: TierId): Feature[] {
  const config = TIERS[tier];
  return config ? [...config.features] : [];
}

/** Check if agent count is within tier limits */
export function canAddAgent(tier: TierId, currentCount: number): boolean {
  const config = TIERS[tier];
  if (!config) return false;
  return currentCount < config.maxAgents;
}
