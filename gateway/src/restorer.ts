/**
 * AI Security Gateway - Content Restorer
 *
 * Restores sanitized placeholders back to original values.
 * Handles LLM corruption patterns (missing underscores, case variations).
 *
 * Placeholder format: __PII_<ENTITY_TYPE>_<SERIAL_ID>__
 */

import type { MappingTable } from "./types.js";

/**
 * Build a map from placeholder patterns to original values
 * Handles variations that LLMs might produce
 */
function buildRestorationMap(mappingTable: MappingTable): Map<RegExp, string> {
  const restorationMap = new Map<RegExp, string>();

  for (const [placeholder, originalValue] of mappingTable.entries()) {
    // Extract the core pattern from placeholder like __PII_EMAIL_ADDRESS_00000001__
    const match = placeholder.match(/^__PII_([A-Z_]+)_(\d+)__$/);
    if (!match) {
      // Fallback: exact match only
      restorationMap.set(new RegExp(escapeRegex(placeholder), "g"), originalValue);
      continue;
    }

    const entityType = match[1];
    const serialId = match[2];

    // Create flexible pattern that handles LLM corruption:
    // - Missing leading/trailing underscores
    // - Case variations
    // - Extra spaces
    const flexiblePattern = new RegExp(
      `_?_?PII[_\\s]*${entityType}[_\\s]*${serialId}_?_?`,
      "gi"
    );

    restorationMap.set(flexiblePattern, originalValue);
  }

  return restorationMap;
}

/**
 * Escape special regex characters
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Restore placeholders in a string
 */
function restoreText(text: string, mappingTable: MappingTable): string {
  if (mappingTable.size === 0) return text;

  let restored = text;

  // First pass: exact matches (fastest)
  for (const [placeholder, originalValue] of mappingTable.entries()) {
    if (restored.includes(placeholder)) {
      restored = restored.split(placeholder).join(originalValue);
    }
  }

  // Second pass: flexible patterns for LLM corruption
  const restorationMap = buildRestorationMap(mappingTable);
  for (const [pattern, originalValue] of restorationMap.entries()) {
    restored = restored.replace(pattern, originalValue);
  }

  // Third pass: handle "leaked ID suffix" pattern
  // LLM might output: "original_value_00000001" instead of just "original_value"
  for (const [placeholder, originalValue] of mappingTable.entries()) {
    const match = placeholder.match(/^__PII_[A-Z_]+_(\d+)__$/);
    if (match) {
      const serialId = match[1];
      // Pattern: original value followed by underscore and serial ID
      const leakedPattern = new RegExp(
        escapeRegex(originalValue) + `[_\\s]*${serialId}`,
        "g"
      );
      restored = restored.replace(leakedPattern, originalValue);
    }
  }

  return restored;
}

/**
 * Recursively restore any value (string, object, array)
 */
function restoreValue(value: unknown, mappingTable: MappingTable): unknown {
  if (typeof value === "string") {
    return restoreText(value, mappingTable);
  }

  if (Array.isArray(value)) {
    return value.map((item) => restoreValue(item, mappingTable));
  }

  if (value !== null && typeof value === "object") {
    const restored: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      restored[key] = restoreValue(val, mappingTable);
    }
    return restored;
  }

  return value;
}

/**
 * Restore any content (object, array, string) using the mapping table
 */
export function restore(content: unknown, mappingTable: MappingTable): unknown {
  if (mappingTable.size === 0) return content;
  return restoreValue(content, mappingTable);
}

/**
 * Restore a JSON string
 * Useful for SSE streaming where each chunk is a JSON string
 */
export function restoreJSON(jsonString: string, mappingTable: MappingTable): string {
  if (mappingTable.size === 0) return jsonString;

  try {
    const parsed = JSON.parse(jsonString);
    const restored = restore(parsed, mappingTable);
    return JSON.stringify(restored);
  } catch {
    // If not valid JSON, treat as plain text
    return restoreText(jsonString, mappingTable);
  }
}

/**
 * Restore SSE data line (for streaming responses)
 * Format: "data: {...}\n"
 */
export function restoreSSELine(line: string, mappingTable: MappingTable): string {
  if (mappingTable.size === 0) return line;
  if (!line.startsWith("data: ")) return line;

  const dataContent = line.slice(6); // Remove "data: " prefix
  if (dataContent === "[DONE]") return line;

  try {
    const parsed = JSON.parse(dataContent);
    const restored = restore(parsed, mappingTable);
    return `data: ${JSON.stringify(restored)}`;
  } catch {
    // Fallback to text restoration
    return `data: ${restoreText(dataContent, mappingTable)}`;
  }
}

// =============================================================================
// Streaming Restoration with Smart Buffering
// =============================================================================

// Max placeholder length: __PII_VERIFICATION_CODE_00000001__ ≈ 40 chars
const MAX_PLACEHOLDER_LENGTH = 50;

// Pattern to match complete placeholders
const PLACEHOLDER_PATTERN = /__PII_[A-Z_]+_\d{8}__/g;

/**
 * StreamRestorer - Stateful streaming restoration with smart buffering
 *
 * Only buffers when `__` is detected (potential placeholder start).
 * Otherwise streams through immediately for best UX.
 */
export class StreamRestorer {
  private buffer: string = "";
  private mappingTable: MappingTable;

  constructor(mappingTable: MappingTable) {
    this.mappingTable = mappingTable;
  }

  /**
   * Process incoming text chunk
   * Returns text that can be safely output (already restored or confirmed non-placeholder)
   */
  process(chunk: string): string {
    // If no mappings, pass through directly
    if (this.mappingTable.size === 0) {
      return chunk;
    }

    this.buffer += chunk;
    return this.flush();
  }

  /**
   * Flush what we can safely output
   * Keeps potential incomplete placeholders in buffer
   */
  private flush(): string {
    let output = "";

    while (this.buffer.length > 0) {
      // Find position of `__` in buffer
      const underscorePos = this.buffer.indexOf("__");

      if (underscorePos === -1) {
        // No `__` found - check if buffer ends with single `_`
        if (this.buffer.endsWith("_")) {
          // Keep the trailing `_` in case next chunk starts with `_`
          output += this.buffer.slice(0, -1);
          this.buffer = "_";
        } else {
          // Safe to output entire buffer
          output += this.buffer;
          this.buffer = "";
        }
        break;
      }

      // Output everything before the `__`
      if (underscorePos > 0) {
        output += this.buffer.slice(0, underscorePos);
        this.buffer = this.buffer.slice(underscorePos);
      }

      // Now buffer starts with `__`
      // Check if we have a complete placeholder
      PLACEHOLDER_PATTERN.lastIndex = 0;
      const match = PLACEHOLDER_PATTERN.exec(this.buffer);

      if (match && match.index === 0) {
        // Found complete placeholder at start of buffer
        const placeholder = match[0];
        const original = this.mappingTable.get(placeholder);

        if (original) {
          // Restore and output
          output += original;
        } else {
          // Not in mapping table, output as-is
          output += placeholder;
        }

        this.buffer = this.buffer.slice(placeholder.length);
      } else {
        // Check if buffer could be an incomplete placeholder
        if (this.couldBePlaceholder(this.buffer)) {
          // Keep buffering - might be incomplete placeholder
          if (this.buffer.length > MAX_PLACEHOLDER_LENGTH) {
            // Too long to be a placeholder - flush the `__` and continue
            output += "__";
            this.buffer = this.buffer.slice(2);
          } else {
            // Wait for more data
            break;
          }
        } else {
          // Definitely not a placeholder - output the `__`
          output += "__";
          this.buffer = this.buffer.slice(2);
        }
      }
    }

    return output;
  }

  /**
   * Check if text could be the start of a placeholder
   * Returns true if it matches the beginning of __PII_<TYPE>_<ID>__
   */
  private couldBePlaceholder(text: string): boolean {
    // Must start with __
    if (!text.startsWith("__")) return false;

    // Check partial patterns
    const partialPatterns = [
      /^__$/,
      /^__P$/,
      /^__PI$/,
      /^__PII$/,
      /^__PII_$/,
      /^__PII_[A-Z_]*$/,
      /^__PII_[A-Z_]+_$/,
      /^__PII_[A-Z_]+_\d*$/,
      /^__PII_[A-Z_]+_\d+_?$/,
    ];

    return partialPatterns.some(pattern => pattern.test(text));
  }

  /**
   * Finalize stream - flush any remaining buffer
   * Call this at end of stream to ensure nothing is lost
   */
  finalize(): string {
    if (this.buffer.length === 0) return "";

    // Try to restore any remaining buffer
    const result = restoreText(this.buffer, this.mappingTable);
    this.buffer = "";
    return result;
  }

  /**
   * Check if there's pending data in buffer
   */
  hasPendingData(): boolean {
    return this.buffer.length > 0;
  }
}

/**
 * Create a streaming restorer for a response
 */
export function createStreamRestorer(mappingTable: MappingTable): StreamRestorer {
  return new StreamRestorer(mappingTable);
}
