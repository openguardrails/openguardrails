/**
 * OGR wire types — GuardEvent, Verdict, Provenance, Category.
 *
 * The TypeScript port of the OpenGuardrails spec types — the SAME contract the
 * Python `openguardrails` package implements. Zero dependencies.
 */

export const OGR_VERSION = "0.6"

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

/** How strongly an identity claim was verified, weakest first. See specification/attestation.md. */
export type AttestationLevel =
  | "self_declared"
  | "inferred"
  | "network"
  | "mtls"
  | "gateway_api_key"
  | "client_key"

/**
 * Which agent is acting — the five-field agent identity plus actor lineage.
 * Keys are snake_case because the subject is passed to the wire verbatim.
 * A key-only caller omits the subject entirely; the runtime then derives the
 * agent from the API key (one key, one default agent) and attributes every
 * session to one user. See specification/guard-event.md#subject.
 */
export interface Subject {
  /** The acting agent, unique within the organization. Absent → derived from the API key. */
  agent_id?: string
  /** What kind of agent (`hermes`, `openclaw`, `claude-code.subagent`, `smartwork`). A label, not an identity. */
  agent_type?: string
  /** The workspace (named group of agents) this agent belongs to. Absent → the API key's workspace. */
  agent_workspace?: string
  /** The agent's builder or responsible party, e.g. `user:tom`. An attribute, never a policy boundary. */
  agent_owner?: string
  /** Who is using the agent in THIS session. Absent → every session is one user. */
  agent_user?: string
  sandbox_id?: string
  parent_agent_id?: string
  delegation_chain?: string[]
  /** How the PEP verified the identity fields; the runtime clamps it to the channel ceiling. */
  attestation?: AttestationLevel
}

/** How evadable an observer is, weakest first. See specification/guard-event.md#sensor. */
export type SensorClass = "in_process" | "wrapper" | "proxy" | "kernel"

export interface Sensor {
  /** Stable id of the reporting integration, e.g. `openguardrails-ebpf`. */
  id: string
  /** Absent means unknown — consumers MUST treat the sensor as bypassable. */
  class?: SensorClass
  version?: string
}

export interface GuardEvent {
  kind: string // tool_call | exec | tool_result | model_output | network | ...
  /** Absent = derived from `kind` by the runtime (transcript → conversation, actions → invocation, exec/network/file → execution). */
  observationPoint?: string // conversation | invocation | execution
  /** WHICH integration observed it — the mechanism axis, orthogonal to the altitude. */
  sensor?: Sensor
  /** Omitted only by a key-only caller; the runtime then derives the agent from the API key. */
  subject?: Subject
  payload: Record<string, unknown>
  /**
   * OGR v0.6: event identity is born at the runtime — never sent on the wire,
   * assigned locally by an in-process Runtime, returned on every Verdict.
   */
  eventId?: string
  /** Correlation hint across observation points; absent = the event itself. */
  guardId?: string
  /** Absent = the runtime's receive time. */
  timestamp?: string
  sessionId?: string
  llmProtocol?: string
  provenance: Provenance[]
  ogrVersion?: string
}

export interface Category {
  id: string
  domain: string // safety | security
  score: number
}

export interface Verdict {
  /** Runtime-assigned identity of the judged event — how the caller learns it. */
  eventId: string
  /** The event's guard group: propagated hint when one was sent, else runtime-assigned. */
  guardId: string
  provider: string
  decision: Decision
  categories: Category[]
  reasons: string[]
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

/**
 * A GuardEvent after the runtime assigned identity — what detectors and
 * composition receive. Client code builds plain GuardEvents (ids optional);
 * the Runtime resolves them before fanout.
 */
export type ResolvedGuardEvent = GuardEvent & { eventId: string; guardId: string }

/** Build an `allow` verdict for an event. */
export function allowVerdict(ev: ResolvedGuardEvent, provider: string, reason = "no finding"): Verdict {
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
