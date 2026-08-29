/**
 * The glue an integration needs, in one object: the ruleset (cache → fetch →
 * compile → refresh on a heartbeat's say-so), the per-session maps, the
 * per-step minted list that becomes the `redaction.masked[]` report, the
 * mask/restore calls keyed by the host's session id, and — since the HTTP
 * interceptor — whether anything is provably masked.
 *
 * Failure posture (design §4.5): a cached ruleset masks immediately and
 * refreshes in the background; with no cache the first fetch is awaited by
 * `start()` (bounded by `timeoutMs`), so a fresh install's first model call
 * is protected rather than reported as `ruleset: ""`; if that fetch fails the
 * redactor runs UNPROTECTED — known values (none yet) still masked, every
 * request warned about, `ruleset: ""` reported — until a later refresh lands.
 * What "unprotected" costs the caller is the caller's `failMode` to decide.
 */
import { mask, maskKnown, maskLeaves, type MaskResult, type Minted, type WalkResult } from "./mask.js"
import { restore, restoreArgsAcross, type RestoreArgsResult, type RestoreResult } from "./restore.js"
import {
  compileRuleset,
  defaultCachePath,
  loadRuleset,
  readCachedRuleset,
  type CompiledRuleset,
  type RuleTier,
  type Ruleset,
} from "./ruleset.js"
import { SessionMap, SessionMaps } from "./session.js"

export interface RedactorLog {
  info(message: string): void
  warn(message: string): void
}

export interface RedactorOptions {
  /** Where the runtime is and as whom — thunks, so a late-arriving config lands without re-registration. */
  source: () => { runtimeUrl: string; apiKey: string } | null
  cachePath?: string
  tiers?: readonly RuleTier[]
  fetch?: typeof fetch
  timeoutMs?: number
  log?: RedactorLog
  /** Per-session value bound (default 256). */
  bound?: number
}

/** The optional fourth GuardEvent field (OGR 1.4, design §4.4). */
export interface RedactionReport {
  /** The ruleset id this step ran under; `""` = local redaction is on but no ruleset was ever obtained. */
  ruleset: string
  /** Tokens MINTED in this step — never values. */
  masked: Minted[]
}

/**
 * What the redactor needs to know about an installed HTTP interceptor —
 * declared here rather than imported, so `http.ts` can import this module.
 */
export interface TrafficWitness {
  /** Set by the first model call that passed through the interceptor. */
  readonly sawTraffic: boolean
  /** The session keys the interceptor has masked under. */
  sessions(): string[]
}

export class LocalRedactor {
  private compiled: CompiledRuleset | null = null
  private readonly maps: SessionMaps
  private readonly pending = new Map<string, Minted[]>()
  private refreshing: Promise<void> | null = null
  private readonly log: RedactorLog
  private readonly opts: RedactorOptions

  /** The installed HTTP interceptor, when there is one (set by `installHttpInterceptor`). */
  http: TrafficWitness | null = null
  /**
   * Set by an integration whose HOOK-based masking is engaged — the fallback
   * for when model traffic is not passing through the interceptor. It is
   * the other way a step can be provably masked.
   */
  fallbackActive = false

  constructor(opts: RedactorOptions) {
    this.opts = opts
    this.log = opts.log ?? { info: () => {}, warn: (m) => console.warn(m) }
    this.maps = new SessionMaps({
      ...(opts.bound !== undefined ? { bound: opts.bound } : {}),
      warn: (m) => this.log.warn(m),
    })
  }

  /** Whether a compiled ruleset is in hand. */
  get ready(): boolean {
    return this.compiled !== null
  }

  /** The id reported on every event and heartbeat; `""` until a ruleset arrives. */
  get rulesetId(): string {
    return this.compiled?.id ?? ""
  }

  get ruleset(): CompiledRuleset | null {
    return this.compiled
  }

  /**
   * Whether anything can be shown to be masking the model path: the
   * interceptor has seen traffic, or the hook fallback is engaged. With no
   * interceptor installed the integration decides for itself (true).
   */
  get masking(): boolean {
    if (!this.http) return true
    return this.http.sawTraffic || this.fallbackActive
  }

  private cachePath(): string | null {
    if (this.opts.cachePath) return this.opts.cachePath
    const src = this.opts.source()
    return src ? defaultCachePath(src.runtimeUrl) : null
  }

  private adopt(ruleset: Ruleset, from: string): void {
    if (this.compiled?.id === ruleset.id) return
    const compiled = compileRuleset(ruleset, {
      ...(this.opts.tiers ? { tiers: this.opts.tiers } : {}),
      log: (m) => this.log.warn(m),
    })
    this.compiled = compiled
    this.log.info(
      `[openguardrails] local redaction: ruleset ${compiled.id} (${from}) — ${compiled.rules.length} rules` +
        (compiled.disabled.length ? `, ${compiled.disabled.length} disabled` : "") +
        (compiled.skipped.length ? `, ${compiled.skipped.length} outside the configured tiers` : ""),
    )
  }

  /**
   * Bring the ruleset up. With a cache: compile it now, refresh in the
   * background, return at once. Without: await ONE fetch (bounded by
   * `timeoutMs`), so the first request of a fresh install is masked.
   */
  async start(): Promise<void> {
    const path = this.cachePath()
    const cached = path ? readCachedRuleset(path) : null
    if (cached) {
      this.adopt(cached, "cache")
      void this.refresh()
      return
    }
    await this.refresh()
  }

  /** Fetch (with `If-None-Match`) and adopt whatever comes back; coalesces concurrent calls. */
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing
    this.refreshing = (async () => {
      const src = this.opts.source()
      if (!src) return
      const result = await loadRuleset({
        runtimeUrl: src.runtimeUrl,
        apiKey: src.apiKey,
        ...(this.opts.cachePath ? { cachePath: this.opts.cachePath } : {}),
        ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
        ...(this.opts.timeoutMs !== undefined ? { timeoutMs: this.opts.timeoutMs } : {}),
      })
      if (result.error) this.log.warn(`[openguardrails] local redaction: ${result.error}`)
      if (result.ruleset) this.adopt(result.ruleset, result.source)
    })().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  /**
   * The heartbeat response carries `rules: {id}`; an id that is not the one
   * held triggers a refetch — how a running plugin learns of a change within
   * one heartbeat interval without polling the feed.
   */
  onHeartbeat(reply: unknown): void {
    const id = (reply as { rules?: { id?: unknown } } | null)?.rules?.id
    if (typeof id === "string" && id !== "" && id !== this.rulesetId) void this.refresh()
  }

  /** Said on every request that goes out unprotected (§4.5) — loud on purpose. */
  warnUnprotected(what: string): void {
    this.log.warn(`[openguardrails] local redaction: no ruleset obtained yet — ${what} proceeds unmasked`)
  }

  session(sessionId: string): SessionMap {
    return this.maps.get(sessionId)
  }

  /**
   * The host's session plus every session the interceptor has masked under:
   * the maps a restore must consult, since a token in a tool call may have
   * been minted at either vantage.
   */
  private sessionsFor(sessionId: string): string[] {
    const keys = [sessionId]
    for (const k of this.http?.sessions() ?? []) if (!keys.includes(k)) keys.push(k)
    return keys
  }

  private record(sessionId: string, minted: Minted[]): void {
    if (minted.length === 0) return
    const list = this.pending.get(sessionId) ?? []
    list.push(...minted)
    this.pending.set(sessionId, list)
  }

  /** Mask one text for the session; minted tokens are recorded for the next report. */
  mask(sessionId: string, text: string): MaskResult {
    const r = mask(text, this.session(sessionId), this.compiled)
    this.record(sessionId, r.minted)
    return r
  }

  /** Mask every string leaf of a value (a request, a message, a tool result). */
  maskValue<T>(sessionId: string, value: T): WalkResult<T> {
    const r = maskLeaves(value, this.session(sessionId), this.compiled)
    this.record(sessionId, r.minted)
    return r
  }

  /** Known values only — the egress pass every outbound event takes (D6). */
  maskKnown<T>(sessionId: string, value: T): WalkResult<T> {
    return maskKnown(value, this.session(sessionId))
  }

  restore(sessionId: string, text: string): RestoreResult {
    return restore(text, this.session(sessionId))
  }

  /**
   * Restore a tool's arguments against the host's session map AND the
   * interceptor's — the two vantages mint into different maps. Idempotent:
   * a value with no token in it restores to itself.
   */
  restoreArgs<T>(sessionId: string, args: T): RestoreArgsResult<T> {
    return restoreArgsAcross(
      args,
      this.sessionsFor(sessionId).map((k) => this.session(k)),
    )
  }

  /**
   * The `redaction` field for the next event of this session — drains the
   * minted lists of the host session and of every interceptor session.
   * `undefined` when an interceptor is installed and NOTHING has been shown
   * to mask (no traffic seen, no fallback engaged): the event then carries
   * no `redaction` field, so the runtime never reads the step as protected.
   */
  report(sessionId: string): RedactionReport | undefined {
    if (!this.masking) return undefined
    const masked: Minted[] = []
    for (const key of this.sessionsFor(sessionId)) {
      const list = this.pending.get(key)
      if (!list) continue
      masked.push(...list)
      this.pending.delete(key)
    }
    return { ruleset: this.rulesetId, masked }
  }
}
