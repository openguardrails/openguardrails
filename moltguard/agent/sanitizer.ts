/**
 * Local content sanitizer — strips PII and secrets before sending to API.
 *
 * Inspired by n8n's guardrails implementation (MIT).
 * Replaces sensitive data with category placeholders while preserving
 * the structure and context needed for injection detection.
 */

import type { SanitizeResult } from "./types.js";

// =============================================================================
// Entity Definitions
// =============================================================================

type Entity = {
  category: string;
  placeholder: string;
  pattern: RegExp;
};

const ENTITIES: Entity[] = [
  // URLs (must come before email to avoid partial matches on domain parts)
  {
    category: "URL",
    placeholder: "<URL>",
    pattern: /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g,
  },
  // Email
  {
    category: "EMAIL",
    placeholder: "<EMAIL>",
    pattern: /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g,
  },
  // Credit Card (4 groups of 4 digits)
  {
    category: "CREDIT_CARD",
    placeholder: "<CREDIT_CARD>",
    pattern: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g,
  },
  // SSN (###-##-####)
  {
    category: "SSN",
    placeholder: "<SSN>",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
  },
  // IBAN
  {
    category: "IBAN",
    placeholder: "<IBAN>",
    pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{4}\d{7}[A-Z0-9]{0,16}\b/g,
  },
  // IP Address
  {
    category: "IP_ADDRESS",
    placeholder: "<IP_ADDRESS>",
    pattern: /\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/g,
  },
  // Phone numbers (US/intl formats)
  {
    category: "PHONE",
    placeholder: "<PHONE>",
    pattern: /[+]?[(]?[0-9]{3}[)]?[-\s.][0-9]{3}[-\s.][0-9]{4,6}\b/g,
  },
];

// Known secret prefixes
const SECRET_PREFIXES = [
  "sk-",
  "sk_",
  "pk_",
  "ghp_",
  "AKIA",
  "xox",
  "SG.",
  "hf_",
  "api-",
  "token-",
  "secret-",
];

const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9\-_.~+/]+=*/g;

// Secret-like tokens: known prefix followed by alphanumeric/special chars
const SECRET_PREFIX_PATTERN = new RegExp(
  `(?:${SECRET_PREFIXES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})[A-Za-z0-9\\-_.~+/]{8,}=*`,
  "g",
);

// =============================================================================
// Shannon Entropy
// =============================================================================

function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) {
    freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

// =============================================================================
// Match Collection
// =============================================================================

type Match = {
  text: string;
  category: string;
  placeholder: string;
};

function collectMatches(content: string): Match[] {
  const matches: Match[] = [];

  // Regex-based entities
  for (const entity of ENTITIES) {
    // Reset lastIndex for global regexes
    entity.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = entity.pattern.exec(content)) !== null) {
      matches.push({
        text: m[0],
        category: entity.category,
        placeholder: entity.placeholder,
      });
    }
  }

  // Secret prefixes
  SECRET_PREFIX_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SECRET_PREFIX_PATTERN.exec(content)) !== null) {
    matches.push({
      text: m[0],
      category: "SECRET",
      placeholder: "<SECRET>",
    });
  }

  // Bearer tokens
  BEARER_PATTERN.lastIndex = 0;
  while ((m = BEARER_PATTERN.exec(content)) !== null) {
    matches.push({
      text: m[0],
      category: "SECRET",
      placeholder: "<SECRET>",
    });
  }

  // High-entropy tokens (catch API keys/secrets that don't have known prefixes)
  // Look for standalone tokens that look like secrets: 20+ chars, high entropy
  const tokenPattern = /\b[A-Za-z0-9\-_.~+/]{20,}={0,3}\b/g;
  tokenPattern.lastIndex = 0;
  while ((m = tokenPattern.exec(content)) !== null) {
    const token = m[0];
    // Skip if already matched by another pattern
    if (matches.some((existing) => existing.text === token)) continue;
    // Skip if it looks like a normal word (all lowercase alpha, no digits/special)
    if (/^[a-z]+$/.test(token)) continue;
    // High entropy threshold (typical for random keys/tokens)
    if (shannonEntropy(token) >= 4.0) {
      matches.push({
        text: token,
        category: "SECRET",
        placeholder: "<SECRET>",
      });
    }
  }

  return matches;
}

// =============================================================================
// Main Sanitizer
// =============================================================================

export function sanitizeContent(content: string): SanitizeResult {
  const matches = collectMatches(content);

  if (matches.length === 0) {
    return { sanitized: content, redactions: {}, totalRedactions: 0 };
  }

  // Deduplicate matches by text
  const unique = new Map<string, Match>();
  for (const match of matches) {
    // Keep the first match for each text (preserves priority from entity order)
    if (!unique.has(match.text)) {
      unique.set(match.text, match);
    }
  }

  // Sort by length descending — prevents partial matches corrupting longer ones
  const sorted = [...unique.values()].sort(
    (a, b) => b.text.length - a.text.length,
  );

  // Replace using split/join — safe against regex special chars in matched text
  let sanitized = content;
  const redactions: Record<string, number> = {};

  for (const match of sorted) {
    const parts = sanitized.split(match.text);
    const count = parts.length - 1;
    if (count > 0) {
      sanitized = parts.join(match.placeholder);
      redactions[match.category] = (redactions[match.category] ?? 0) + count;
    }
  }

  const totalRedactions = Object.values(redactions).reduce((a, b) => a + b, 0);

  return { sanitized, redactions, totalRedactions };
}
