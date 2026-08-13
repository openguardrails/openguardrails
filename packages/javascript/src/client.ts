/**
 * RuntimeClient — the SDK layer over the OGR Runtime HTTP API.
 *
 * The Runtime exposes `POST /v1/evaluate`, `POST /v1/ingest`, `POST /v1/enroll`,
 * `POST /v1/heartbeat`, `GET /v1/config` and `GET /v1/approvals`; this client
 * wraps them so integrations stop hand-rolling their own fetch code. It is the
 * single canonical home of the camelCase↔snake_case wire mapping
 * (`eventToWire` / `verdictFromWire`).
 *
 * Runs on the global `fetch` (Node >= 18, or any WASM/edge runtime that
 * provides it). Zero dependencies, no Node built-ins — optional Ed25519
 * request signing lives in `node-signer.ts` behind a lazy `node:crypto`
 * import.
 */
import { type GuardEvent, type Verdict, OGR_VERSION } from "./models.js"

/**
 * Produces the detached-JWS `ogr-batch-signature` header value for a request
 * body, or null when signing is unavailable. See `createNodeSigner` for the
 * Node implementation of the scheme the runtime verifies.
 */
export interface Signer {
  sign(body: Uint8Array): string | null
}

export interface RuntimeClientOptions {
  /**
   * Runtime base URL, default `$OGR_RUNTIME_URL`. The client appends the
   * canonical `/v1/...` API paths to it, so a deployment that mounts the
   * Runtime API behind a prefix passes the prefix here — e.g.
   * `https://host/api/public/ogr` yields
   * `POST https://host/api/public/ogr/v1/evaluate`.
   */
  baseUrl?: string
  /** Workspace API key (`ogr_...`), default `$OGR_API_KEY`. Sent as `Authorization: Bearer`. */
  apiKey?: string
  /** Per-request timeout in milliseconds (AbortController), default 10000. */
  timeoutMs?: number
  /** Optional signer: adds `ogr-batch-signature` to /evaluate and /ingest bodies. */
  signer?: Signer
}

export interface EvaluateOptions {
  /** Send the `ogr-partial: 1` header (the event carries partial content). */
  partial?: boolean
}

/** Options for the one-call developer path (guardRequest / guardResponse). */
export interface GuardCallOptions extends EvaluateOptions {
  /** Protocol hint; the runtime also sniffs the body shape. */
  llmProtocol?: string
  sessionId?: string
  /** Identity refinement; absent, the API key's default agent. */
  agentId?: string
}

export interface EnrollRequest {
  /** base64url raw 32-byte Ed25519 public key. */
  publicKey: string
  /** Stable id of the ENROLLING SENSOR — unrelated to the per-action guard_id on events. */
  pepId?: string
  name?: string
}

export interface EnrollResponse {
  pepId: string
  keyId: string
}

/** One per-event outcome from the always-207 /ingest response. */
export interface IngestResult {
  id: string
  status: number
  error?: string
}

export type ApprovalState = "pending" | "approved" | "denied" | "expired"

export interface ApprovalStatus {
  status: ApprovalState
}

/** A non-2xx HTTP response from the Runtime API. */
export class RuntimeApiError extends Error {
  /** The `error` code from the JSON body when present, e.g. `unauthorized`, `invalid_event`. */
  readonly code?: string

  constructor(
    readonly status: number,
    readonly body: unknown,
    message?: string,
  ) {
    const code =
      body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : undefined
    super(message ?? `OGR runtime returned HTTP ${status}${code ? ` (${code})` : ""}`)
    this.name = "RuntimeApiError"
    this.code = code
  }
}

/** HTTP 429 `{"error":"rate_limited","limit":n}`. */
export class RateLimitedError extends RuntimeApiError {
  readonly limit?: number

  constructor(status: number, body: unknown) {
    super(status, body)
    this.name = "RateLimitedError"
    const limit = (body as { limit?: unknown } | null)?.limit
    if (typeof limit === "number") this.limit = limit
  }
}

/** /ingest hard cap per request. */
export const INGEST_BATCH_MAX = 100

/**
 * Deployment-compat mount. The spec roots the API at `/v1/...` relative to the
 * configured base URL, but deployed reference runtimes historically mount the
 * handlers only under `/api/public/ogr`. When a canonical path 404s at the
 * route level the client probes this prefix once and caches the answer.
 */
const COMPAT_MOUNT = "/api/public/ogr"

const EVENT_FIELDS = new Set([
  "kind",
  "observationPoint",
  "agentId",
  "agentType",
  "agentWorkspace",
  "agentOwner",
  "agentUser",
  "sandboxId",
  "parentAgentId",
  "delegationChain",
  "attestation",
  "sensorId",
  "sensorType",
  "sensorVersion",
  "payload",
  "eventId",
  "guardId",
  "timestamp",
  "sessionId",
  "llmProtocol",
  "provenance",
  "ogrVersion",
])

/**
 * JS-core camelCase GuardEvent → OGR wire object (snake_case, empty optionals
 * dropped). Extension fields set directly on the event — `run_id`, `turn`,
 * `authz`, `x.ogr.*`, ... — pass through verbatim.
 */
export function eventToWire(ev: GuardEvent): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    ogr_version: ev.ogrVersion ?? OGR_VERSION,
    kind: ev.kind,
    payload: ev.payload,
  }
  // OGR v0.6: event identity is born at the runtime and returned on the
  // response — a locally minted eventId never goes on the wire. guard_id
  // does, but only as an explicit correlation hint. Identity fields are FLAT
  // scalars (the agent_/sensor_ prefixes are the namespace); a key-only
  // caller sends none and the runtime derives the agent from the API key.
  if (ev.guardId) wire.guard_id = ev.guardId
  if (ev.timestamp) wire.timestamp = ev.timestamp
  if (ev.observationPoint) wire.observation_point = ev.observationPoint
  if (ev.agentId) wire.agent_id = ev.agentId
  if (ev.agentType) wire.agent_type = ev.agentType
  if (ev.agentWorkspace) wire.agent_workspace = ev.agentWorkspace
  if (ev.agentOwner) wire.agent_owner = ev.agentOwner
  if (ev.agentUser) wire.agent_user = ev.agentUser
  if (ev.sandboxId) wire.sandbox_id = ev.sandboxId
  if (ev.parentAgentId) wire.parent_agent_id = ev.parentAgentId
  if (ev.delegationChain?.length) wire.delegation_chain = ev.delegationChain
  if (ev.attestation) wire.attestation = ev.attestation
  if (ev.sensorId) wire.sensor_id = ev.sensorId
  if (ev.sensorType) wire.sensor_type = ev.sensorType
  if (ev.sensorVersion) wire.sensor_version = ev.sensorVersion
  if (ev.sessionId) wire.session_id = ev.sessionId
  if (ev.llmProtocol) wire.llm_protocol = ev.llmProtocol
  if (ev.provenance?.length) {
    wire.provenance = ev.provenance.map((p) => ({
      source: p.source,
      trust: p.trust,
      ...(p.ref ? { ref: p.ref } : {}),
      ...(p.taintTags?.length ? { taint_tags: p.taintTags } : {}),
    }))
  }
  for (const [key, value] of Object.entries(ev)) {
    if (!EVENT_FIELDS.has(key) && value !== undefined) wire[key] = value
  }
  return wire
}

const VERDICT_FIELDS = new Set([
  "ogr_version",
  "event_id",
  "guard_id",
  "provider",
  "decision",
  "categories",
  "reasons",
  "latency_ms",
])

/**
 * OGR wire verdict (snake_case) → JS-core camelCase Verdict. Extension keys —
 * `x.ogr.session_id`, `modifications`, `findings`, ... — pass through
 * verbatim.
 */
export function verdictFromWire(wire: Record<string, unknown>): Verdict {
  const verdict: Record<string, unknown> = {
    eventId: wire.event_id,
    guardId: wire.guard_id,
    provider: wire.provider,
    decision: wire.decision,
    categories: wire.categories ?? [],
    reasons: wire.reasons ?? [],
  }
  if (wire.latency_ms !== undefined) verdict.latencyMs = wire.latency_ms
  if (wire.ogr_version !== undefined) verdict.ogrVersion = wire.ogr_version
  for (const [key, value] of Object.entries(wire)) {
    if (!VERDICT_FIELDS.has(key)) verdict[key] = value
  }
  return verdict as unknown as Verdict
}

function env(name: string): string {
  return (typeof process !== "undefined" && process.env?.[name]) || ""
}

/**
 * HTTP client for the OGR Runtime API.
 *
 * ```ts
 * const client = new RuntimeClient({ baseUrl: "https://host/api/public/ogr", apiKey: "ogr_..." })
 * const verdict = await client.evaluate(event)
 * ```
 *
 * `baseUrl` / `apiKey` default to `$OGR_RUNTIME_URL` / `$OGR_API_KEY`; the
 * canonical `/v1/...` paths are appended to `baseUrl` (see
 * {@link RuntimeClientOptions.baseUrl}).
 */
export class RuntimeClient {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly timeoutMs: number
  private readonly signer?: Signer
  /** Discovered mount prefix ("" = canonical). Cached after one successful probe. */
  private mount = ""

  constructor(options: RuntimeClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? env("OGR_RUNTIME_URL")).replace(/\/+$/, "")
    this.apiKey = options.apiKey ?? env("OGR_API_KEY")
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.signer = options.signer
    if (!this.baseUrl) throw new Error("RuntimeClient: baseUrl is required (or set OGR_RUNTIME_URL)")
    if (!this.apiKey) throw new Error("RuntimeClient: apiKey is required (or set OGR_API_KEY)")
  }

  /** Evaluate ONE GuardEvent: `POST /v1/evaluate` → the composed Verdict. */
  async evaluate(event: GuardEvent, options: EvaluateOptions = {}): Promise<Verdict> {
    const headers: Record<string, string> = {}
    if (options.partial) headers["ogr-partial"] = "1"
    const wire = await this.request("POST", "/v1/evaluate", {
      body: eventToWire(event),
      headers,
      sign: true,
    })
    return verdictFromWire(wire as Record<string, unknown>)
  }

  /**
   * The developer path in one call: forward the UNTOUCHED provider request
   * body BEFORE it goes to the model. The runtime classifies it (new user
   * words, fed-back tool outcomes, tool definitions) and answers with the
   * composed Verdict.
   *
   * ```ts
   * const verdict = await client.guardRequest(chatCompletionsBody)
   * if (verdict.decision === "block") refuse(verdict.reasons)
   * ```
   */
  async guardRequest(
    body: Record<string, unknown>,
    options: GuardCallOptions = {},
  ): Promise<Verdict> {
    return this.evaluate(
      {
        kind: "llm_request",
        payload: body,
        llmProtocol: options.llmProtocol,
        sessionId: options.sessionId,
        agentId: options.agentId,
        provenance: [],
      },
      options,
    )
  }

  /**
   * The other half: forward the UNTOUCHED provider response AFTER the model
   * answers and BEFORE the agent acts on it.
   */
  async guardResponse(
    body: Record<string, unknown>,
    options: GuardCallOptions = {},
  ): Promise<Verdict> {
    return this.evaluate(
      {
        kind: "llm_response",
        payload: body,
        llmProtocol: options.llmProtocol,
        sessionId: options.sessionId,
        agentId: options.agentId,
        provenance: [],
      },
      options,
    )
  }

  /**
   * Report a batch of GuardEvents: `POST /v1/ingest` with `{"batch": [...]}`
   * (at most {@link INGEST_BATCH_MAX}). The response is always HTTP 207 with
   * one result per event; per-event failures come back as results, not
   * exceptions.
   */
  async ingest(events: GuardEvent[]): Promise<IngestResult[]> {
    if (events.length > INGEST_BATCH_MAX) {
      throw new RangeError(`ingest batch of ${events.length} exceeds the maximum of ${INGEST_BATCH_MAX}`)
    }
    const wire = await this.request("POST", "/v1/ingest", {
      body: { batch: events.map(eventToWire) },
      sign: true,
    })
    return ((wire as { results?: IngestResult[] }).results ?? []) as IngestResult[]
  }

  /** Enroll an Ed25519 public key: `POST /v1/enroll` → `{pepId, keyId}`. */
  async enroll(request: EnrollRequest): Promise<EnrollResponse> {
    const body: Record<string, unknown> = { public_key: request.publicKey }
    if (request.pepId) body.pep_id = request.pepId
    if (request.name) body.name = request.name
    const wire = (await this.request("POST", "/v1/enroll", { body })) as {
      pep_id: string
      key_id: string
    }
    return { pepId: wire.pep_id, keyId: wire.key_id }
  }

  /** Liveness ping: `POST /v1/heartbeat` → `{ok: true}`. */
  async heartbeat(extra: Record<string, unknown> = {}): Promise<{ ok: boolean }> {
    return (await this.request("POST", "/v1/heartbeat", { body: extra })) as { ok: boolean }
  }

  /** Poll a pending approval: `GET /v1/approvals?guard_id=...`. */
  async getApproval(guardId: string): Promise<ApprovalStatus> {
    const query = `?guard_id=${encodeURIComponent(guardId)}`
    return (await this.request("GET", `/v1/approvals${query}`)) as ApprovalStatus
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    options: { body?: unknown; headers?: Record<string, string>; sign?: boolean } = {},
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      ...options.headers,
    }
    let body: string | undefined
    if (options.body !== undefined) {
      body = JSON.stringify(options.body)
      headers["content-type"] = "application/json"
      if (options.sign && this.signer) {
        const signature = this.signer.sign(new TextEncoder().encode(body))
        if (signature) headers["ogr-batch-signature"] = signature
      }
    }

    let attempt = await this.send(method, `${this.baseUrl}${this.mount}${path}`, headers, body)

    // Mount-compat fallback: a 404 on a canonical path can be a route-level
    // miss on a deployment that mounts the API only under COMPAT_MOUNT. Probe
    // the compat prefix once and cache it. Careful: GET /v1/approvals uses a
    // JSON 404 ({"status": "not_found"}) as a real API answer — for that path
    // only a non-API-shaped 404 (no `status` key) triggers the probe.
    if (
      attempt.res.status === 404 &&
      this.mount === "" &&
      !this.baseUrl.endsWith(COMPAT_MOUNT) &&
      (!path.startsWith("/v1/approvals") || !hasKey(attempt.json, "status"))
    ) {
      const retry = await this.send(method, `${this.baseUrl}${COMPAT_MOUNT}${path}`, headers, body)
      if (retry.res.status !== 404) {
        this.mount = COMPAT_MOUNT
        attempt = retry
      }
    }

    const { res, json, text } = attempt
    // /ingest's always-207 is a success shape, not an error.
    if (!res.ok && res.status !== 207) {
      if (res.status === 429) throw new RateLimitedError(res.status, json)
      throw new RuntimeApiError(res.status, json ?? text)
    }
    return json
  }

  private async send(
    method: "GET" | "POST",
    url: string,
    headers: Record<string, string>,
    body: string | undefined,
  ): Promise<{ res: Response; json: unknown; text: string }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    ;(timer as { unref?: () => void }).unref?.()
    let res: Response
    try {
      res = await fetch(url, { method, headers, body, signal: controller.signal })
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`OGR runtime request timed out after ${this.timeoutMs}ms (${method} ${url})`)
      }
      throw err
    } finally {
      clearTimeout(timer)
    }

    const text = await res.text()
    let json: unknown = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      /* non-JSON body: kept as null, raw text goes into the error message */
    }
    return { res, json, text }
  }
}

function hasKey(value: unknown, key: string): boolean {
  return typeof value === "object" && value !== null && key in value
}
