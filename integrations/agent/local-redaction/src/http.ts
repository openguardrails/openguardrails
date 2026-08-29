/**
 * The HTTP interceptor: masking at the layer every harness shares.
 *
 * Harness plugin hooks differ and have holes — one cannot rewrite the
 * outbound request, another's messages hook is experimental, none of them
 * sees the system prompt. What they all share is the process's HTTP client,
 * so that is where the mask goes: IN-PROCESS, installed by the plugin the
 * user already has, no proxy and no `base_url` change. Every outbound model
 * request is masked whole — system prompt, every message, every tool
 * result, every tool definition — and every reply is restored INSIDE
 * TOOL-CALL ARGUMENTS only (D7).
 *
 * Two halves, one core:
 *
 *  - `globalThis.fetch` is wrapped. This is what the OpenAI, Anthropic and
 *    Vercel AI SDKs call.
 *  - When `undici` is resolvable from the host, its global dispatcher is
 *    composed with an interceptor too, so an SDK holding its own `undici`
 *    client — or a `fetch` reference captured before this plugin loaded —
 *    is still covered. Best-effort: absent, it is reported absent.
 *
 * What the interceptor never does: hold a provider key (the harness's own
 * `Authorization` passes through untouched), restore into prose, or claim
 * coverage it cannot prove — `sawTraffic` is set by the first model call
 * that actually passed through, and a plugin whose tool hook fires before
 * that must not report the step as protected. Never let "looks protected"
 * and "is protected" look alike.
 *
 * The session key is a TRADE-OFF, stated: a request carries no host session
 * id, so the map is keyed by the session the harness STAMPED on the request
 * (`user` / `metadata.user_id`) when it did, and by one per-process default
 * otherwise. Under the default every conversation in the process shares one
 * map — a value is masked identically everywhere, and a token minted in one
 * conversation restores into a tool call of another. For a single-user
 * harness that is exactly one session; for a multi-session gateway it is a
 * widening the operator should know about, which is why the status names
 * the keys in use.
 */
import type { Minted } from "./mask.js"
import { isModelHost, restoreResponseBody, sniffProtocol, stampedSession, type ModelProtocol } from "./protocol.js"
import type { LocalRedactor, RedactorLog } from "./redactor.js"
import { createSseRestorer } from "./sse.js"

/** The per-process session the map is keyed by when the harness stamped none. */
export const DEFAULT_SESSION_KEY = "process"

export interface HttpInterceptorOptions {
  redactor: LocalRedactor
  /**
   * Replaces the default matcher (known hostnames, else a body that sniffs
   * as a model call). Return true to treat the request as a model call; the
   * body is the parsed JSON, or null when it did not parse.
   */
  matches?: (url: URL, body: unknown) => boolean
  /** Extra hostnames for the default matcher (a self-hosted gateway, a proxy). */
  hosts?: readonly string[]
  /** Overrides the session key derivation (default: the stamped `user`, else {@link DEFAULT_SESSION_KEY}). */
  sessionKey?: (req: { url: URL; body: unknown; headers: Headers }) => string
  /** Called ONCE, the first time a tool call is reported before any traffic was intercepted. */
  onMiss?: () => void
  /** When no ruleset is in hand: `proceed` (mask known values, warn) or `refuse` (throw) — the caller's fail mode. */
  unprotected?: "proceed" | "refuse"
  log?: RedactorLog
  /** The underlying fetch (default: `globalThis.fetch` at install time). */
  fetch?: typeof fetch
  /** Replace `globalThis.fetch` with the wrapper (default true). */
  installFetch?: boolean
  /** Try the undici dispatcher half (default true). */
  undici?: boolean
}

export interface InterceptorStatus {
  installed: boolean
  /** Whether `globalThis.fetch` is currently this interceptor's wrapper. */
  fetch: "wrapped" | "unwrapped"
  undici: "pending" | "installed" | "unavailable" | "failed" | "off"
  /** Set by the first model call that passed through — the only proof of coverage there is. */
  sawTraffic: boolean
  /** Model requests masked and forwarded. */
  requests: number
  /** Of which, streamed replies. */
  streams: number
  /** Replies in which a tool-call argument was restored. */
  restored: number
  /** Requests that matched a model host but could not be handled (no readable JSON body, a compressed reply). */
  skipped: number
  /** Tokens minted by the interceptor, in total. */
  minted: number
  /** Placeholder-shaped tokens left in tool-call arguments because no map entry answered them (most recent last, bounded). */
  unrestorable: string[]
  /** Session keys the interceptor has masked under, most recent first. */
  sessions: string[]
}

export interface HttpInterceptorHandle {
  /** The wrapping fetch — usable directly, whether or not it was installed on `globalThis`. */
  fetch: typeof fetch
  readonly sawTraffic: boolean
  status(): InterceptorStatus
  sessions(): string[]
  /**
   * The self-check: a plugin calls this from its tool hook. Returns whether
   * any model traffic has been intercepted; the first `false` fires `onMiss`
   * (default: one warning) — model traffic is not passing through, nothing
   * is masked, and the step must not be reported as protected.
   */
  noteToolCall(): boolean
  /** Resolves when the undici half has settled (installed, unavailable or failed). */
  ready: Promise<void>
  uninstall(): void
}

/** Thrown by the wrapper under `unprotected: "refuse"` when no ruleset is in hand. */
export class UnprotectedRequestError extends Error {
  constructor() {
    super("[OpenGuardrails] no local-redaction ruleset could be obtained and the deployment is fail-closed")
    this.name = "UnprotectedRequestError"
  }
}

const MAX_SESSIONS = 64
const MAX_UNRESTORABLE = 32

let current: Handle | null = null

/** The status of the interceptor most recently installed in this process. */
export function interceptorStatus(): InterceptorStatus {
  return current ? current.status() : idleStatus()
}

/** Remove the interceptor most recently installed in this process, if any. */
export function uninstallHttpInterceptor(): void {
  current?.uninstall()
}

function idleStatus(): InterceptorStatus {
  return {
    installed: false,
    fetch: "unwrapped",
    undici: "off",
    sawTraffic: false,
    requests: 0,
    streams: 0,
    restored: 0,
    skipped: 0,
    minted: 0,
    unrestorable: [],
    sessions: [],
  }
}

// ---- the core, shared by both halves ------------------------------------------

/** What the outbound pass decided for one request. */
interface Outbound {
  protocol: ModelProtocol
  session: string
  body: string
  changed: boolean
  minted: Minted[]
}

class Core {
  readonly counters = { requests: 0, streams: 0, restored: 0, skipped: 0, minted: 0 }
  readonly unrestorable: string[] = []
  private readonly sessionKeys = new Map<string, true>()
  /**
   * The bodies the fetch half is dispatching right now. The undici half sits
   * under it on the same global dispatcher, so a request the fetch wrapper
   * already masked arrives there a second time; it is recognised by its
   * content and passed straight through. Nothing rides the request for this.
   */
  readonly inFlight = new Set<string>()
  sawTraffic = false
  private warnedMiss = false

  constructor(readonly opts: HttpInterceptorOptions) {}

  get redactor(): LocalRedactor {
    return this.opts.redactor
  }
  get log(): RedactorLog {
    return this.opts.log ?? { info: () => {}, warn: (m) => console.warn(m) }
  }

  isModel(url: URL, body: unknown): ModelProtocol | null {
    const matched = this.opts.matches ? this.opts.matches(url, body) : isModelHost(url.hostname, this.opts.hosts) || sniffProtocol(body, url) !== null
    return matched ? sniffProtocol(body, url) : null
  }

  noteSession(key: string): void {
    this.sessionKeys.delete(key)
    this.sessionKeys.set(key, true)
    if (this.sessionKeys.size > MAX_SESSIONS) {
      const oldest = this.sessionKeys.keys().next()
      if (!oldest.done) this.sessionKeys.delete(oldest.value)
    }
  }
  sessions(): string[] {
    return [...this.sessionKeys.keys()].reverse()
  }
  noteUnrestorable(tokens: string[]): void {
    for (const t of tokens) {
      const at = this.unrestorable.indexOf(t)
      if (at !== -1) this.unrestorable.splice(at, 1)
      this.unrestorable.push(t)
    }
    while (this.unrestorable.length > MAX_UNRESTORABLE) this.unrestorable.shift()
  }

  /**
   * The request side. `text` is the JSON body; null answers "not a model
   * call, forward as is". Throws {@link UnprotectedRequestError} under
   * `unprotected: "refuse"` when no ruleset is in hand.
   */
  outbound(url: URL, headers: Headers, text: string): Outbound | null {
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      return null
    }
    const protocol = this.isModel(url, body)
    if (!protocol) return null
    const redactor = this.redactor
    if (!redactor.ready) {
      if (this.opts.unprotected === "refuse") throw new UnprotectedRequestError()
      redactor.warnUnprotected("this model request")
    }
    const session = this.opts.sessionKey ? this.opts.sessionKey({ url, body, headers }) : (stampedSession(body) ?? DEFAULT_SESSION_KEY)
    this.noteSession(session)
    const masked = redactor.maskValue(session, body)
    this.sawTraffic = true
    this.counters.requests += 1
    this.counters.minted += masked.minted.length
    return {
      protocol,
      session,
      body: masked.changed ? JSON.stringify(masked.value) : text,
      changed: masked.changed,
      minted: masked.minted,
    }
  }

  restoreJson(protocol: ModelProtocol, session: string, text: string): string {
    const r = restoreResponseBody(protocol, text, this.redactor.session(session))
    if (!r) return text
    if (r.unresolved.length) this.noteUnrestorable(r.unresolved)
    if (r.changed) this.counters.restored += 1
    return r.body
  }

  sseRestorer(protocol: ModelProtocol, session: string): { feed(chunk: string): string; end(): string } {
    this.counters.streams += 1
    let restored = false
    const inner = createSseRestorer(protocol, this.redactor.session(session), {
      onUnresolved: (tokens) => this.noteUnrestorable(tokens),
    })
    const count = (before: string, after: string): string => {
      if (!restored && before !== after) {
        restored = true
        this.counters.restored += 1
      }
      return after
    }
    return { feed: (chunk) => count(chunk, inner.feed(chunk)), end: () => inner.end() }
  }

  noteToolCall(): boolean {
    if (!this.sawTraffic && !this.warnedMiss) {
      this.warnedMiss = true
      if (this.opts.onMiss) this.opts.onMiss()
      else this.log.warn("[openguardrails] local redaction: model traffic is not passing through the interceptor — nothing is masked")
    }
    return this.sawTraffic
  }
}

// ---- the fetch half -----------------------------------------------------------

const isRequest = (x: unknown): x is Request => typeof Request !== "undefined" && x instanceof Request

/** The request body as text, or null when it is not something a model call carries. */
async function bodyText(body: unknown): Promise<string | null> {
  if (body === null || body === undefined) return null
  if (typeof body === "string") return body
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body)
  if (ArrayBuffer.isView(body)) return new TextDecoder().decode(body as Uint8Array)
  if (typeof Blob !== "undefined" && body instanceof Blob) return body.text()
  if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) return new Response(body).text()
  return null // URLSearchParams, FormData: never a model call
}

function jsonLike(contentType: string | null): boolean {
  return contentType === null || /json/i.test(contentType)
}

/** Copy a Response's identity onto a rebuilt one, as far as the platform allows. */
function relabel(next: Response, from: Response): Response {
  for (const key of ["url", "redirected", "type"] as const) {
    try {
      Object.defineProperty(next, key, { value: from[key], configurable: true })
    } catch {
      // read-only on this platform: the rebuilt response keeps its own
    }
  }
  return next
}

function wrapFetch(core: Core, underlying: typeof fetch): typeof fetch {
  return async function ogrFetch(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
    const method = (init?.method ?? (isRequest(input) ? input.method : "GET")).toUpperCase()
    if (method !== "POST") return underlying(input, init)
    let url: URL
    try {
      url = new URL(isRequest(input) ? input.url : String(input))
    } catch {
      return underlying(input, init)
    }
    const headers =
      init?.headers !== undefined ? new Headers(init.headers) : isRequest(input) ? new Headers(input.headers) : new Headers()
    if (!jsonLike(headers.get("content-type"))) return underlying(input, init)

    // The body, as text. A stream is consumed here and handed on as text
    // either way — once read it cannot be forwarded as it was.
    const rawBody = init && "body" in init ? init.body : isRequest(input) ? input.clone().body : null
    const consumedStream = typeof ReadableStream !== "undefined" && rawBody instanceof ReadableStream
    let text: string | null
    try {
      text = await bodyText(rawBody)
    } catch {
      text = null
    }
    if (text === null) {
      if (isModelHost(url.hostname, core.opts.hosts)) core.counters.skipped += 1
      return underlying(input, init)
    }

    const plan = core.outbound(url, headers, text) // may throw UnprotectedRequestError, on purpose
    if (!plan) {
      return consumedStream ? underlying(input, { ...init, body: text, headers }) : underlying(input, init)
    }
    if (plan.changed) headers.delete("content-length") // the platform recomputes it from the new body
    core.inFlight.add(plan.body)
    let res: Response
    try {
      res = await underlying(input, { ...init, method: "POST", headers, body: plan.body })
    } finally {
      core.inFlight.delete(plan.body)
    }
    return inbound(core, plan, res)
  }
}

/** The response side of the fetch half. */
async function inbound(core: Core, plan: Outbound, res: Response): Promise<Response> {
  if (!res.ok || res.body === null) return res
  const contentType = res.headers.get("content-type") ?? ""
  if (/text\/event-stream/i.test(contentType)) {
    const sse = core.sseRestorer(plan.protocol, plan.session)
    const decoder = new TextDecoder()
    const encoder = new TextEncoder()
    const transform = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const out = sse.feed(decoder.decode(chunk, { stream: true }))
        if (out) controller.enqueue(encoder.encode(out))
      },
      flush(controller) {
        const out = sse.feed(decoder.decode()) + sse.end()
        if (out) controller.enqueue(encoder.encode(out))
      },
    })
    const headers = new Headers(res.headers)
    headers.delete("content-length")
    return relabel(new Response(res.body.pipeThrough(transform), { status: res.status, statusText: res.statusText, headers }), res)
  }
  if (!/json/i.test(contentType)) return res
  const text = await res.text() // already decompressed by the platform
  const restored = core.restoreJson(plan.protocol, plan.session, text)
  const headers = new Headers(res.headers)
  headers.delete("content-encoding")
  headers.set("content-length", String(new TextEncoder().encode(restored).byteLength))
  return relabel(new Response(restored, { status: res.status, statusText: res.statusText, headers }), res)
}

// ---- the undici half ------------------------------------------------------------
//
// Best-effort and optional: `undici` is resolved at runtime, never a
// dependency. What it buys is coverage of an SDK that dispatches through
// its own undici client, and of a `fetch` reference captured before this
// plugin loaded — Node's built-in fetch and the npm package share one global
// dispatcher (`Symbol.for("undici.globalDispatcher.1")`), so composing it
// reaches both. A request the fetch wrapper already handled is recognised
// by its body (`Core.inFlight`) and passed straight through, so the two
// halves never process one request twice.

type UndiciHeaders = Record<string, string | string[] | undefined> | Array<string | Buffer> | Iterable<[string, string]> | null | undefined

function headersToObject(h: UndiciHeaders): Record<string, string> {
  const out: Record<string, string> = {}
  if (!h) return out
  if (Array.isArray(h)) {
    for (let i = 0; i + 1 < h.length; i += 2) out[String(h[i])] = String(h[i + 1])
    return out
  }
  if (typeof (h as Iterable<[string, string]>)[Symbol.iterator] === "function") {
    for (const [k, v] of h as Iterable<[string, string]>) out[k] = v
    return out
  }
  for (const [k, v] of Object.entries(h as Record<string, string | string[] | undefined>)) {
    if (v === undefined) continue
    out[k] = Array.isArray(v) ? v.join(", ") : v
  }
  return out
}

function getHeader(h: Record<string, string>, name: string): string | null {
  const lower = name.toLowerCase()
  for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === lower) return v
  return null
}

function setHeader(h: Record<string, string>, name: string, value: string): void {
  const lower = name.toLowerCase()
  for (const k of Object.keys(h)) if (k.toLowerCase() === lower) delete h[k]
  h[name] = value
}

async function collect(body: unknown): Promise<Buffer | null> {
  if (body === null || body === undefined) return null
  if (typeof body === "string") return Buffer.from(body, "utf8")
  if (Buffer.isBuffer(body)) return body
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  if (typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
    const parts: Buffer[] = []
    for await (const part of body as AsyncIterable<Uint8Array | string>) parts.push(typeof part === "string" ? Buffer.from(part) : Buffer.from(part))
    return Buffer.concat(parts)
  }
  return null
}

/** Rewrite one raw header array (name, value, name, value…) — the response-side shape. */
function rewriteRaw(raw: Array<string | Buffer>, name: string, value: string): Array<string | Buffer> {
  const out: Array<string | Buffer> = []
  let set = false
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (String(raw[i]).toLowerCase() === name) {
      if (!set) {
        out.push(name, value)
        set = true
      }
      continue
    }
    out.push(raw[i]!, raw[i + 1]!)
  }
  if (!set) out.push(name, value)
  return out
}

interface LegacyHandler {
  onHeaders?(status: number, headers: Array<string | Buffer>, resume: () => void, statusText?: string): boolean
  onData?(chunk: Buffer): boolean
  onComplete?(trailers: unknown): void
  onError?(err: unknown): void
}

function undiciInterceptor(core: Core, active: () => boolean) {
  return (dispatch: (opts: Record<string, unknown>, handler: LegacyHandler) => boolean) =>
    (opts: Record<string, unknown>, handler: LegacyHandler): boolean => {
      if (!active() || String(opts["method"] ?? "GET").toUpperCase() !== "POST") return dispatch(opts, handler)
      const headers = headersToObject(opts["headers"] as UndiciHeaders)
      if (!jsonLike(getHeader(headers, "content-type"))) return dispatch(opts, handler)
      let url: URL
      try {
        url = new URL(String(opts["path"] ?? "/"), String(opts["origin"]))
      } catch {
        return dispatch(opts, handler)
      }
      const proceed = (buf: Buffer | null): boolean => {
        if (buf === null) {
          if (isModelHost(url.hostname, core.opts.hosts)) core.counters.skipped += 1
          return dispatch(opts, handler)
        }
        const text = buf.toString("utf8")
        if (core.inFlight.has(text)) return dispatch({ ...opts, body: buf }, handler) // the fetch half was here first
        let plan: Outbound | null
        try {
          plan = core.outbound(url, new Headers(headers), text)
        } catch (err) {
          handler.onError?.(err)
          return true
        }
        if (!plan) return dispatch({ ...opts, body: buf }, handler)
        const next = { ...headers }
        const body = Buffer.from(plan.body, "utf8")
        setHeader(next, "content-length", String(body.byteLength))
        // The reply is rewritten at THIS layer, before any decompression, so
        // ask for none — a gzipped argument cannot be restored in place.
        setHeader(next, "accept-encoding", "identity")
        return dispatch({ ...opts, headers: next, body }, restoringHandler(core, plan, handler))
      }
      const body = opts["body"]
      if (body === null || body === undefined || typeof body === "string" || Buffer.isBuffer(body) || ArrayBuffer.isView(body) || body instanceof ArrayBuffer) {
        let buf: Buffer | null = null
        try {
          buf = body === null || body === undefined ? null : typeof body === "string" ? Buffer.from(body) : Buffer.isBuffer(body) ? body : body instanceof ArrayBuffer ? Buffer.from(body) : Buffer.from((body as Uint8Array).buffer, (body as Uint8Array).byteOffset, (body as Uint8Array).byteLength)
        } catch {
          buf = null
        }
        return proceed(buf)
      }
      // A stream body (what `fetch` hands the dispatcher): collected first,
      // dispatched after. The dispatch is deferred, never dropped.
      void collect(body)
        .then((buf) => proceed(buf))
        .catch((err) => handler.onError?.(err))
      return true
    }
}

/** The response side of the undici half — the legacy handler shape every compose layer exposes. */
function restoringHandler(core: Core, plan: Outbound, handler: LegacyHandler): LegacyHandler {
  let mode: "sse" | "json" | "pass" = "pass"
  let sse: { feed(chunk: string): string; end(): string } | null = null
  let decoder: InstanceType<typeof TextDecoder> | null = null
  const chunks: Buffer[] = []
  let deferred: { status: number; headers: Array<string | Buffer>; resume: () => void; statusText?: string } | null = null
  const wrapped: LegacyHandler = Object.create(handler) as LegacyHandler
  wrapped.onHeaders = (status, raw, resume, statusText) => {
    const h = headersToObject(raw)
    const contentType = getHeader(h, "content-type") ?? ""
    const encoding = (getHeader(h, "content-encoding") ?? "identity").toLowerCase()
    if (status >= 200 && status < 300 && (encoding === "identity" || encoding === "")) {
      if (/text\/event-stream/i.test(contentType)) {
        mode = "sse"
        sse = core.sseRestorer(plan.protocol, plan.session)
        decoder = new TextDecoder()
      } else if (/json/i.test(contentType)) {
        // Deferred: the body is rewritten whole, so its length is only known
        // at the end — the headers go down with the restored body.
        mode = "json"
        deferred = { status, headers: raw, resume, ...(statusText !== undefined ? { statusText } : {}) }
        return true
      }
    } else if (status >= 200 && status < 300) {
      core.counters.skipped += 1 // a compressed reply this layer cannot rewrite
    }
    return handler.onHeaders ? handler.onHeaders(status, raw, resume, statusText) : true
  }
  wrapped.onData = (chunk) => {
    if (mode === "sse" && sse && decoder) {
      const out = sse.feed(decoder.decode(chunk, { stream: true }))
      return out ? (handler.onData ? handler.onData(Buffer.from(out, "utf8")) : true) : true
    }
    if (mode === "json") {
      chunks.push(chunk)
      return true
    }
    return handler.onData ? handler.onData(chunk) : true
  }
  wrapped.onComplete = (trailers) => {
    if (mode === "sse" && sse && decoder) {
      const out = sse.feed(decoder.decode()) + sse.end()
      if (out) handler.onData?.(Buffer.from(out, "utf8"))
    } else if (mode === "json" && deferred) {
      const restored = Buffer.from(core.restoreJson(plan.protocol, plan.session, Buffer.concat(chunks).toString("utf8")), "utf8")
      const headers = rewriteRaw(deferred.headers, "content-length", String(restored.byteLength))
      handler.onHeaders?.(deferred.status, headers, deferred.resume, deferred.statusText)
      handler.onData?.(restored)
    }
    handler.onComplete?.(trailers)
  }
  return wrapped
}

// ---- installation -------------------------------------------------------------

class Handle implements HttpInterceptorHandle {
  readonly fetch: typeof fetch
  readonly ready: Promise<void>
  private undiciState: InterceptorStatus["undici"] = "off"
  private installed = true
  private active = true
  private restoreDispatcher: (() => void) | null = null

  constructor(
    private readonly core: Core,
    private readonly underlying: typeof fetch,
    installFetch: boolean,
    tryUndici: boolean,
  ) {
    this.fetch = wrapFetch(core, underlying)
    if (installFetch) globalThis.fetch = this.fetch
    this.ready = tryUndici ? this.installUndici() : Promise.resolve()
  }

  private async installUndici(): Promise<void> {
    this.undiciState = "pending"
    const specifier = "undici" // a variable, so the compiler does not require the package to exist
    let mod: Record<string, unknown>
    try {
      mod = (await import(specifier)) as Record<string, unknown>
    } catch {
      this.undiciState = "unavailable"
      return
    }
    try {
      const get = mod["getGlobalDispatcher"] as (() => { compose?: (i: unknown) => unknown }) | undefined
      const set = mod["setGlobalDispatcher"] as ((d: unknown) => void) | undefined
      const previous = get?.()
      if (!get || !set || !previous || typeof previous.compose !== "function") {
        this.undiciState = "unavailable"
        return
      }
      if (!this.active) return // uninstalled while the import was in flight
      const composed = previous.compose(undiciInterceptor(this.core, () => this.active))
      set(composed)
      this.restoreDispatcher = () => {
        if (get() === composed) set(previous) // only if nobody composed on top of us since
      }
      this.undiciState = "installed"
    } catch (err) {
      this.undiciState = "failed"
      this.core.log.warn(`[openguardrails] local redaction: undici interceptor not installed (${String(err)})`)
    }
  }

  get sawTraffic(): boolean {
    return this.core.sawTraffic
  }
  sessions(): string[] {
    return this.core.sessions()
  }
  noteToolCall(): boolean {
    return this.core.noteToolCall()
  }
  status(): InterceptorStatus {
    return {
      installed: this.installed,
      fetch: globalThis.fetch === this.fetch ? "wrapped" : "unwrapped",
      undici: this.undiciState,
      sawTraffic: this.core.sawTraffic,
      requests: this.core.counters.requests,
      streams: this.core.counters.streams,
      restored: this.core.counters.restored,
      skipped: this.core.counters.skipped,
      minted: this.core.counters.minted,
      unrestorable: [...this.core.unrestorable],
      sessions: this.core.sessions(),
    }
  }
  uninstall(): void {
    if (!this.installed) return
    this.installed = false
    this.active = false
    if (globalThis.fetch === this.fetch) globalThis.fetch = this.underlying
    this.restoreDispatcher?.()
    this.restoreDispatcher = null
    if (this.core.redactor.http === this) this.core.redactor.http = null
    if (current === this) current = null
  }
}

/**
 * Install the interceptor for one redactor. A previous installation in this
 * process is removed first — one interceptor, the latest redactor. The
 * handle is attached to the redactor (`redactor.http`), which is how its
 * `report()` learns whether anything has actually been masked.
 */
export function installHttpInterceptor(opts: HttpInterceptorOptions): HttpInterceptorHandle {
  current?.uninstall()
  const core = new Core(opts)
  const handle = new Handle(core, opts.fetch ?? globalThis.fetch, opts.installFetch ?? true, opts.undici ?? true)
  opts.redactor.http = handle
  current = handle
  return handle
}
