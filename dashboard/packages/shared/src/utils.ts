import { randomBytes } from "crypto";
import { SESSION_TOKEN_PREFIX } from "./constants.js";

/** Generate a session token */
export function generateSessionToken(): string {
  const random = randomBytes(32).toString("hex");
  return `${SESSION_TOKEN_PREFIX}${random}`;
}

/** Generate a UUID v4 */
export function generateId(): string {
  return crypto.randomUUID();
}

/** Format number with commas */
export function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/** Sleep for ms */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Mask a sensitive string, showing only last 4 chars */
export function maskSecret(value: string): string {
  if (value.length <= 8) return "****";
  return "****" + value.slice(-4);
}
