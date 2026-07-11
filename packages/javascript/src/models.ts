/**
 * OGR v0.1 wire types — GuardEvent, Verdict, Provenance, Category.
 *
 * The TypeScript port of the OpenGuardrails spec types — the SAME contract the
 * Python `openguardrails` package implements. Zero dependencies.
 */

export const OGR_VERSION = "0.1"

/** Decision severity order, most severe first (spec: composition.md). */
export const DECISIONS = ["block", "require_approval", "redact", "modify", "allow"] as const
export type Decision = (typeof DECISIONS)[number]

/** Lower index == more severe. Unknown decisions sort as most severe (-1). */
export function severity(decision: string): number {
  return (DECISIONS as readonly string[]).indexOf(decision)
}

export type Trust = "trusted" | "untrusted" | "unverified"

export interface Provenance {
  /** system | user | model | tool_result | web | mcp | file | retrieved */
  source: string
  trust: Trust
  ref?: string
  taintTags?: string[]
}

export interface GuardEvent {
  kind: string // tool_call | exec | tool_result | model_output | network | ...
  observationPoint: string // gateway | agent_hook | sandbox
  subject: Record<string, unknown>
  payload: Record<string, unknown>
  eventId: string
  guardId: string
  timestamp: string
  sessionId?: string
  llmProtocol?: string
  contextRefs?: string[]
  provenance: Provenance[]
  ogrVersion?: string
}

export interface Category {
  id: string
  domain: string // safety | security
  score: number
}

export interface Verdict {
  eventId: string
  guardId: string
  provider: string
  decision: Decision
  categories: Category[]
  reasons: string[]
  evidence?: Array<Record<string, unknown>>
  confidence?: number
  latencyMs?: number
  ogrVersion?: string
}

export function isUntrusted(ev: GuardEvent): boolean {
  return ev.provenance.some((p) => p.trust === "untrusted")
}

export function taintTags(ev: GuardEvent): Set<string> {
  const tags = new Set<string>()
  for (const p of ev.provenance) for (const t of p.taintTags ?? []) tags.add(t)
  return tags
}

/** Build an `allow` verdict for an event. */
export function allowVerdict(ev: GuardEvent, provider: string, reason = "no finding"): Verdict {
  return {
    eventId: ev.eventId,
    guardId: ev.guardId,
    provider,
    decision: "allow",
    categories: [],
    reasons: [reason],
    ogrVersion: OGR_VERSION,
  }
}
