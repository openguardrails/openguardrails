/**
 * OpenGuardrails plugin configuration and credential management
 */

import type { OpenClawGuardConfig } from "./types.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// =============================================================================
// Constants
// =============================================================================

export const DEFAULT_PLATFORM_URL =
  process.env.OG_PLATFORM_URL ?? "https://platform.openguardrails.com";

const CREDENTIALS_DIR = path.join(os.homedir(), ".openclaw/credentials/openguardrails");
const CREDENTIALS_FILE = path.join(CREDENTIALS_DIR, "credentials.json");

// =============================================================================
// Core Credentials
// =============================================================================

export type CoreCredentials = {
  apiKey: string;
  agentId: string;
  claimUrl: string;
  verificationCode: string;
  email?: string;
};

export function loadCoreCredentials(): CoreCredentials | null {
  try {
    if (!fs.existsSync(CREDENTIALS_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf-8"));
    if (typeof data.apiKey === "string" && typeof data.agentId === "string") {
      return data as CoreCredentials;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveCoreCredentials(creds: CoreCredentials): void {
  if (!fs.existsSync(CREDENTIALS_DIR)) {
    fs.mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
  }
  // Write with mode 0600 so only the owner can read credentials
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), { encoding: "utf-8", mode: 0o600 });
}

/** @deprecated Use loadCoreCredentials().apiKey instead */
export function loadApiKey(): string | null {
  return loadCoreCredentials()?.apiKey ?? null;
}

function validateHttpUrl(raw: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must use http or https protocol`);
  }
  return parsed.origin;
}

export async function registerWithCore(
  name: string,
  description: string,
  platformUrl: string = DEFAULT_PLATFORM_URL,
): Promise<CoreCredentials> {
  const safeUrl = validateHttpUrl(platformUrl, "platformUrl");
  const response = await fetch(`${safeUrl}/api/v1/agents/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, description }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Registration failed: ${response.status} ${response.statusText}${text ? ` — ${text}` : ""}`,
    );
  }

  const json = (await response.json()) as {
    success: boolean;
    agent?: {
      id: string;
      api_key: string;
      claim_url: string;
      verification_code: string;
    };
    error?: string;
  };

  if (!json.success || !json.agent) {
    throw new Error(`Registration error: ${json.error ?? "unknown"}`);
  }

  const creds: CoreCredentials = {
    apiKey: json.agent.api_key,
    agentId: json.agent.id,
    claimUrl: json.agent.claim_url,
    verificationCode: json.agent.verification_code,
  };

  saveCoreCredentials(creds);
  return creds;
}

// =============================================================================
// Account Email Polling
// =============================================================================

/**
 * Polls Core `/api/v1/account` to learn the agent's verified email.
 * Returns `{ email, status }` if the agent is active, null otherwise.
 */
export async function pollAccountEmail(
  apiKey: string,
  platformUrl: string = DEFAULT_PLATFORM_URL,
): Promise<{ email: string; status: string } | null> {
  try {
    const safeUrl = validateHttpUrl(platformUrl, "platformUrl");
    const res = await fetch(`${safeUrl}/api/v1/account`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      success: boolean;
      email?: string | null;
      status?: string;
    };
    if (data.success && data.email && data.status === "active") {
      return { email: data.email, status: data.status };
    }
    return null;
  } catch {
    return null;
  }
}

// =============================================================================
// Default Configuration
// =============================================================================

export const DEFAULT_CONFIG: Required<OpenClawGuardConfig> = {
  enabled: true,
  blockOnRisk: true,
  apiKey: process.env.OG_API_KEY ?? "",
  timeoutMs: 60000,
  apiBaseUrl: DEFAULT_PLATFORM_URL,
  platformUrl: DEFAULT_PLATFORM_URL,
  agentName: "OpenClaw Agent",
  dashboardUrl: process.env.OG_DASHBOARD_URL ?? "",
  dashboardSessionToken: process.env.OG_SESSION_TOKEN ?? "",
};

// =============================================================================
// Configuration Helpers
// =============================================================================

export function resolveConfig(config?: Partial<OpenClawGuardConfig>): Required<OpenClawGuardConfig> {
  return {
    enabled: config?.enabled ?? DEFAULT_CONFIG.enabled,
    blockOnRisk: config?.blockOnRisk ?? DEFAULT_CONFIG.blockOnRisk,
    apiKey: config?.apiKey ?? DEFAULT_CONFIG.apiKey,
    timeoutMs: config?.timeoutMs ?? DEFAULT_CONFIG.timeoutMs,
    apiBaseUrl: config?.apiBaseUrl ?? DEFAULT_CONFIG.apiBaseUrl,
    platformUrl: config?.platformUrl ?? config?.apiBaseUrl ?? DEFAULT_CONFIG.platformUrl,
    agentName: config?.agentName ?? DEFAULT_CONFIG.agentName,
    dashboardUrl: config?.dashboardUrl ?? DEFAULT_CONFIG.dashboardUrl,
    dashboardSessionToken: config?.dashboardSessionToken ?? DEFAULT_CONFIG.dashboardSessionToken,
  };
}
