/**
 * AI Security Gateway - Content sanitizer
 *
 * Recursively processes message structures, replaces sensitive data with
 * numbered placeholders, and returns a mapping table for restoration.
 */

import type { SanitizeResult, MappingTable, EntityMatch } from "./types.js";

// =============================================================================
// Entity Definitions
// =============================================================================

type Entity = {
  category: string;
  categoryKey: string; // Used for numbered placeholders: __email_1__, __email_2__
  pattern: RegExp;
};

const ENTITIES: Entity[] = [
  // URLs (must come before email to avoid partial matches)
  {
    category: "URL",
    categoryKey: "url",
    pattern: /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g,
  },
  // Email
  {
    category: "EMAIL",
    categoryKey: "email",
    pattern: /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g,
  },
  // Credit Card (4 groups of 4 digits)
  {
    category: "CREDIT_CARD",
    categoryKey: "credit_card",
    pattern: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g,
  },
  // Bank Card (Chinese format: 16-19 digits)
  {
    category: "BANK_CARD",
    categoryKey: "bank_card",
    pattern: /\b\d{16,19}\b/g,
  },
  // SSN (###-##-####)
  {
    category: "SSN",
    categoryKey: "ssn",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
  },
  // IBAN
  {
    category: "IBAN",
    categoryKey: "iban",
    pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{4}\d{7}[A-Z0-9]{0,16}\b/g,
  },
  // IP Address
  {
    category: "IP_ADDRESS",
    categoryKey: "ip",
    pattern: /\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/g,
  },
  // Phone numbers (US/intl formats, including +86-xxx-xxxx-xxxx)
  // Anchored with \b and uses non-optional country code to avoid catastrophic backtracking
  {
    category: "PHONE",
    categoryKey: "phone",
    pattern: /\b[+]?[0-9]{1,3}[-\s.]?[(]?[0-9]{3}[)]?[-\s.][0-9]{3,4}[-\s.][0-9]{4,6}\b/g,
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

function collectMatches(content: string): EntityMatch[] {
  const matches: EntityMatch[] = [];

  // Regex-based entities
  for (const entity of ENTITIES) {
    entity.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = entity.pattern.exec(content)) !== null) {
      matches.push({
        originalText: m[0],
        category: entity.categoryKey,
        placeholder: "", // Will be set later with numbering
      });
    }
  }

  // Secret prefixes
  SECRET_PREFIX_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SECRET_PREFIX_PATTERN.exec(content)) !== null) {
    matches.push({
      originalText: m[0],
      category: "secret",
      placeholder: "",
    });
  }

  // Bearer tokens
  BEARER_PATTERN.lastIndex = 0;
  while ((m = BEARER_PATTERN.exec(content)) !== null) {
    matches.push({
      originalText: m[0],
      category: "secret",
      placeholder: "",
    });
  }

  // High-entropy tokens
  const tokenPattern = /\b[A-Za-z0-9\-_.~+/]{20,}={0,3}\b/g;
  tokenPattern.lastIndex = 0;
  while ((m = tokenPattern.exec(content)) !== null) {
    const token = m[0];
    if (matches.some((existing) => existing.originalText === token)) continue;
    if (/^[a-z]+$/.test(token)) continue;
    if (shannonEntropy(token) >= 4.0) {
      matches.push({
        originalText: token,
        category: "secret",
        placeholder: "",
      });
    }
  }

  return matches;
}

// =============================================================================
// Text Sanitization
// =============================================================================

function sanitizeText(
  text: string,
  mappingTable: MappingTable,
  categoryCounters: Map<string, number>,
): string {
  const matches = collectMatches(text);
  if (matches.length === 0) return text;

  // Deduplicate by original text
  const unique = new Map<string, EntityMatch>();
  for (const match of matches) {
    if (!unique.has(match.originalText)) {
      unique.set(match.originalText, match);
    }
  }

  // Sort by length descending
  const sorted = [...unique.values()].sort(
    (a, b) => b.originalText.length - a.originalText.length,
  );

  // Replace and build mapping table
  let sanitized = text;
  for (const match of sorted) {
    // Generate numbered placeholder
    const counter = (categoryCounters.get(match.category) ?? 0) + 1;
    categoryCounters.set(match.category, counter);
    const placeholder = `__${match.category}_${counter}__`;

    // Replace all occurrences
    const parts = sanitized.split(match.originalText);
    if (parts.length > 1) {
      sanitized = parts.join(placeholder);
      mappingTable.set(placeholder, match.originalText);
    }
  }

  return sanitized;
}

// =============================================================================
// Recursive Sanitization
// =============================================================================

/**
 * Recursively sanitize any value (string, object, array)
 */
function sanitizeValue(
  value: any,
  mappingTable: MappingTable,
  categoryCounters: Map<string, number>,
): any {
  // String: sanitize directly
  if (typeof value === "string") {
    return sanitizeText(value, mappingTable, categoryCounters);
  }

  // Array: sanitize each element
  if (Array.isArray(value)) {
    return value.map((item) =>
      sanitizeValue(item, mappingTable, categoryCounters),
    );
  }

  // Object: sanitize each property
  if (value !== null && typeof value === "object") {
    const sanitized: any = {};
    for (const [key, val] of Object.entries(value)) {
      sanitized[key] = sanitizeValue(val, mappingTable, categoryCounters);
    }
    return sanitized;
  }

  // Primitives: return as-is
  return value;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Sanitize any content (messages array, object, string)
 * Returns sanitized content and mapping table for restoration
 */
export function sanitize(content: any): SanitizeResult {
  const mappingTable: MappingTable = new Map();
  const categoryCounters = new Map<string, number>();

  const sanitized = sanitizeValue(content, mappingTable, categoryCounters);

  return {
    sanitized,
    mappingTable,
    redactionCount: mappingTable.size,
  };
}

/**
 * Sanitize messages array (common case for LLM APIs)
 */
export function sanitizeMessages(messages: any[]): SanitizeResult {
  return sanitize(messages);
}
