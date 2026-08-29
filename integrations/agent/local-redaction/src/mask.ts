/**
 * Mask — on the way OUT (design §4.1), exactly in this order:
 *
 *  1. Normalise for MATCHING only: zero-width and control characters are
 *     stripped with an index map back to the original, so a token split by a
 *     ZWSP is still a token and the splice removes the split characters with
 *     the value. Line structure is kept (`\n`, `\r`, `\t` survive): a rule
 *     may read `^`/`$` or `\s`, and hermes's stripping was for a prefix
 *     matcher that reads neither.
 *  2. KNOWN values first, longest first: every occurrence of every value
 *     already in the session map becomes its token (`MaskString`'s rule — a
 *     value that is a substring of another cannot corrupt it).
 *  3. Then the ruleset, in SERVED order, over the remaining text. Overlaps
 *     resolve longest-wins; equal lengths fall to array order. A match is
 *     never taken inside an existing `${OGR_…}` token.
 *  4. Splice, highest offset first. Nothing else changes.
 *
 * `minted` lists the tokens this call created — new values only. History
 * tokens are just text now.
 */
import type { CompiledRuleset, Span } from "./ruleset.js"
import { ruleSpans } from "./ruleset.js"
import type { SessionMap } from "./session.js"

export interface Minted {
  token: string
  /** `<rule id>/<pattern id>` — the coverage statistic per issuer or carrier. */
  rule: string
}

export interface MaskResult {
  text: string
  minted: Minted[]
}

/** Any placeholder of the OGR shape, whichever allocator minted it. */
export const TOKEN_RE = /\$\{OGR_[A-Z_]+_[0-9A-Z]+\}/g

/**
 * What is stripped for matching: C0 controls other than `\t` `\n` `\r`, DEL,
 * the zero-width family (U+200B–U+200F), the line/paragraph separators and
 * bidi controls (U+2028–U+202E), the word joiner and the BOM.
 */
const STRIP_ONE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2060\ufeff]/

interface Normalized {
  stripped: string
  /** `index[i]` = the original offset of stripped code unit `i`; null when nothing was stripped. */
  index: number[] | null
}

function normalize(text: string): Normalized {
  if (!STRIP_ONE.test(text)) return { stripped: text, index: null }
  const chars: string[] = []
  const index: number[] = []
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!
    if (STRIP_ONE.test(ch)) continue
    chars.push(ch)
    index.push(i)
  }
  return { stripped: chars.join(""), index }
}

function overlapsAny(span: Span, spans: readonly Span[]): boolean {
  for (const s of spans) if (span.start < s.end && s.start < span.end) return true
  return false
}

function tokenRanges(text: string): Span[] {
  const out: Span[] = []
  TOKEN_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TOKEN_RE.exec(text)) !== null) out.push({ start: m.index, end: m.index + m[0].length })
  return out
}

interface Replacement extends Span {
  token: string
}

export function mask(text: string, map: SessionMap, compiled: CompiledRuleset | null): MaskResult {
  if (text === "") return { text, minted: [] }
  const { stripped, index } = normalize(text)
  const tokens = tokenRanges(stripped)
  const accepted: Replacement[] = []

  // 2. Known values, longest first.
  for (const value of map.values()) {
    if (value === "") continue
    const token = map.tokenFor(value).token
    let at = stripped.indexOf(value)
    while (at !== -1) {
      const span = { start: at, end: at + value.length }
      if (!overlapsAny(span, tokens) && !overlapsAny(span, accepted)) accepted.push({ ...span, token })
      at = stripped.indexOf(value, span.end)
    }
  }

  // 3. The ruleset, served order; longest wins, ties to array order.
  const minted: Minted[] = []
  if (compiled && compiled.rules.length > 0) {
    const candidates: Array<Span & { rule: string; order: number }> = []
    for (const rule of compiled.rules) {
      for (const s of ruleSpans(rule, stripped)) {
        if (overlapsAny(s, tokens)) continue
        candidates.push({ start: s.start, end: s.end, rule: `${rule.id}/${s.pattern}`, order: candidates.length })
      }
    }
    candidates.sort((a, b) => b.end - b.start - (a.end - a.start) || a.order - b.order)
    const chosen: Array<Span & { rule: string }> = []
    for (const c of candidates) {
      if (overlapsAny(c, accepted) || overlapsAny(c, chosen)) continue
      chosen.push(c)
    }
    // Mint left to right so token numbers read in text order.
    chosen.sort((a, b) => a.start - b.start)
    const seen = new Set<string>()
    for (const c of chosen) {
      const value = stripped.slice(c.start, c.end)
      const grant = map.tokenFor(value)
      accepted.push({ start: c.start, end: c.end, token: grant.token })
      if (grant.fresh && !seen.has(grant.token)) {
        seen.add(grant.token)
        minted.push({ token: grant.token, rule: c.rule })
      }
    }
  }

  if (accepted.length === 0) return { text, minted }

  // 4. Splice on the ORIGINAL, mapping stripped offsets back.
  accepted.sort((a, b) => a.start - b.start)
  let out = ""
  let cursor = 0
  for (const r of accepted) {
    const os = index ? index[r.start]! : r.start
    const oe = index ? index[r.end - 1]! + 1 : r.end
    out += text.slice(cursor, os) + r.token
    cursor = oe
  }
  out += text.slice(cursor)
  return { text: out, minted }
}

/**
 * Keys that name STRUCTURE rather than carry content — roles, kinds,
 * identifiers, model names. Left alone by the leaf walk so a masked request
 * keeps every id the host and the provider correlate on.
 */
export const STRUCTURAL_KEYS: ReadonlySet<string> = new Set([
  "role",
  "type",
  "id",
  "model",
  "name",
  "object",
  "status",
  "finish_reason",
  "stop_reason",
  "stopReason",
  "tool_call_id",
  "tool_use_id",
  "call_id",
  "callID",
  "sessionID",
  "messageID",
  "toolCallId",
  "toolName",
  "tool",
  "provider",
  "api",
  "mimeType",
  "media_type",
  "textSignature",
  "thinkingSignature",
])

export interface WalkResult<T> {
  value: T
  minted: Minted[]
  /** Whether any leaf changed — lets a caller hand back the original object untouched. */
  changed: boolean
}

function isImageBlock(obj: Record<string, unknown>): boolean {
  const t = obj["type"]
  return t === "image" || t === "image_url" || t === "input_image" || typeof obj["mimeType"] === "string"
}

/**
 * Mask every string leaf of a value — a provider request, a message, a tool
 * result, an event payload — returning a structurally identical copy. Message
 * count, roles, ids and array indexes are untouched: replace in place, never
 * remove (the OGR 1.1 media rule, applied to text). Base64 image data is
 * skipped (nothing to find, and a regex over a megabyte is not free).
 */
export function maskLeaves<T>(value: T, map: SessionMap, compiled: CompiledRuleset | null): WalkResult<T> {
  const minted: Minted[] = []
  let changed = false
  const walk = (v: unknown, key: string | null, parent: Record<string, unknown> | null): unknown => {
    if (typeof v === "string") {
      if (key !== null && STRUCTURAL_KEYS.has(key)) return v
      if (key === "data" && parent && isImageBlock(parent)) return v
      const r = mask(v, map, compiled)
      if (r.text !== v) changed = true
      minted.push(...r.minted)
      return r.text
    }
    if (Array.isArray(v)) return v.map((item) => walk(item, null, null))
    if (typeof v === "object" && v !== null) {
      const src = v as Record<string, unknown>
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(src)) out[k] = walk(src[k], k, src)
      return out
    }
    return v
  }
  const out = walk(value, null, null) as T
  return { value: changed ? out : value, minted, changed }
}

/**
 * The outbound provider request, masked (§4.1). Every string leaf — a
 * `messages[].content` string or content-block `text`, `system`, tool
 * results, tool definitions, a Responses `input` — goes through {@link mask};
 * the walk is generic on purpose, so a provider field this library has not
 * heard of is masked rather than missed.
 */
export function maskRequest<T>(body: T, map: SessionMap, compiled: CompiledRuleset | null): WalkResult<T> {
  return maskLeaves(body, map, compiled)
}

/**
 * Step 2 alone — KNOWN values → tokens, no rules (design §4.2, D6). What every
 * event the plugin sends passes through immediately before serialisation, so
 * the OGR client is an egress masked like the provider is.
 */
export function maskKnown<T>(value: T, map: SessionMap): WalkResult<T> {
  return maskLeaves(value, map, null)
}
