/** Masking what is sent to the model API. It never comes back, so a labelled stub is enough. */
import { readFileSync } from "node:fs";
import { compileRuleset, ruleSpans, type CompiledRuleset, type Ruleset } from "../redaction/ruleset.js";

// From dist/src/secrets/mask.js up to the package root.
const RULES_URL = new URL("../../../rules/secrets.json", import.meta.url);

export const loadRuleset = (): Ruleset => JSON.parse(readFileSync(RULES_URL, "utf8")) as Ruleset;

let compiled: CompiledRuleset | undefined;
export function compiledRules(): CompiledRuleset {
  compiled ??= compileRuleset(loadRuleset());
  return compiled;
}

export function maskText(text: string): string {
  const spans = compiledRules().rules.flatMap((rule) => ruleSpans(rule, text).map((span) => ({ ...span, rule: rule.id })));
  // Longest first, so a span inside a longer one is dropped; then applied from the end backwards.
  const kept: typeof spans = [];
  for (const span of spans.sort((a, b) => b.end - b.start - (a.end - a.start))) {
    if (!kept.some((other) => span.start < other.end && other.start < span.end)) kept.push(span);
  }
  let out = text;
  for (const span of kept.sort((a, b) => b.start - a.start)) {
    out = `${out.slice(0, span.start)}[REDACTED:${span.rule}]${out.slice(span.end)}`;
  }
  return out;
}

/** Every string leaf of a JSON value. Keys stay, since they are structure. */
export function maskDeep<T>(value: T): T {
  if (typeof value === "string") return maskText(value) as T;
  if (Array.isArray(value)) return value.map(maskDeep) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskDeep(item)])) as T;
  }
  return value;
}
