/**
 * The OGR v0.8 wire, hand-rolled.
 *
 * There is no SDK layer — the Runtime API is the integration surface
 * (specification/runtime-api.md), and since v0.8 an integration is an API
 * key, nine fields, and ONE decision endpoint. This module is that POST plus
 * the optional heartbeat and the wire types this plugin reads and writes,
 * nothing else: no signing, no batching, no client-side decomposition, and
 * no `/v1/ingest` (removed in v0.8 — evaluate records every event it
 * judges).
 *
 * The base URL is joined with the canonical `/v1/...` paths exactly as the
 * binding requires — a deployment-specific prefix belongs IN the configured
 * base URL (`https://host/api/public/ogr`), never hard-coded here.
 */

/**
 * One v0.8 GuardEvent exactly as the schema requires: every field present,
 * none optional, no extras (`additionalProperties: false`). The four-tuple
 * is required WITH the empty string as the explicit "no assertion" — the
 * integrator answers the identity question; nobody falls into the API-key
 * floor by omission. What v0.6/v0.7 carried and v0.8 removed — versions,
 * coordinates, timestamps, the build id — is derived server-side or lives
 * on the heartbeat, and MUST NOT be sent.
 */
/**
 * WHO REPORTED IT — `"name/version"`, on every event AND on the heartbeat.
 * One constant so the two can never name different builds.
 */
export const INTEGRATION = "ogr-opencode-auto-mode/0.3.0"

export interface WireEvent {
  kind: "step/request" | "step/response"
  /** Fresh per model call, pairing its two halves; the ONE coordinate kept. */
  step_id: string
  agent_id: string
  agent_type: string
  agent_workspace: string
  /**
   * ⚠️ There is no `agent_owner` (removed 2026-08-17). Who is ACCOUNTABLE for an
   * agent is not something a producer can assert — it is a link to a console
   * account an administrator assigns, and a read permission cannot rest on a
   * claim the caller makes about itself.
   */
  agent_user: string
  llm_protocol: "openai.chat" | "openai.responses" | "anthropic.messages" | "canonical"
  payload: Record<string, unknown>
  /**
   * WHO REPORTED IT — `"name/version"`. The one OPTIONAL field on the v0.8
   * wire, stamped by {@link OgrClient.evaluate} so it cannot be forgotten at a
   * construction site.
   *
   * ⚠️ It rode the heartbeat ALONE until 2026-08-17, and that could not answer
   * "which build produced this traffic": a runtime keys its liveness record on
   * the integration NAME (it must, so a rollout updates its row instead of
   * minting a second and reporting the old build as dark), so every replica
   * overwrites the others' version. On the event the build travels with the
   * traffic it produced and nothing can overwrite it.
   */
  integration?: string
}

/** One tool call as a canonical step/response payload carries it. */
export interface WireToolCall {
  id: string
  name: string
  arguments: unknown
}

/** One v0.8 finding — what was found, where, and what it contributed. */
export interface WireFinding {
  category: string
  severity?: "low" | "medium" | "high" | "critical"
  action?: "flag" | "redact" | "block"
  path?: string
  start?: number
  end?: number
  score?: number
  detector?: string
  fp?: string
  whitelisted?: boolean
  subject?: string
}

/** The v0.8 Verdict: two decisions, findings, spans, and the coverage truth. */
export interface WireVerdict {
  event_id: string
  provider: string
  decision: "allow" | "block"
  findings?: WireFinding[]
  modifications?: { spans?: Array<{ path: string; start: number; end: number; replacement: string }> }
  /**
   * Payload paths this verdict could NOT judge. Absent/empty asserts every
   * routed text was judged; under `failMode: "closed"` a non-empty value is
   * "could not look", which is not "found nothing".
   */
  unjudged?: string[]
  latency_ms?: number
}

/** Log sink; the plugin supplies its own so wire noise stays in the host's log. */
export interface WireLog {
  info(message: string): void
  warn(message: string): void
}

/** One resolved runtime connection: where, and as whom. */
export interface RuntimeSource {
  url: string
  apiKey: string
}

/**
 * A fresh `step_id`: a local variable in the loop, never session state.
 * Random per event — this plugin's vantage yields single-event steps, so no
 * id is ever reused across events (the spec's one hard rule for it).
 */
export function mintStepId(): string {
  return globalThis.crypto.randomUUID().replaceAll("-", "")
}

/**
 * The one-POST client (plus the optional heartbeat). The source is a THUNK,
 * re-read on every call, so a connection configured after registration takes
 * effect without a restart.
 */
export class OgrClient {
  /** Heartbeat counters — how an outage-induced observability gap stays visible. */
  eventsSent = 0
  evaluateErrors = 0

  constructor(
    private readonly log: WireLog,
    private readonly source: () => RuntimeSource | null,
    private readonly timeoutMs: () => number,
  ) {}

  /** Whether a runtime is configured RIGHT NOW (the source is live). */
  get enabled(): boolean {
    return this.source() !== null
  }

  private async post(path: string, body: unknown): Promise<Response | null> {
    const src = this.source()
    if (!src) return null
    const base = src.url.endsWith("/") ? src.url.slice(0, -1) : src.url
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs())
    try {
      return await fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${src.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Judge ONE event and return its Verdict, or `null` when no runtime is
   * configured or the call failed (timeout, 429, 5xx, network). Deciding what
   * a missing verdict means is the CALLER's job — that is the deployment's
   * `failMode`, and the degraded-mode spec is explicit that a 429 is an
   * outage, not an allow.
   */
  async evaluate(event: WireEvent): Promise<WireVerdict | null> {
    try {
      // Stamped HERE, not at each construction site: one send path means the
      // build id cannot go missing on one kind of event only.
      const res = await this.post("/v1/evaluate", { ...event, integration: INTEGRATION })
      if (!res) return null
      if (!res.ok) {
        this.evaluateErrors += 1
        this.log.warn(`[openguardrails] evaluate answered ${res.status} — no verdict`)
        return null
      }
      this.eventsSent += 1
      return (await res.json()) as WireVerdict
    } catch (err) {
      this.evaluateErrors += 1
      this.log.warn(`[openguardrails] evaluate failed (${String(err)}) — no verdict`)
      return null
    }
  }

  /**
   * Integration liveness, fire-and-forget: the heartbeat is where the build
   * id lives in v0.8 (it left the event), and its counters are how the
   * runtime tells "agent idle" from "integration went dark". A failed beat
   * is a lost signal, never a lost enforcement.
   */
  async heartbeat(integration: string, agentId: string, intervalS: number): Promise<void> {
    try {
      const res = await this.post("/v1/heartbeat", {
        integration,
        ...agentId ? { agent_id: agentId } : {},
        interval_s: intervalS,
        counters: { events_sent: this.eventsSent, evaluate_errors: this.evaluateErrors },
      })
      if (res && !res.ok) this.log.warn(`[openguardrails] heartbeat answered ${res.status}`)
    } catch (err) {
      this.log.warn(`[openguardrails] heartbeat failed (${String(err)})`)
    }
  }
}
