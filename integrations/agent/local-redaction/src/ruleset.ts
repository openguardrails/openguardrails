/**
 * The secret ruleset: what `GET /v1/rules` serves, how it is cached on the
 * host, and how it is compiled — and VERIFIED — in this engine.
 *
 * The plugin ships with no patterns (design D4): the ruleset is an org asset
 * fetched from the runtime with the org key, cached at mode 0600, refreshed
 * when the heartbeat says the id moved. Every rule carries `examples`, and a
 * rule whose examples fail in THIS engine is disabled by name rather than run
 * wrong (D9) — dialects drift silently, and a pattern that compiles to
 * "matches nothing" looks exactly like a pattern that is doing its job.
 */
import { createHash } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export type RuleTier = "strong" | "heuristic"

export interface RulePattern {
  /** Stable per rule: the issuer or the carrier. Reported back as `rule/pattern`. */
  id: string
  source: string
}

export interface Rule {
  /** The check_id — `entity_*` for a built-in, `custom_entity_<key>` for the org's own. */
  id: string
  category: string
  severity: "critical" | "high" | "medium" | "low"
  tier: RuleTier
  flags: string
  patterns: RulePattern[]
  /** 1-based capturing group that IS the span; absent/null ⇒ the whole match. */
  group?: number | null
  examples: { match: string[]; nomatch: string[] }
}

export interface Ruleset {
  /** `rs_` + a content hash; what the plugin reports back, never recomputed here. */
  id: string
  generated_at: string
  family: string
  dialect: string
  rules: Rule[]
}

export interface CompiledPattern {
  id: string
  re: RegExp
}

export interface CompiledRule {
  id: string
  category: string
  tier: RuleTier
  group: number | undefined
  patterns: CompiledPattern[]
}

export interface DisabledRule {
  id: string
  reason: string
}

export interface CompiledRuleset {
  id: string
  dialect: string
  /** Rules that compiled AND passed their own examples, in served order. */
  rules: CompiledRule[]
  /** Rules switched off at load, each with the reason — logged, never silent. */
  disabled: DisabledRule[]
  /** Rules outside the requested tiers; not a failure. */
  skipped: string[]
}

export const DEFAULT_TIERS: readonly RuleTier[] = ["strong", "heuristic"]

export interface Span {
  start: number
  end: number
}

/**
 * Every span one compiled rule claims in `text`: for each pattern, every
 * global match, the span being the named group when the rule has one and
 * the whole match otherwise. Zero-length spans are never claimed.
 */
export function ruleSpans(rule: CompiledRule, text: string): Array<Span & { pattern: string }> {
  const out: Array<Span & { pattern: string }> = []
  for (const p of rule.patterns) {
    p.re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = p.re.exec(text)) !== null) {
      if (m[0].length === 0) {
        p.re.lastIndex += 1
        continue
      }
      let span: Span | undefined
      if (rule.group !== undefined) {
        const g = m.indices?.[rule.group]
        if (g) span = { start: g[0], end: g[1] }
      } else {
        span = { start: m.index, end: m.index + m[0].length }
      }
      if (span && span.end > span.start) out.push({ ...span, pattern: p.id })
    }
  }
  return out
}

/** A rule's flags as this engine needs them: the served flags + `g` (+ `d` when a group names the span). */
function engineFlags(rule: Rule): string {
  const wanted = new Set(rule.flags.split(""))
  wanted.add("g")
  if (rule.group) wanted.add("d")
  return [...wanted].join("")
}

/**
 * Compile a served ruleset for this engine and run every rule's own
 * examples. A rule that does not compile, or whose `match` examples yield no
 * span, or whose `nomatch` examples yield one, is DISABLED by id with the
 * reason — the rest run. Rules outside `tiers` are skipped (default: both).
 */
export function compileRuleset(
  ruleset: Ruleset,
  opts: { tiers?: readonly RuleTier[]; log?: (message: string) => void } = {},
): CompiledRuleset {
  const tiers = new Set(opts.tiers ?? DEFAULT_TIERS)
  const rules: CompiledRule[] = []
  const disabled: DisabledRule[] = []
  const skipped: string[] = []
  for (const rule of ruleset.rules) {
    if (!tiers.has(rule.tier)) {
      skipped.push(rule.id)
      continue
    }
    const group = rule.group ? rule.group : undefined
    const patterns: CompiledPattern[] = []
    let failure: string | null = null
    for (const p of rule.patterns) {
      try {
        patterns.push({ id: p.id, re: new RegExp(p.source, engineFlags(rule)) })
      } catch (err) {
        failure = `pattern ${p.id} does not compile: ${String(err)}`
        break
      }
    }
    const compiled: CompiledRule = { id: rule.id, category: rule.category, tier: rule.tier, group, patterns }
    if (!failure) failure = verifyExamples(compiled, rule.examples)
    if (failure) {
      disabled.push({ id: rule.id, reason: failure })
      opts.log?.(`[openguardrails] local redaction: rule ${rule.id} disabled — ${failure}`)
      continue
    }
    rules.push(compiled)
  }
  return { id: ruleset.id, dialect: ruleset.dialect, rules, disabled, skipped }
}

function verifyExamples(rule: CompiledRule, examples: Rule["examples"] | undefined): string | null {
  for (const text of examples?.match ?? []) {
    if (ruleSpans(rule, text).length === 0) return `match example yielded no span: ${JSON.stringify(text)}`
  }
  for (const text of examples?.nomatch ?? []) {
    if (ruleSpans(rule, text).length > 0) return `nomatch example yielded a span: ${JSON.stringify(text)}`
  }
  return null
}

// ---- the feed and its cache ---------------------------------------------------

export interface LoadOptions {
  /** Runtime base URL — a mounted prefix belongs in it, exactly as for `/v1/evaluate`. */
  runtimeUrl: string
  apiKey: string
  /** Where the ruleset is cached; default {@link defaultCachePath}. */
  cachePath?: string
  /** Injected for tests; default `globalThis.fetch`. */
  fetch?: typeof fetch
  timeoutMs?: number
}

export interface LoadResult {
  ruleset: Ruleset | null
  /** `fetched` — a new body; `cached` — the cache (304, or the fetch failed); `none` — nothing anywhere. */
  source: "fetched" | "cached" | "none"
  /** Why the fetch did not produce a body, when it did not. */
  error?: string
}

/** `~/.openguardrails/rules-<sha256(runtimeUrl)[:8]>.json` — one cache per runtime. */
export function defaultCachePath(runtimeUrl: string): string {
  const key = createHash("sha256").update(runtimeUrl).digest("hex").slice(0, 8)
  return join(homedir(), ".openguardrails", `rules-${key}.json`)
}

/** Read a cached ruleset, tolerating absence and corruption (both ⇒ null). */
export function readCachedRuleset(cachePath: string): Ruleset | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(cachePath, "utf8"))
    return isRuleset(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Atomic, private write: the directory is created 0700, the file lands at
 * 0600 through a rename from a sibling temp file. The customer's own machine
 * already holds the obfuscated image; what the cache keeps the rules from is
 * a world-readable home directory, not the customer.
 */
export function writeCachedRuleset(cachePath: string, ruleset: Ruleset): void {
  mkdirSync(dirname(cachePath), { recursive: true, mode: 0o700 })
  const tmp = `${cachePath}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, JSON.stringify(ruleset), { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, cachePath)
}

function isRuleset(x: unknown): x is Ruleset {
  if (typeof x !== "object" || x === null) return false
  const r = x as Record<string, unknown>
  return typeof r["id"] === "string" && r["id"].length > 0 && Array.isArray(r["rules"])
}

/**
 * `GET /v1/rules` with the org key. Sends `If-None-Match` from the cached id
 * and keeps the cache on 304; a 200 body replaces it (written atomically at
 * 0600). Any failure — network, 4xx/5xx, a malformed body — answers with
 * the cache when there is one and `none` when there is not; it never throws.
 */
export async function loadRuleset(opts: LoadOptions): Promise<LoadResult> {
  const cachePath = opts.cachePath ?? defaultCachePath(opts.runtimeUrl)
  const cached = readCachedRuleset(cachePath)
  const fetchImpl = opts.fetch ?? globalThis.fetch
  const base = opts.runtimeUrl.endsWith("/") ? opts.runtimeUrl.slice(0, -1) : opts.runtimeUrl
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5000)
  try {
    const headers: Record<string, string> = { authorization: `Bearer ${opts.apiKey}`, accept: "application/json" }
    if (cached) headers["if-none-match"] = `"${cached.id}"`
    const res = await fetchImpl(`${base}/v1/rules`, { method: "GET", headers, signal: controller.signal })
    if (res.status === 304 && cached) return { ruleset: cached, source: "cached" }
    if (!res.ok) {
      return { ruleset: cached, source: cached ? "cached" : "none", error: `rules answered ${res.status}` }
    }
    const body = (await res.json()) as { ruleset?: unknown }
    const ruleset = body?.ruleset
    if (!isRuleset(ruleset)) {
      return { ruleset: cached, source: cached ? "cached" : "none", error: "rules answered a body without a ruleset" }
    }
    try {
      writeCachedRuleset(cachePath, ruleset)
    } catch (err) {
      // A cache that cannot be written is a slower next start, not a failure to mask.
      return { ruleset, source: "fetched", error: `cache not written: ${String(err)}` }
    }
    return { ruleset, source: "fetched" }
  } catch (err) {
    return { ruleset: cached, source: cached ? "cached" : "none", error: `rules fetch failed: ${String(err)}` }
  } finally {
    clearTimeout(timer)
  }
}
