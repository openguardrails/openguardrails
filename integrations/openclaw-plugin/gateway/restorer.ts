/**
 * Gateway content restorer
 *
 * Restores sanitized placeholders back to original values using the mapping table.
 */

import type { MappingTable } from "./types.js";

/**
 * Restore placeholders in a string
 */
function restoreText(text: string, mappingTable: MappingTable): string {
  let restored = text;

  // Sort placeholders by length descending to handle nested cases
  const placeholders = Array.from(mappingTable.keys()).sort(
    (a, b) => b.length - a.length,
  );

  for (const placeholder of placeholders) {
    const originalValue = mappingTable.get(placeholder)!;
    // Use split/join for safe replacement (handles special regex chars)
    restored = restored.split(placeholder).join(originalValue);
  }

  return restored;
}

/**
 * Recursively restore any value (string, object, array)
 */
function restoreValue(value: any, mappingTable: MappingTable): any {
  // String: restore placeholders
  if (typeof value === "string") {
    return restoreText(value, mappingTable);
  }

  // Array: restore each element
  if (Array.isArray(value)) {
    return value.map((item) => restoreValue(item, mappingTable));
  }

  // Object: restore each property
  if (value !== null && typeof value === "object") {
    const restored: any = {};
    for (const [key, val] of Object.entries(value)) {
      restored[key] = restoreValue(val, mappingTable);
    }
    return restored;
  }

  // Primitives: return as-is
  return value;
}

/**
 * Restore any content (object, array, string) using the mapping table
 */
export function restore(content: any, mappingTable: MappingTable): any {
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
    // Try to parse as JSON first
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
    return `data: ${JSON.stringify(restored)}\n`;
  } catch {
    // Fallback to text restoration
    return `data: ${restoreText(dataContent, mappingTable)}\n`;
  }
}
