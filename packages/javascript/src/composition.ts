/**
 * Composition — combine many detectors' verdicts into one effective verdict.
 *
 * Port of the Python reference (spec: composition.md). The deployer owns the
 * choice of strategy; OGR owns the mechanism.
 */
import { type Category, type GuardEvent, type Verdict, type Decision, severity, OGR_VERSION } from "./models.js"

export const COMPOSED_PROVIDER = "ogr.runtime/composed"

export interface CompositionRule {
  strategy?: "deny-wins" | "quorum" | "first-available" | string
  quorum?: { count?: number; min_score?: number }
  on_all_failed?: Decision
}

export type Composition = Record<string, CompositionRule>

function merge(ev: GuardEvent, decision: Decision, verdicts: Verdict[], reasonPrefix: string): Verdict {
  const cats = new Map<string, Category>()
  const reasons: string[] = []
  const evidence: Array<Record<string, unknown>> = []
  for (const v of verdicts) {
    for (const c of v.categories) {
      const existing = cats.get(c.id)
      if (!existing || c.score > existing.score) cats.set(c.id, c)
    }
    for (const r of v.reasons) reasons.push(`[${v.provider}] ${r}`)
    evidence.push({ provider: v.provider, decision: v.decision, latencyMs: v.latencyMs })
  }
  return {
    eventId: ev.eventId,
    guardId: ev.guardId,
    provider: COMPOSED_PROVIDER,
    decision,
    categories: [...cats.values()],
    reasons: [reasonPrefix, ...reasons],
    evidence,
    ogrVersion: OGR_VERSION,
  }
}

const mostSevere = (verdicts: Verdict[]): Verdict =>
  verdicts.reduce((a, b) => (severity(b.decision) < severity(a.decision) ? b : a))

export function compose(ev: GuardEvent, verdicts: Verdict[], rule: CompositionRule): Verdict {
  const strategy = rule.strategy ?? "deny-wins"
  if (verdicts.length === 0) {
    return {
      eventId: ev.eventId,
      guardId: ev.guardId,
      provider: COMPOSED_PROVIDER,
      decision: rule.on_all_failed ?? "allow",
      categories: [],
      reasons: ["no detector produced a verdict"],
      ogrVersion: OGR_VERSION,
    }
  }

  if (strategy === "deny-wins") {
    const winner = mostSevere(verdicts)
    return merge(ev, winner.decision, verdicts, `deny-wins → ${winner.decision}`)
  }

  if (strategy === "quorum") {
    const q = rule.quorum ?? { count: 2, min_score: 0 }
    const minScore = q.min_score ?? 0
    const votes = verdicts.filter(
      (v) => v.decision !== "allow" && (v.categories.some((c) => c.score >= minScore) || v.categories.length === 0),
    )
    if (votes.length >= (q.count ?? 2)) {
      const winner = mostSevere(votes)
      return merge(ev, winner.decision, verdicts, `quorum ${votes.length}/${q.count} → ${winner.decision}`)
    }
    return merge(ev, "allow", verdicts, "quorum not reached → allow")
  }

  if (strategy === "first-available") {
    return merge(ev, verdicts[0]!.decision, verdicts, "first-available")
  }

  const winner = mostSevere(verdicts)
  return merge(ev, winner.decision, verdicts, `default most_severe → ${winner.decision}`)
}

/** Pick the composition rule whose category prefix best matches the findings. */
export function selectRule(verdicts: Verdict[], composition: Composition): CompositionRule {
  const flagged = new Set<string>()
  for (const v of verdicts) for (const c of v.categories) flagged.add(c.id)

  let best: CompositionRule = composition["default"] ?? { strategy: "deny-wins" }
  let bestLen = -1
  for (const [prefix, rule] of Object.entries(composition)) {
    if (prefix === "default" || prefix === "conflict_default") continue
    const base = prefix.replace(/\*+$/, "").replace(/\.+$/, "")
    const matches = [...flagged].some((cid) => cid === base || cid.startsWith(base + ".") || base === "")
    if (matches && base.length > bestLen) {
      best = rule
      bestLen = base.length
    }
  }
  return best
}
