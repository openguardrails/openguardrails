/**
 * Gateway Activity Logger
 *
 * Tracks sanitization and restoration events for monitoring.
 */

import type { GatewayActivityEvent, ActivityListener, MappingTable } from "./types.js";

// Activity listeners
const listeners: ActivityListener[] = [];

// Request counter for generating IDs
let requestCounter = 0;

/**
 * Generate a unique request ID
 */
export function generateRequestId(): string {
  return `gw-${Date.now()}-${++requestCounter}`;
}

/**
 * Register an activity listener
 */
export function addActivityListener(listener: ActivityListener): void {
  listeners.push(listener);
}

/**
 * Remove an activity listener
 */
export function removeActivityListener(listener: ActivityListener): void {
  const index = listeners.indexOf(listener);
  if (index !== -1) {
    listeners.splice(index, 1);
  }
}

/**
 * Clear all activity listeners
 */
export function clearActivityListeners(): void {
  listeners.length = 0;
}

/**
 * Emit an activity event to all listeners
 */
function emitActivity(event: GatewayActivityEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      console.error("[gateway-activity] Listener error:", err);
    }
  }
}

/**
 * Count categories from mapping table
 * Handles both old format (__email_1__) and new format (__PII_EMAIL_ADDRESS_00000001__)
 */
export function countCategories(mappingTable: MappingTable): Record<string, number> {
  const categories: Record<string, number> = {};

  for (const placeholder of mappingTable.keys()) {
    // Try new format first: __PII_EMAIL_ADDRESS_00000001__
    const newMatch = placeholder.match(/^__PII_([A-Z_]+)_\d+__$/);
    if (newMatch) {
      const category = newMatch[1].toLowerCase();
      categories[category] = (categories[category] || 0) + 1;
      continue;
    }

    // Fallback to old format: __email_1__
    const oldMatch = placeholder.match(/^__([a-z_]+)_\d+__$/);
    if (oldMatch) {
      const category = oldMatch[1];
      categories[category] = (categories[category] || 0) + 1;
    }
  }

  return categories;
}

/**
 * Log a sanitization event (request going out)
 */
export function logSanitizeEvent(params: {
  requestId: string;
  backend: string;
  endpoint: string;
  model?: string;
  mappingTable: MappingTable;
  redactionCount: number;
  durationMs?: number;
}): void {
  const event: GatewayActivityEvent = {
    id: `${params.requestId}-sanitize`,
    timestamp: new Date().toISOString(),
    requestId: params.requestId,
    type: "sanitize",
    direction: "request",
    backend: params.backend,
    endpoint: params.endpoint,
    model: params.model,
    redactionCount: params.redactionCount,
    categories: countCategories(params.mappingTable),
    durationMs: params.durationMs,
  };

  emitActivity(event);
}

/**
 * Log a restoration event (response coming back)
 */
export function logRestoreEvent(params: {
  requestId: string;
  backend: string;
  endpoint: string;
  model?: string;
  mappingTable: MappingTable;
  restorationCount: number;
  durationMs?: number;
}): void {
  const event: GatewayActivityEvent = {
    id: `${params.requestId}-restore`,
    timestamp: new Date().toISOString(),
    requestId: params.requestId,
    type: "restore",
    direction: "response",
    backend: params.backend,
    endpoint: params.endpoint,
    model: params.model,
    redactionCount: params.restorationCount,
    categories: countCategories(params.mappingTable),
    durationMs: params.durationMs,
  };

  emitActivity(event);
}
