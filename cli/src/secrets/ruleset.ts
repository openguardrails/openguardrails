/** Compiling and verifying the secret ruleset. Copied from integrations/agent/local-redaction, which has the full argument. */
import { type CompiledReject, type ValueRule, compileRejects, valueRejected } from "./predicates.js"

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
  /**
   * ⚠️⚠️ **WHAT THIS RULE REFUSES TO CALL A CREDENTIAL** (OGR 1.4, served since
   * 2026-09-06). Applied to the SPAN after the pattern matches — see `predicates.ts`
   * for why ignoring it is not the safe direction it looks like. Absent ⇒ nothing is
   * refused, which is every rule written before the field existed.
   */
  reject_value?: ValueRule[]
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
  /** The rule's `reject_value`, compiled; empty when it declared none. */
  rejects: CompiledReject[]
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
      if (!span || span.end <= span.start) continue
      // ⚠️ The filters ask about the VALUE, so they run on the SPAN — the group where
      // one is declared — never on the whole match: `Authorization: bearer` is not the
      // value. Same position as the runtime's `EntityDetector`.
      if (rule.rejects.length > 0 && valueRejected(text.slice(span.start, span.end), rule.rejects)) {
        continue
      }
      out.push({ ...span, pattern: p.id })
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
    // ⚠️ A filter this engine cannot evaluate is a rule it must not run — reading an
    // unknown predicate as "no filter" would mask far more than the runtime calls a
    // credential. `predicates.ts` carries the argument.
    const rejects = compileRejects(rule.reject_value, rule.id)
    if ("reason" in rejects && !failure) failure = rejects.reason
    const compiled: CompiledRule = {
      id: rule.id,
      category: rule.category,
      tier: rule.tier,
      group,
      patterns,
      rejects: "rejects" in rejects ? rejects.rejects : [],
    }
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
