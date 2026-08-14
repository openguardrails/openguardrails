/**
 * The OGR v0.7 wire, hand-rolled.
 *
 * There is no SDK layer in v0.7 — the Runtime API is the integration surface
 * (specification/runtime-api.md), and an integration is two POSTs: `/v1/evaluate`
 * while holding an action, `/v1/ingest` for past facts. This module is those two
 * calls plus the wire types this plugin reads and writes, nothing else: no
 * signing (enrollment left the protocol in v0.7), no batching machinery, no
 * client-side decomposition.
 *
 * The base URL is joined with the canonical `/v1/...` paths exactly as the
 * binding requires — a deployment-specific prefix belongs IN the configured
 * base URL (`https://host/api/public/ogr`), never hard-coded here.
 */

/** One v0.7 GuardEvent as this plugin sends it (snake_case, flat). */
export interface WireEvent {
  ogr_version: "0.7"
  kind: "step/request" | "step/response" | "turn/end"
  session_id?: string
  turn?: number
  step?: number
  parent_session_id?: string
  timestamp: string
  agent_id?: string
  agent_type?: string
  agent_workspace?: string
  agent_owner?: string
  agent_user?: string
  integration: string
  llm_protocol?: "openai.chat" | "openai.responses" | "anthropic.messages"
  payload: Record<string, unknown>
}

/** One v0.7 finding — what was found, where, and what it contributed. */
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

/** The v0.7 Verdict: two decisions, findings, spans, and the coverage truth. */
export interface WireVerdict {
  ogr_version?: string
  event_id: string
  provider: string
  decision: "allow" | "block"
  session_id?: string
  turn?: number
  step?: number
  attribution?: "declared" | "derived"
  latency_ms?: number
  findings?: WireFinding[]
  modifications?: { spans?: Array<{ path: string; start: number; end: number; replacement: string }> }
  /**
   * Payload paths this verdict could NOT judge. Absent/empty asserts every
   * routed text was judged; under `fail_mode: closed` a non-empty value is
   * "could not look", which is not "found nothing".
   */
  unjudged?: string[]
  output_mode?: "buffer" | "stream"
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
 * The two-POST client. The source is a THUNK, re-read on every call, so a
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
   * `fail_mode`, and the degraded-mode spec is explicit that a 429 is an
   * outage, not an allow.
   */
  async evaluate(event: WireEvent): Promise<WireVerdict | null> {
    try {
      const res = await this.post("/v1/evaluate", event)
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
   * Record past facts (`turn/end` marks), fire-and-forget: a failed ingest is
   * a lost observation, never a lost enforcement, so it warns and moves on.
   */
  async ingest(events: WireEvent[]): Promise<void> {
    if (events.length === 0) return
    try {
      const res = await this.post("/v1/ingest", { batch: events })
      if (res && !res.ok) {
        this.log.warn(`[openguardrails] ingest answered ${res.status}`)
      }
    } catch (err) {
      this.log.warn(`[openguardrails] ingest failed (${String(err)})`)
    }
  }
}
