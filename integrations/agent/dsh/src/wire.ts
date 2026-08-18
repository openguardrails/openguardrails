/**
 * The OGR v0.8 wire, hand-rolled.
 *
 * There is no SDK layer — the Runtime API is the integration surface
 * (specification/runtime-api.md), and since v0.8 an integration is ONE
 * decision endpoint: `/v1/evaluate` while holding an action (evaluate records
 * what it judges, so it is the observation channel too — `/v1/ingest` is
 * gone), plus the transport-level `/v1/heartbeat` that carries the
 * integration build id and the degraded-mode counters. This module is those
 * calls plus the wire types this plugin reads and writes, nothing else: no
 * signing, no batching machinery, no client-side decomposition.
 *
 * The base URL is joined with the canonical `/v1/...` paths exactly as the
 * binding requires — a deployment-specific prefix belongs IN the configured
 * base URL (`https://host/api/public/ogr`), never hard-coded here.
 */

/**
 * One v0.8 GuardEvent as this plugin sends it (snake_case, flat).
 *
 * Every field is REQUIRED — v0.8 removed every knob a producer could choose
 * to skip. What a runtime can derive is not on the wire at all (session,
 * turn, step numbering, timestamps, protocol versioning); what only the
 * producer can know is mandatory, with the empty string as the explicit
 * "I have nothing to assert" on the identity four-tuple. `step_id` is the
 * one coordinate kept: concurrency makes pairing a call's two halves
 * underivable, so the producer mints a fresh random id per model call and
 * puts the SAME value on both events.
 */
/**
 * WHO REPORTED IT — `"name/version"`, on every event AND on the heartbeat.
 * One constant so the two can never name different builds.
 */
export const INTEGRATION = "ogr-dsh/0.3.0"

export interface WireEvent {
  kind: "step/request" | "step/response"
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
  latency_ms?: number
  findings?: WireFinding[]
  modifications?: { spans?: Array<{ path: string; start: number; end: number; replacement: string }> }
  /**
   * Payload paths this verdict could NOT judge. Absent/empty asserts every
   * routed text was judged; under `fail_mode: closed` a non-empty value is
   * "could not look", which is not "found nothing".
   */
  unjudged?: string[]
}

/**
 * One `/v1/heartbeat` body. NOT a GuardEvent — transport-level liveness so
 * the runtime can tell "agent idle" from "integration went dark". The
 * integration build id lives here (it left the event in v0.8), and the
 * counters are how an outage-induced observability gap stays visible: v0.8
 * has no replay channel, so a raised `evaluate_errors` is the record that
 * steps went unjudged.
 */
export interface WireHeartbeat {
  integration: string
  agent_id?: string
  interval_s?: number
  counters?: Record<string, number>
}

/** Log sink; the plugin passes dsh's own logger so wire noise stays in the harness log. */
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
 * The evaluate client. The source is a THUNK, re-read on every call, so a
 * connection configured later — an API key pasted into the dsh Settings
 * form — takes effect without a restart.
 */
export class OgrClient {
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
   * `fail_mode` (default OPEN, specification/degraded-mode.md), and the spec
   * is explicit that a 429 is an outage, not an allow.
   */
  async evaluate(event: WireEvent): Promise<WireVerdict | null> {
    try {
      // Stamped HERE, not at each construction site: one send path means the
      // build id cannot go missing on one kind of event only.
      const res = await this.post("/v1/evaluate", { ...event, integration: INTEGRATION })
      if (!res) return null
      if (!res.ok) {
        this.log.warn(`[openguardrails] evaluate answered ${res.status} — no verdict`)
        return null
      }
      return (await res.json()) as WireVerdict
    } catch (err) {
      this.log.warn(`[openguardrails] evaluate failed (${String(err)}) — no verdict`)
      return null
    }
  }

  /**
   * Integration liveness, fire-and-forget: a lost heartbeat is a lost signal,
   * never a lost enforcement, so it warns and moves on. This is where the
   * build id and the degraded-mode counters travel.
   */
  async heartbeat(body: WireHeartbeat): Promise<void> {
    try {
      const res = await this.post("/v1/heartbeat", body)
      if (res && !res.ok) {
        this.log.warn(`[openguardrails] heartbeat answered ${res.status}`)
      }
    } catch (err) {
      this.log.warn(`[openguardrails] heartbeat failed (${String(err)})`)
    }
  }
}
