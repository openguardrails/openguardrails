/**
 * `reject_value` — what a rule refuses to call a credential (OGR 1.4,
 * specification/local-redaction.md §4.6).
 *
 * ⚠️⚠️ **A RULE IS ITS PATTERNS MINUS WHAT ITS FILTERS THROW AWAY.** A reader that
 * applies only the patterns is running a DIFFERENT rule from the one the runtime runs,
 * and it finds that out the hard way: several of the shipped rules carry `nomatch`
 * examples that only a filter can satisfy, and D9's answer to a failing example is to
 * DISABLE THE RULE BY NAME. That is not hypothetical — between 2026-09-01 and
 * 2026-09-06 the filters lived only inside AIRS, eight examples across
 * `password_assignment`, `url_credential` and `db_connection` were unsatisfiable from
 * the patterns alone, and those three rules — the ones most likely to carry a real
 * credential — switched themselves off on every host, silently, because a rule that
 * never fires looks exactly like a host with no secrets in its traffic.
 *
 * ⚠️ The vocabulary is CLOSED so that it can be ported: seven predicate kinds, two part
 * selectors, each a single bounded pass over the matched span, none backtracking. It is
 * not a language and must not become one. The normative reference implementation is
 * AIRS's `scripts/secret-rules-conformance.py`; this file and the hermes plugin's
 * `_value_rejected` are its two ports.
 *
 * ⚠️⚠️ **AN UNKNOWN PREDICATE KIND DISABLES THE RULE, and is never read as "no
 * filter".** Filters only ever make a rule match LESS, so skipping one silently masks
 * far more than the runtime calls a credential — and the value would then be restored
 * into a tool's arguments under a token nobody minted for it. `compileRejects` returns
 * the reason and `compileRuleset` treats it exactly like a failing example.
 */

/** A run of characters that means "somebody has not filled this in yet". */
const PLACEHOLDER_SHAPES = [
  "\\*{3,}",
  "x{3,}",
  "\\$\\{",
  "<",
  ">",
  "%[sd]",
  "\\.{3,}",
  "…",
  "changeme",
  "placeholder",
  "redacted",
  "your[_\\-]?password",
  "your[_\\-]",
  "example",
  "\\$",
]

/**
 * ⚠️ Both are needed. `password = changeme` is a placeholder at the START;
 * `https://oauth2:kqFb…BxxM@host` is a doc that removed a real token's MIDDLE, which
 * says just as loudly that the secret did not leak and is invisible to an anchored
 * test. Anchored is the default; `anywhere` is asked for where the rule means it.
 */
const PLACEHOLDER_RE = new RegExp(`^(?:${PLACEHOLDER_SHAPES.join("|")})`, "i")
const PLACEHOLDER_ANYWHERE_RE = new RegExp(`(?:${PLACEHOLDER_SHAPES.join("|")})`, "i")

/** Words that name a secret rather than being one (`password=password`). */
const SECRET_NOUNS =
  "password|passwd|pwd|secret|api[_\\-]?key|access[_\\-]?token|auth[_\\-]?token|" +
  "client[_\\-]?secret|refresh[_\\-]?token|id[_\\-]?token|session[_\\-]?token|" +
  "private[_\\-]?key|key[_\\-]?material|raw[_\\-]?secret|bearer|token"
const SECRET_NOUN_RE = new RegExp(`^(?:${SECRET_NOUNS})(?:[^A-Za-z0-9_]|$)`, "i")
const CONTAINS_SECRET_NOUN_RE = new RegExp(`(?:${SECRET_NOUNS})`, "i")

/** A dotted or indexed identifier — `config.api_key`, `os.environ["TOKEN"]`. */
const VARIABLE_REF_RE = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z0-9_$]+|\[[^\]]*\])+$/
/** An identifier that NAMES a secret — the conjunction no single pattern can express. */
const IDENT_ONLY_RE = /^[A-Za-z0-9_$.[\]"']+$/
const IDENT_PATH_MARK_RE = /[._[]/
/** A value that is only structure — brackets — is not a credential. */
const STRUCTURAL_RE = /[(){}]/

/** Longest value any predicate will look at; beyond it this is not a credential. */
const MAX_VALUE_CHARS = 4096

export type ValuePredicate =
  | { kind: "placeholder"; anywhere?: boolean }
  | { kind: "secret_noun" }
  | { kind: "variable_reference" }
  | { kind: "names_secret" }
  | { kind: "structural" }
  | { kind: "low_entropy"; min: number }
  | { kind: "matches"; pattern: string; flags?: string }

/** WHICH PART of the span a predicate is asked about; absent ⇒ the whole of it. */
export type ValuePart =
  | { of: "whole" }
  | { of: "after"; sep: string }
  | { of: "before"; sep: string }

export interface ValueRule {
  part?: ValuePart
  predicate: ValuePredicate
}

/** A rule's filters, with any `matches` pattern already compiled for this engine. */
export interface CompiledReject {
  part?: ValuePart
  predicate: ValuePredicate
  /** Present only for `matches`. */
  re?: RegExp
}

/**
 * Shannon entropy in bits per character — the one predicate regex cannot express at
 * all, and the reason this is a vocabulary rather than "lookahead in a string".
 */
export function shannonBits(value: string): number {
  if (!value) return 0
  const counts = new Map<string, number>()
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  let bits = 0
  for (const n of counts.values()) {
    const p = n / value.length
    bits -= p * Math.log2(p)
  }
  return bits
}

function partOf(value: string, part: ValuePart | undefined): string {
  if (!part || part.of === "whole") return value
  const i = value.indexOf(part.sep)
  if (i < 0) return value
  return part.of === "after" ? value.slice(i + part.sep.length) : value.slice(0, i)
}

/**
 * Compile a served rule's `reject_value`. Returns the filters, or a REASON — an
 * unknown predicate kind, a `matches` pattern this engine will not compile, a
 * malformed entry. The caller disables the rule; see the header.
 *
 * ⚠️ `g`/`y` are refused on a `matches` pattern: the test below is a bare `.test()`
 * and a global regex carries `lastIndex` between calls, so one would answer
 * differently on every other value it saw.
 */
export function compileRejects(
  raw: unknown,
  ruleId: string,
): { rejects: CompiledReject[] } | { reason: string } {
  if (raw === undefined || raw === null) return { rejects: [] }
  if (!Array.isArray(raw)) return { reason: "reject_value is not a list" }
  const out: CompiledReject[] = []
  for (const [i, entry] of raw.entries()) {
    if (typeof entry !== "object" || entry === null) {
      return { reason: `reject_value[${i}] is not an object` }
    }
    const rule = entry as { part?: unknown; predicate?: unknown }
    // ⚠️ Read as OPEN records, narrowed by hand. Typing them as the closed unions here
    // would make TypeScript exhaust them and leave `never` on the very branches whose
    // job is to answer for a value outside the union — i.e. the compiler would delete
    // the check that makes an unknown kind visible.
    const predRaw = rule.predicate as { kind?: unknown; [k: string]: unknown } | undefined
    if (typeof predRaw !== "object" || predRaw === null || typeof predRaw.kind !== "string") {
      return { reason: `reject_value[${i}] has no predicate` }
    }
    const kind = predRaw.kind
    const partRaw = rule.part as { of?: unknown; sep?: unknown } | undefined
    if (partRaw !== undefined) {
      if (typeof partRaw !== "object" || partRaw === null) {
        return { reason: `reject_value[${i}]: bad part` }
      }
      if (partRaw.of !== "whole" && partRaw.of !== "after" && partRaw.of !== "before") {
        return { reason: `reject_value[${i}]: unknown part ${String(partRaw.of)}` }
      }
      if (partRaw.of !== "whole" && typeof partRaw.sep !== "string") {
        return { reason: `reject_value[${i}]: part without a sep` }
      }
    }
    const part = partRaw as ValuePart | undefined
    const pred = predRaw as unknown as ValuePredicate
    switch (kind) {
      case "placeholder":
      case "secret_noun":
      case "variable_reference":
      case "names_secret":
      case "structural":
        out.push({ part, predicate: pred })
        break
      case "low_entropy": {
        const min = predRaw["min"]
        if (typeof min !== "number" || !Number.isFinite(min)) {
          return { reason: `reject_value[${i}]: low_entropy without a numeric min` }
        }
        out.push({ part, predicate: pred })
        break
      }
      case "matches": {
        const pattern = predRaw["pattern"]
        const flags = typeof predRaw["flags"] === "string" ? (predRaw["flags"] as string) : ""
        if (typeof pattern !== "string" || !pattern) {
          return { reason: `reject_value[${i}]: matches without a pattern` }
        }
        if (/[gy]/.test(flags)) return { reason: `reject_value[${i}]: matches may not be global` }
        try {
          out.push({ part, predicate: pred, re: new RegExp(pattern, flags) })
        } catch (err) {
          return { reason: `reject_value[${i}]: matches does not compile: ${String(err)}` }
        }
        break
      }
      default:
        // ⚠️ The whole point of the header: a filter this engine cannot evaluate is a
        // rule this engine must not run. `ruleId` so the log names it.
        return { reason: `reject_value[${i}]: unknown predicate ${kind} (rule ${ruleId})` }
    }
  }
  return { rejects: out }
}

/**
 * Does any filter REJECT this span? Rules are ANDed as "reject if any fires", so an
 * absent filter can only ever make a rule match MORE — which is why an unevaluable one
 * is a disabled rule rather than a skipped line.
 */
export function valueRejected(value: string, rejects: readonly CompiledReject[]): boolean {
  if (rejects.length === 0) return false
  const bounded = value.length > MAX_VALUE_CHARS ? value.slice(0, MAX_VALUE_CHARS) : value
  for (const rule of rejects) {
    const target = partOf(bounded, rule.part)
    const pred = rule.predicate
    switch (pred.kind) {
      case "placeholder":
        if ((pred.anywhere ? PLACEHOLDER_ANYWHERE_RE : PLACEHOLDER_RE).test(target)) return true
        break
      case "secret_noun":
        if (SECRET_NOUN_RE.test(target)) return true
        break
      case "variable_reference":
        if (VARIABLE_REF_RE.test(target)) return true
        break
      case "names_secret":
        if (
          IDENT_ONLY_RE.test(target) &&
          IDENT_PATH_MARK_RE.test(target) &&
          CONTAINS_SECRET_NOUN_RE.test(target)
        ) {
          return true
        }
        break
      case "structural":
        if (STRUCTURAL_RE.test(target)) return true
        break
      case "low_entropy":
        if (shannonBits(target) < pred.min) return true
        break
      case "matches":
        if (rule.re?.test(target)) return true
        break
    }
  }
  return false
}
