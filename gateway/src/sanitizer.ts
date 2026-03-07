/**
 * AI Security Gateway - Content Sanitizer
 *
 * Sanitizes sensitive data in a single request-response cycle.
 * Placeholder format: __PII_<ENTITY_TYPE>_<SERIAL_ID>__
 */

import type { SanitizeResult, MappingTable } from "./types.js";

// =============================================================================
// Entity Types
// =============================================================================

type EntityType =
  | "EMAIL_ADDRESS"
  | "URL_ADDRESS"
  | "PHONE_NUMBER"
  | "BANK_NUMBER"
  | "PRIVATE_KEY"
  | "PASSWORD"
  | "VERIFICATION_CODE"
  | "API_KEY"
  | "IP_ADDRESS"
  | "SSN"
  | "CREDIT_CARD";

type EntityPattern = {
  type: EntityType;
  pattern: RegExp;
  score: number;
  captureGroup?: number;
};

// =============================================================================
// Detection Patterns
// =============================================================================

const ENTITY_PATTERNS: EntityPattern[] = [
  // PEM Private Keys
  {
    type: "PRIVATE_KEY",
    pattern: /-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----/g,
    score: 0.95,
  },
  // Email addresses
  {
    type: "EMAIL_ADDRESS",
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    score: 0.90,
  },
  // URLs
  {
    type: "URL_ADDRESS",
    pattern: /https?:\/\/[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]+/g,
    score: 0.80,
  },
  // Known API key prefixes
  {
    type: "API_KEY",
    pattern: /\b(?:sk-[A-Za-z0-9]{20,}|sk_(?:live|test)_[A-Za-z0-9]{20,}|pk_(?:live|test)_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36,}|gho_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]+|SG\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|hf_[A-Za-z0-9]{30,})\b/g,
    score: 0.90,
  },
  // Bearer tokens
  {
    type: "API_KEY",
    pattern: /Bearer\s+[A-Za-z0-9\-_.~+/]{20,}={0,3}/g,
    score: 0.85,
  },
  // Hex private keys (64 hex chars)
  {
    type: "PRIVATE_KEY",
    pattern: /\b[0-9a-fA-F]{64}\b/g,
    score: 0.75,
  },
  // Labeled password patterns
  {
    type: "PASSWORD",
    pattern: /(?:password|passwd|pwd|pass|passcode)\s*[:=]\s*["']?(\S+)["']?/gi,
    score: 0.80,
    captureGroup: 1,
  },
  // Labeled API key patterns
  {
    type: "API_KEY",
    pattern: /(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*["']?([A-Za-z0-9\-_.~+/]{16,})["']?/gi,
    score: 0.85,
    captureGroup: 1,
  },
  // Phone numbers
  {
    type: "PHONE_NUMBER",
    pattern: /\+?\d{1,3}[-.\s]?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}/g,
    score: 0.70,
  },
  // Credit card numbers
  {
    type: "CREDIT_CARD",
    pattern: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g,
    score: 0.85,
  },
  // Bank account numbers
  {
    type: "BANK_NUMBER",
    pattern: /\b\d{12,19}\b/g,
    score: 0.60,
  },
  // SSN
  {
    type: "SSN",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    score: 0.85,
  },
  // IP addresses
  {
    type: "IP_ADDRESS",
    pattern: /\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g,
    score: 0.70,
  },
  // Labeled verification codes
  {
    type: "VERIFICATION_CODE",
    pattern: /(?:verification\s*code|verify\s*code|otp|2fa\s*code|auth(?:entication)?\s*code)\s*[:=\-]?\s*([A-Za-z0-9]{4,12})/gi,
    score: 0.80,
    captureGroup: 1,
  },
];

// =============================================================================
// Match Collection
// =============================================================================

type MatchWithMeta = {
  originalText: string;
  type: EntityType;
  score: number;
  start: number;
  end: number;
};

function collectMatches(content: string): MatchWithMeta[] {
  const matches: MatchWithMeta[] = [];

  for (const entity of ENTITY_PATTERNS) {
    entity.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;

    while ((m = entity.pattern.exec(content)) !== null) {
      let matchedText: string;
      let start: number;

      if (entity.captureGroup !== undefined && m[entity.captureGroup]) {
        matchedText = m[entity.captureGroup];
        start = m.index + m[0].indexOf(matchedText);
      } else {
        matchedText = m[0];
        start = m.index;
      }

      matches.push({
        originalText: matchedText,
        type: entity.type,
        score: entity.score,
        start,
        end: start + matchedText.length,
      });
    }
  }

  return matches;
}

// =============================================================================
// Span Merging
// =============================================================================

function mergeSpans(matches: MatchWithMeta[]): MatchWithMeta[] {
  if (matches.length === 0) return [];

  matches.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    const lenDiff = (b.end - b.start) - (a.end - a.start);
    if (lenDiff !== 0) return lenDiff;
    return b.score - a.score;
  });

  const merged: MatchWithMeta[] = [];
  let current = matches[0];

  for (let i = 1; i < matches.length; i++) {
    const next = matches[i];
    if (next.start < current.end) {
      const currentLen = current.end - current.start;
      const nextLen = next.end - next.start;
      if (next.score > current.score || (next.score === current.score && nextLen > currentLen)) {
        current = next;
      }
    } else {
      merged.push(current);
      current = next;
    }
  }

  merged.push(current);
  return merged;
}

// =============================================================================
// Text Sanitization
// =============================================================================

function sanitizeText(
  text: string,
  mappingTable: MappingTable,
  typeCounters: Map<EntityType, number>,
): string {
  const matches = collectMatches(text);
  if (matches.length === 0) return text;

  const merged = mergeSpans(matches);
  const textToPlaceholder = new Map<string, string>();

  for (const match of merged) {
    if (!textToPlaceholder.has(match.originalText)) {
      const counter = (typeCounters.get(match.type) ?? 0) + 1;
      typeCounters.set(match.type, counter);
      const paddedId = counter.toString().padStart(8, "0");
      const placeholder = `__PII_${match.type}_${paddedId}__`;
      textToPlaceholder.set(match.originalText, placeholder);
      mappingTable.set(placeholder, match.originalText);
    }
  }

  let sanitized = text;
  const sortedMatches = [...merged].sort((a, b) => b.start - a.start);

  for (const match of sortedMatches) {
    const placeholder = textToPlaceholder.get(match.originalText)!;
    sanitized = sanitized.slice(0, match.start) + placeholder + sanitized.slice(match.end);
  }

  return sanitized;
}

// =============================================================================
// Recursive Sanitization
// =============================================================================

function sanitizeValue(
  value: unknown,
  mappingTable: MappingTable,
  typeCounters: Map<EntityType, number>,
): unknown {
  if (typeof value === "string") {
    return sanitizeText(value, mappingTable, typeCounters);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, mappingTable, typeCounters));
  }

  if (value !== null && typeof value === "object") {
    const sanitized: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      sanitized[key] = sanitizeValue(val, mappingTable, typeCounters);
    }
    return sanitized;
  }

  return value;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Sanitize any content (messages array, object, string)
 * Returns sanitized content and mapping table for restoration
 */
export function sanitize(content: unknown): SanitizeResult {
  const mappingTable: MappingTable = new Map();
  const typeCounters = new Map<EntityType, number>();

  const sanitized = sanitizeValue(content, mappingTable, typeCounters);

  return {
    sanitized,
    mappingTable,
    redactionCount: mappingTable.size,
  };
}

/**
 * Sanitize messages array (common case for LLM APIs)
 */
export function sanitizeMessages(messages: unknown[]): SanitizeResult {
  return sanitize(messages);
}
