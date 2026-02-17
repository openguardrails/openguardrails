/**
 * OpenGuardrails plugin configuration and credential management
 */

import type { OpenClawGuardConfig } from "./types.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// =============================================================================
// API Configuration
// =============================================================================

export const DEFAULT_API_BASE_URL = "https://api.openguardrails.com";

const CREDENTIALS_DIR = path.join(os.homedir(), ".openclaw/credentials/openguardrails");
const CREDENTIALS_FILE = path.join(CREDENTIALS_DIR, "credentials.json");

// =============================================================================
// API Key Management
// =============================================================================

export function loadApiKey(): string | null {
  try {
    if (!fs.existsSync(CREDENTIALS_FILE)) {
      return null;
    }
    const data = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf-8"));
    return typeof data.apiKey === "string" ? data.apiKey : null;
  } catch {
    return null;
  }
}

export function saveApiKey(apiKey: string): void {
  if (!fs.existsSync(CREDENTIALS_DIR)) {
    fs.mkdirSync(CREDENTIALS_DIR, { recursive: true });
  }
  fs.writeFileSync(
    CREDENTIALS_FILE,
    JSON.stringify({ apiKey }, null, 2),
    "utf-8",
  );
}

export async function registerApiKey(agentName: string, baseUrl: string = DEFAULT_API_BASE_URL): Promise<string> {
  const response = await fetch(`${baseUrl}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentName }),
  });

  if (!response.ok) {
    throw new Error(`Registration failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { apiKey: string };
  if (!data.apiKey) {
    throw new Error("Registration response missing apiKey");
  }

  saveApiKey(data.apiKey);
  return data.apiKey;
}

// =============================================================================
// Dashboard Session Token Management
// =============================================================================

const EXTENSION_DIR = path.join(os.homedir(), ".openclaw/extensions/openguardrails");
const DASHBOARD_CONFIG_DIR = path.join(EXTENSION_DIR, "dashboard");
const DASHBOARD_CONFIG_FILE = path.join(DASHBOARD_CONFIG_DIR, "config.json");

export function loadDashboardConfig(): { url?: string; sessionToken?: string } {
  try {
    if (!fs.existsSync(DASHBOARD_CONFIG_FILE)) return {};
    return JSON.parse(fs.readFileSync(DASHBOARD_CONFIG_FILE, "utf-8"));
  } catch {
    return {};
  }
}

export function saveDashboardConfig(config: { url?: string; sessionToken?: string }): void {
  if (!fs.existsSync(DASHBOARD_CONFIG_DIR)) {
    fs.mkdirSync(DASHBOARD_CONFIG_DIR, { recursive: true });
  }
  const existing = loadDashboardConfig();
  fs.writeFileSync(
    DASHBOARD_CONFIG_FILE,
    JSON.stringify({ ...existing, ...config }, null, 2),
    "utf-8",
  );
}

// =============================================================================
// Default Configuration
// =============================================================================

export const DEFAULT_CONFIG: Required<OpenClawGuardConfig> = {
  enabled: true,
  gatewayEnabled: true,
  gatewayPort: 28900,
  gatewayAutoStart: true,
  blockOnRisk: true,
  apiKey: "",
  timeoutMs: 60000,
  logPath: path.join(os.homedir(), ".openclaw", "logs"),
  autoRegister: true,
  apiBaseUrl: DEFAULT_API_BASE_URL,
  // Dashboard config
  dashboardUrl: process.env.OG_DASHBOARD_URL || "http://localhost:28901",
  dashboardSessionToken: process.env.OG_SESSION_TOKEN || "",
  dashboardEnabled: true,
  dashboardPort: 28901,
  agentName: "OpenClaw Agent",
};

// =============================================================================
// Configuration Helpers
// =============================================================================

export function resolveConfig(config?: Partial<OpenClawGuardConfig>): Required<OpenClawGuardConfig> {
  // Also check saved dashboard config
  const saved = loadDashboardConfig();

  return {
    enabled: config?.enabled ?? DEFAULT_CONFIG.enabled,
    gatewayEnabled: config?.gatewayEnabled ?? DEFAULT_CONFIG.gatewayEnabled,
    gatewayPort: config?.gatewayPort ?? DEFAULT_CONFIG.gatewayPort,
    gatewayAutoStart: config?.gatewayAutoStart ?? DEFAULT_CONFIG.gatewayAutoStart,
    blockOnRisk: config?.blockOnRisk ?? DEFAULT_CONFIG.blockOnRisk,
    apiKey: config?.apiKey ?? DEFAULT_CONFIG.apiKey,
    timeoutMs: config?.timeoutMs ?? DEFAULT_CONFIG.timeoutMs,
    logPath: config?.logPath ?? DEFAULT_CONFIG.logPath,
    autoRegister: config?.autoRegister ?? DEFAULT_CONFIG.autoRegister,
    apiBaseUrl: config?.apiBaseUrl ?? DEFAULT_CONFIG.apiBaseUrl,
    dashboardUrl: config?.dashboardUrl ?? saved.url ?? DEFAULT_CONFIG.dashboardUrl,
    dashboardSessionToken: config?.dashboardSessionToken ?? saved.sessionToken ?? DEFAULT_CONFIG.dashboardSessionToken,
    dashboardEnabled: config?.dashboardEnabled ?? DEFAULT_CONFIG.dashboardEnabled,
    dashboardPort: config?.dashboardPort ?? DEFAULT_CONFIG.dashboardPort,
    agentName: config?.agentName ?? DEFAULT_CONFIG.agentName,
  };
}
