/**
 * The masking pipe: one model request in, one masked request out; one reply
 * back, tool-call arguments restored.
 *
 * This is the same work `@openguardrails/local-redaction`'s in-process
 * interceptor does, at the one vantage a harness with no plugin seam leaves
 * open — a socket in front of it. The interceptor wraps `fetch` inside the
 * agent's own process; this wraps nothing and owns no process, so it is
 * expressed as a pure-ish pair of functions over bodies and a streaming
 * transformer, and the transport lives in `server.ts`.
 *
 * ⚠️ Kept deliberately thin, and deliberately NOT a fork of the
 * interceptor's `Core`: both must agree about what a model call is, which
 * protocol a body speaks, and where a tool call's arguments live, so both
 * read those answers from the shared library rather than from a local copy.
 * The one thing this module knows that the interceptor does not is that
 * there is an UPSTREAM — a real provider the request is on its way to.
 */
import {
  createSseRestorer,
  restoreResponseBody,
  sniffProtocol,
  stampedSession,
  type LocalRedactor,
  type ModelProtocol,
  type RedactionReport,
} from "@openguardrails/local-redaction"

/** What a masked request became, and what the reply half needs to undo it. */
export interface Masked {
  protocol: ModelProtocol
  session: string
  body: string
  /** Whether anything actually changed — the caller may forward the original bytes when not. */
  changed: boolean
  minted: number
}

export interface PipeOptions {
  redactor: LocalRedactor
  /**
   * Derives the session key from a request. The default reads the body's own
   * stamp — Anthropic and OpenAI both carry a caller-chosen `metadata.user_id`
   * / `user`, and Claude Code puts a per-session value there — falling back
   * to one key for the whole process.
   */
  sessionKey?: (req: { url: URL; body: unknown; headers: Headers }) => string
  /** Extra hostnames to treat as a model API (a self-hosted gateway). */
  hosts?: readonly string[]
  log?: { info(m: string): void; warn(m: string): void }
}

/** One key for a proxy nobody stamped a session onto. */
export const DEFAULT_SESSION = "process"

export class Pipe {
  readonly counters = { requests: 0, streams: 0, restored: 0, passed: 0, minted: 0 }
  private readonly sessions = new Set<string>()

  constructor(private readonly opts: PipeOptions) {}

  get redactor(): LocalRedactor {
    return this.opts.redactor
  }

  /**
   * Mask one outbound request, or answer `null` for "this is not a model
   * call — forward it untouched".
   *
   * ⚠️ A body that does not parse as JSON, or does not sniff as one of the
   * three protocols, is passed through VERBATIM. That is not laziness: the
   * harness talks to its provider about more than completions (token counts,
   * model lists, file uploads), and a proxy that rewrote those would break
   * the harness while protecting nothing.
   */
  mask(url: URL, headers: Headers, text: string): Masked | null {
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      return null
    }
    const protocol = sniffProtocol(body, url)
    if (!protocol) return null

    const session = this.opts.sessionKey
      ? this.opts.sessionKey({ url, body, headers })
      : (stampedSession(body) ?? DEFAULT_SESSION)
    this.sessions.add(session)

    const masked = this.redactor.maskValue(session, body)
    this.counters.requests += 1
    this.counters.minted += masked.minted.length
    return {
      protocol,
      session,
      body: masked.changed ? JSON.stringify(masked.value) : text,
      changed: masked.changed,
      minted: masked.minted.length,
    }
  }

  /** Put the values back into a buffered reply's tool-call arguments. */
  restore(plan: Masked, text: string): string {
    const r = restoreResponseBody(plan.protocol, text, this.redactor.session(plan.session))
    if (!r) return text
    if (r.changed) this.counters.restored += 1
    if (r.unresolved.length) {
      this.opts.log?.warn(
        `[ogr-local] ${r.unresolved.length} placeholder(s) in a tool call had no value to restore — the model invented or altered a token`,
      )
    }
    return r.body
  }

  /** The same, frame by frame, for an SSE reply. */
  streamRestorer(plan: Masked): { feed(chunk: string): string; end(): string } {
    this.counters.streams += 1
    let counted = false
    const inner = createSseRestorer(plan.protocol, this.redactor.session(plan.session), {
      onUnresolved: (tokens) =>
        this.opts.log?.warn(`[ogr-local] ${tokens.length} placeholder(s) in a streamed tool call had no value to restore`),
    })
    return {
      feed: (chunk) => {
        const out = inner.feed(chunk)
        if (!counted && out !== chunk) {
          counted = true
          this.counters.restored += 1
        }
        return out
      },
      end: () => inner.end(),
    }
  }

  /**
   * The report for a step, drained across every session this proxy has
   * masked under — the harness's hook cannot know which key its own step
   * was filed under, because the key came off the request body the hook
   * never saw.
   */
  report(session?: string): RedactionReport | undefined {
    if (!this.redactor.masking) return undefined
    const keys = session ? [session] : [...this.sessions]
    if (keys.length === 0) return { ruleset: this.redactor.rulesetId, masked: [] }
    const masked: RedactionReport["masked"] = []
    let ruleset = this.redactor.rulesetId
    for (const key of keys) {
      const part = this.redactor.report(key)
      if (!part) continue
      ruleset = part.ruleset
      masked.push(...part.masked)
    }
    return { ruleset, masked }
  }

  knownSessions(): string[] {
    return [...this.sessions]
  }
}
