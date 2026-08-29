/**
 * Restore — on the way INTO a tool (design §4.3).
 *
 * Whole-token exact match only, longest key first, with the one latitude the
 * higress `Restorer` defines: a `\` before markdown-escapable punctuation
 * inside a token is absorbed, so `${OGR\_SECRET\_1}` restores. Nothing else
 * does. ⚠️ NEVER fuzzy, never prefix — a restorer that guesses is an
 * exfiltration oracle: an attacker who can make the model emit near-miss
 * tokens reads back values it was never shown.
 *
 * A `${OGR_…}` shape with no map entry — a resumed session, a hallucinated
 * number, a token from the gateway path, the overflow `${OGR_SECRET_X}` — is
 * reported as `unresolved`, and the caller blocks the call with
 * {@link UNRESTORABLE_NOTICE}: a shell expands `${OGR_SECRET_7}` to the empty
 * string and the call fails somewhere downstream with nothing naming why.
 *
 * The STREAMING form ({@link createStreamRestorer}) is a port of higress
 * `protocol/redact.go`'s `Restorer.Feed`: text is fed per delta, a complete
 * key is replaced wherever it lands, and a PARTIAL key at the end of what
 * has arrived so far is held back until the next delta completes it — or
 * `isLast` says nothing more is coming, at which point a partial token is
 * just text. ⚠️ Every streamed field needs its OWN buffer: two tool calls
 * stream interleaved, and one call's half-token must never be completed by
 * the other's next delta.
 */
import type { SessionMap } from "./session.js"

export interface RestoreResult {
  text: string
  /** Placeholder-shaped tokens (normalised, escapes removed) that no map entry answers. */
  unresolved: string[]
}

/** The notice a blocked call carries, verbatim from the specification. */
export function UNRESTORABLE_NOTICE(token: string): string {
  return (
    `${token} could not be restored: it is not a placeholder this session issued. ` +
    `Placeholders must be used exactly as they appear in your context; if the value was ` +
    `shown in an earlier session, ask the user to provide it again.`
  )
}

/** Punctuation a markdown renderer escapes — a fixed list, so `C:\name` is never read as an escape. */
const ESCAPABLE = new Set(["_", "*", "$", "{", "}", "[", "]", "(", ")", "#", "+", "-", ".", "!", "`", "~", "|", "<", ">", "\\"])

const MATCH_NONE = 0
const MATCH_FULL = 1
/** The text ended before the key did — a token may be straddling two deltas. */
const MATCH_TRUNCATED = 2

/**
 * Match `key` at `text[i]`, absorbing rendered escapes. Returns the RAW span
 * covered (escapes make it longer than the key) and the status —
 * `MATCH_TRUNCATED` when the text ran out mid-key, which a streaming caller
 * turns into a held tail and a whole-text caller treats as no match.
 */
function matchKey(text: string, i: number, key: string): [raw: number, status: number] {
  let p = i
  for (let k = 0; k < key.length; k += 1) {
    if (p >= text.length) return [0, MATCH_TRUNCATED]
    if (text[p] === "\\" && key[k] !== "\\") {
      if (p + 1 >= text.length) return [0, MATCH_TRUNCATED] // the escaped character has not arrived
      if (ESCAPABLE.has(text[p + 1]!)) p += 1
    }
    if (text[p] !== key[k]) return [0, MATCH_NONE]
    p += 1
  }
  return [p - i, MATCH_FULL]
}

/** A tolerant scan for placeholder shapes, escaped or not, normalised to the bare token. */
const TOKEN_SHAPE_RE = /\\?\$\\?\{OGR(?:\\?_[A-Z]+)*\\?_[0-9A-Z]+\\?\}/g

export function tokensIn(text: string): string[] {
  const out = new Set<string>()
  TOKEN_SHAPE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TOKEN_SHAPE_RE.exec(text)) !== null) out.add(m[0].replaceAll("\\", ""))
  return [...out]
}

/**
 * How a restored value is written into the surrounding text. The default is
 * the value itself; {@link jsonStringEncode} is for a value landing INSIDE a
 * JSON string literal — an OpenAI `function.arguments` string, an Anthropic
 * `partial_json` fragment — where a quote or a backslash in the value would
 * otherwise break the document the client is about to parse.
 */
export type ValueEncoder = (value: string) => string

/** The value as it must appear inside a JSON string literal (the quotes stripped). */
export const jsonStringEncode: ValueEncoder = (value) => JSON.stringify(value).slice(1, -1)

export interface StreamRestorer {
  /**
   * `Extract`: replace every complete key in `text` and split the remainder
   * into output and a pending tail that may be the beginning of a key. With
   * `isLast`, nothing is held back: a partial token at end-of-stream is text.
   */
  extract(text: string, isLast: boolean): { output: string; pending: string }
  /**
   * `Feed`: extract against a caller-held tail — the shape a streaming
   * decoder needs. Appends `text` to `state.pending`, returns what is safe to
   * emit, and leaves the unresolved tail in `state.pending`.
   */
  feed(state: { pending: string }, text: string, isLast: boolean): string
  /** Whether the map holds anything to restore right now. */
  readonly active: boolean
}

/**
 * The higress `Restorer`, ported. Keys are THE MAP'S OWN tokens, tried
 * longest first so a key is never shadowed by a prefix; the hold-back bound
 * is derived from the longest key (every character preceded by an escape);
 * a `\` before markdown punctuation is absorbed. The map is read live, so a
 * token minted after the stream began still restores.
 */
export function createStreamRestorer(map: SessionMap, opts: { encode?: ValueEncoder } = {}): StreamRestorer {
  const encode = opts.encode ?? ((v: string) => v)

  const matchAt = (keys: readonly string[], text: string, i: number): [key: string, raw: number, partial: boolean] => {
    let partial = false
    for (const k of keys) {
      const [raw, status] = matchKey(text, i, k)
      if (status === MATCH_FULL) return [k, raw, false]
      if (status === MATCH_TRUNCATED) partial = true // keep looking: a SHORTER key may still match in full
    }
    return ["", 0, partial]
  }

  const extract = (text: string, isLast: boolean): { output: string; pending: string } => {
    const keys = map.tokens()
    if (keys.length === 0 || text === "") return { output: text, pending: "" }
    const starts = new Set<string>(["\\"]) // a key may begin at an escaped first character
    let longest = 0
    for (const k of keys) {
      starts.add(k[0]!)
      if (k.length > longest) longest = k.length
    }
    const maxRaw = longest * 2 + 2
    const parts: string[] = []
    let flushed = 0
    let i = 0
    while (i < text.length) {
      if (!starts.has(text[i]!)) {
        i += 1
        continue
      }
      const [key, raw, partial] = matchAt(keys, text, i)
      if (raw > 0) {
        parts.push(text.slice(flushed, i), encode(map.valueOf(key)!))
        i += raw
        flushed = i
        continue
      }
      if (partial && !isLast && text.length - i <= maxRaw) {
        parts.push(text.slice(flushed, i))
        return { output: parts.join(""), pending: text.slice(i) }
      }
      i += 1
    }
    parts.push(text.slice(flushed))
    return { output: parts.join(""), pending: "" }
  }

  return {
    extract,
    feed(state, text, isLast) {
      const { output, pending } = extract(state.pending + text, isLast)
      state.pending = pending
      return output
    },
    get active() {
      return map.tokens().length > 0
    },
  }
}

export function restore(text: string, map: SessionMap, opts: { encode?: ValueEncoder } = {}): RestoreResult {
  const out = text === "" ? text : createStreamRestorer(map, opts).extract(text, true).output
  const unresolved = tokensIn(out).filter((t) => map.valueOf(t) === undefined)
  return { text: out, unresolved }
}

/**
 * {@link restore} inside JSON TEXT — a string that IS a JSON document or
 * fragment (an OpenAI `function.arguments`, a Responses `arguments`). A
 * placeholder can only sit inside a string literal there, and the restored
 * value is written JSON-escaped so the document stays parseable.
 */
export function restoreJsonText(text: string, map: SessionMap): RestoreResult {
  return restore(text, map, { encode: jsonStringEncode })
}

export interface RestoreArgsResult<T> {
  args: T
  unresolved: string[]
  changed: boolean
}

/** {@link restore} over every string leaf of a tool's arguments, recursively; structure untouched. */
export function restoreArgs<T>(args: T, map: SessionMap): RestoreArgsResult<T> {
  const unresolved = new Set<string>()
  let changed = false
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = restore(v, map)
      for (const t of r.unresolved) unresolved.add(t)
      if (r.text !== v) changed = true
      return r.text
    }
    if (Array.isArray(v)) return v.map(walk)
    if (typeof v === "object" && v !== null) {
      const src = v as Record<string, unknown>
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(src)) out[k] = walk(src[k])
      return out
    }
    return v
  }
  const out = walk(args) as T
  return { args: changed ? out : args, unresolved: [...unresolved], changed }
}

/**
 * {@link restoreArgs} against SEVERAL maps in turn — the host's own session
 * map and the HTTP interceptor's, which cannot know the host's session id
 * and keys by the provider request's `user` stamp or a per-process default.
 * A value with no token in it restores to itself, so the passes compose; a
 * token no map answers stays in place and is reported once.
 */
export function restoreArgsAcross<T>(args: T, maps: readonly SessionMap[]): RestoreArgsResult<T> {
  let current = args
  let changed = false
  let unresolved: string[] = restoreArgs(args, EMPTY_MAP).unresolved
  for (const map of maps) {
    const r = restoreArgs(current, map)
    current = r.args
    changed = changed || r.changed
    unresolved = r.unresolved
  }
  return { args: current, unresolved, changed }
}

/** A map with nothing in it, so a zero-map restore still reports the tokens it saw. */
const EMPTY_MAP = { tokens: () => [], valueOf: () => undefined } as unknown as SessionMap
