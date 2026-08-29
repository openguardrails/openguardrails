/**
 * The session map: value ↔ token, per session, in memory, never on disk.
 *
 * A value seen twice in one session gets the same token — that is what lets
 * the model refer to "the key from earlier" and have the plugin restore the
 * right bytes into the tool call. Persisting the map would write the secrets
 * to the disk the harness is keeping them off, so a resumed session starts
 * with a fresh map and re-masks its raw history (design §3).
 *
 * Bounded at 256 values per session. Over the bound a new value is STILL
 * masked, with the fixed non-restorable `${OGR_SECRET_X}` — refusing to mask
 * is the wrong side to fail on — and a warning says so once per session.
 */

/** The placeholder shape this library mints and restores. */
export const SECRET_TOKEN_PREFIX = "${OGR_SECRET_"

/** The non-restorable placeholder a full map masks new values with. */
export const OVERFLOW_TOKEN = "${OGR_SECRET_X}"

export const DEFAULT_BOUND = 256

export interface TokenGrant {
  token: string
  /** True the first time this value was seen in the session (a MINT). */
  fresh: boolean
  /** False for the overflow token — a mask that can never be undone. */
  restorable: boolean
}

export interface SessionMapOptions {
  bound?: number
  warn?: (message: string) => void
  /**
   * The number allocator. Default: this map's own counter, from 1. A
   * {@link SessionMaps} registry hands every map ONE shared allocator, so a
   * token number is unique across every session the process holds — two
   * maps in one process (the host's session and the HTTP interceptor's)
   * can then never mint `${OGR_SECRET_1}` for two different values, which is
   * the collision design §3 warns about and a restore across maps would
   * otherwise be ambiguous under. Value-stability stays per session.
   */
  allocate?: () => number
}

export class SessionMap {
  private readonly byValue = new Map<string, string>()
  private readonly byToken = new Map<string, string>()
  private counter = 0
  private warnedFull = false
  private valuesLongestFirst: string[] | null = null
  private tokensLongestFirst: string[] | null = null
  readonly bound: number
  private readonly warn: (message: string) => void
  private readonly allocate: () => number

  constructor(
    readonly id: string,
    opts: SessionMapOptions = {},
  ) {
    this.bound = opts.bound ?? DEFAULT_BOUND
    this.warn = opts.warn ?? (() => {})
    this.allocate = opts.allocate ?? (() => ++this.counter)
  }

  get size(): number {
    return this.byValue.size
  }

  has(value: string): boolean {
    return this.byValue.has(value)
  }

  /** The token for a value, minting one when the value is new. */
  tokenFor(value: string): TokenGrant {
    const known = this.byValue.get(value)
    if (known !== undefined) return { token: known, fresh: false, restorable: true }
    if (this.byValue.size >= this.bound) {
      if (!this.warnedFull) {
        this.warnedFull = true
        this.warn(
          `[openguardrails] local redaction: session ${this.id} holds ${this.bound} secrets — further values are masked with the non-restorable ${OVERFLOW_TOKEN}`,
        )
      }
      return { token: OVERFLOW_TOKEN, fresh: true, restorable: false }
    }
    const token = `${SECRET_TOKEN_PREFIX}${this.allocate()}}`
    this.byValue.set(value, token)
    this.byToken.set(token, value)
    this.valuesLongestFirst = null
    this.tokensLongestFirst = null
    return { token, fresh: true, restorable: true }
  }

  valueOf(token: string): string | undefined {
    return this.byToken.get(token)
  }

  /** Every known value, longest first — the order a value substitution must run in. */
  values(): readonly string[] {
    if (!this.valuesLongestFirst) {
      this.valuesLongestFirst = [...this.byValue.keys()].sort((a, b) => b.length - a.length)
    }
    return this.valuesLongestFirst
  }

  /** Every issued token, longest first — the order a restorer must try keys in. */
  tokens(): readonly string[] {
    if (!this.tokensLongestFirst) {
      this.tokensLongestFirst = [...this.byToken.keys()].sort((a, b) => b.length - a.length)
    }
    return this.tokensLongestFirst
  }

  entries(): ReadonlyMap<string, string> {
    return this.byToken
  }
}

/**
 * The per-process registry of session maps, keyed by the host's own session
 * id. Bounded in sessions too (oldest dropped), so a long-lived gateway
 * process does not hold every conversation it ever saw. ONE allocator for
 * every map it hands out: a token number names one value in the whole
 * process (see {@link SessionMapOptions.allocate}).
 */
export class SessionMaps {
  private readonly maps = new Map<string, SessionMap>()
  private readonly maxSessions: number
  private readonly mapOptions: SessionMapOptions
  private issued = 0

  constructor(opts: SessionMapOptions & { maxSessions?: number } = {}) {
    this.maxSessions = opts.maxSessions ?? 1024
    this.mapOptions = {
      ...(opts.bound !== undefined ? { bound: opts.bound } : {}),
      ...(opts.warn ? { warn: opts.warn } : {}),
      allocate: opts.allocate ?? (() => ++this.issued),
    }
  }

  get(sessionId: string): SessionMap {
    let map = this.maps.get(sessionId)
    if (map) {
      // Refresh recency: re-insert so the oldest-first eviction stays honest.
      this.maps.delete(sessionId)
      this.maps.set(sessionId, map)
      return map
    }
    if (this.maps.size >= this.maxSessions) {
      const oldest = this.maps.keys().next()
      if (!oldest.done) this.maps.delete(oldest.value)
    }
    map = new SessionMap(sessionId, this.mapOptions)
    this.maps.set(sessionId, map)
    return map
  }

  peek(sessionId: string): SessionMap | undefined {
    return this.maps.get(sessionId)
  }

  drop(sessionId: string): void {
    this.maps.delete(sessionId)
  }

  get size(): number {
    return this.maps.size
  }
}
