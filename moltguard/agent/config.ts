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

export const DEFAULT_CORE_URL =
  process.env.OG_CORE_URL ?? "https://www.openguardrails.com/core";

export const DEFAULT_DASHBOARD_URL =
  process.env.OG_DASHBOARD_URL ?? "https://www.openguardrails.com/dashboard";

const CREDENTIALS_DIR = path.join(os.homedir(), ".openclaw/credentials/moltguard");
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
    fs.mkdirSync(CREDENTIALS_DIR, { recursive: true });
  }
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), "utf-8");
}

/** @deprecated Use loadCoreCredentials().apiKey instead */
export function loadApiKey(): string | null {
  return loadCoreCredentials()?.apiKey ?? null;
}

export type RegisterResult = {
  credentials: CoreCredentials;
  activateUrl: string;
  loginUrl: string;
};

export async function registerWithCore(
  name: string,
  description: string,
  coreUrl: string = DEFAULT_CORE_URL,
): Promise<RegisterResult> {
  const response = await fetch(`${coreUrl}/api/v1/agents/register`, {
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
    };
    activate_url?: string;
    login_url?: string;
    error?: string;
  };

  if (!json.success || !json.agent) {
    throw new Error(`Registration error: ${json.error ?? "unknown"}`);
  }

  const creds: CoreCredentials = {
    apiKey: json.agent.api_key,
    agentId: json.agent.id,
    claimUrl: json.activate_url ?? "",
    verificationCode: "", // No longer used
  };

  saveCoreCredentials(creds);

  return {
    credentials: creds,
    activateUrl: json.activate_url ?? "",
    loginUrl: json.login_url ?? `${coreUrl}/login`,
  };
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
  coreUrl: string = DEFAULT_CORE_URL,
): Promise<{ email: string; status: string } | null> {
  try {
    const res = await fetch(`${coreUrl}/api/v1/account`, {
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
  coreUrl: DEFAULT_CORE_URL,
  agentName: "OpenClaw Agent",
  dashboardUrl: DEFAULT_DASHBOARD_URL,
};

// =============================================================================
// Configuration Helpers
// =============================================================================

function parseIdentityField(content: string, field: string): string {
  const prefix = `- **${field}:**`;
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed.startsWith(prefix)) {
      const inline = trimmed.slice(prefix.length).trim();
      if (inline) return inline;
      // value on next line
      const next = lines[i + 1]?.trim();
      if (next && !next.startsWith("-") && !next.startsWith("#")) return next;
    }
  }
  return "";
}

/**
 * Reads the agent's name from ~/.openclaw/workspace/IDENTITY.md.
 */
function readIdentityName(): string | null {
  try {
    const identityPath = path.join(os.homedir(), ".openclaw/workspace/IDENTITY.md");
    const content = fs.readFileSync(identityPath, "utf-8");
    const name = parseIdentityField(content, "Name");
    return name || null;
  } catch {
    return null;
  }
}

export type AgentProfile = {
  // Identity
  emoji: string;
  creature: string;
  vibe: string;
  model: string;
  provider: string;
  ownerName: string;
  // Config
  skills: { name: string; description?: string }[];
  plugins: { name: string; enabled: boolean }[];
  hooks: { name: string; enabled: boolean }[];
  connectedSystems: string[];
  channels: string[];
  // Sessions
  sessionCount: number;
  lastActive: string | null;
  // Workspace file contents
  workspaceFiles: {
    soul: string;
    identity: string;
    user: string;
    agents: string;
    tools: string;
    heartbeat: string;
  };
  bootstrapExists: boolean;
  // Tasks
  cronJobs: Array<{ id?: string; schedule?: string; task?: string; enabled?: boolean }>;
};

/** @deprecated use readAgentProfile() */
export type AgentInfo = AgentProfile;

function readFileSafe(filePath: string): string {
  try { return fs.readFileSync(filePath, "utf-8"); } catch { return ""; }
}

function readJsonSafe(filePath: string): Record<string, unknown> | null {
  try { return JSON.parse(fs.readFileSync(filePath, "utf-8")); } catch { return null; }
}

/**
 * Reads the full OpenClaw workspace profile from ~/.openclaw/ to report to the dashboard.
 * All fields degrade gracefully — missing files produce empty strings/arrays.
 */
export function readAgentProfile(): AgentProfile {
  const openclawDir = path.join(os.homedir(), ".openclaw");
  const result: AgentProfile = {
    emoji: "", creature: "", vibe: "", model: "", provider: "", ownerName: "",
    skills: [], plugins: [], hooks: [], connectedSystems: [], channels: [],
    sessionCount: 0, lastActive: null,
    workspaceFiles: { soul: "", identity: "", user: "", agents: "", tools: "", heartbeat: "" },
    bootstrapExists: false,
    cronJobs: [],
  };

  // ── openclaw.json ──────────────────────────────────────────
  const config = readJsonSafe(path.join(openclawDir, "openclaw.json"));
  let workspacePath = path.join(openclawDir, "workspace");

  if (config) {
    const agentsConfig = config.agents as { defaults?: { model?: { primary?: string }; workspace?: string } } | undefined;
    const defaultModel = agentsConfig?.defaults?.model?.primary ?? "";
    if (defaultModel.includes("/")) {
      const [provider, model] = defaultModel.split("/", 2);
      result.provider = provider ?? "";
      result.model = model ?? "";
    } else {
      result.model = defaultModel;
    }
    if (agentsConfig?.defaults?.workspace) {
      workspacePath = agentsConfig.defaults.workspace;
    }

    const pluginsConfig = config.plugins as { entries?: Record<string, { enabled?: boolean }> } | undefined;
    if (pluginsConfig?.entries) {
      for (const [name, entry] of Object.entries(pluginsConfig.entries)) {
        result.plugins.push({ name, enabled: entry?.enabled !== false });
      }
    }

    const hooksConfig = config.hooks as { internal?: { entries?: Record<string, { enabled?: boolean }> } } | undefined;
    if (hooksConfig?.internal?.entries) {
      for (const [name, entry] of Object.entries(hooksConfig.internal.entries)) {
        result.hooks.push({ name, enabled: entry?.enabled !== false });
      }
    }
  }

  // ── Workspace files ─────────────────────────────────────────
  const identityContent = readFileSafe(path.join(workspacePath, "IDENTITY.md"));
  result.workspaceFiles.identity = identityContent;
  result.workspaceFiles.soul     = readFileSafe(path.join(workspacePath, "SOUL.md"));
  result.workspaceFiles.user     = readFileSafe(path.join(workspacePath, "USER.md"));
  result.workspaceFiles.agents   = readFileSafe(path.join(workspacePath, "AGENTS.md"));
  result.workspaceFiles.tools    = readFileSafe(path.join(workspacePath, "TOOLS.md"));
  result.workspaceFiles.heartbeat = readFileSafe(path.join(workspacePath, "HEARTBEAT.md"));
  result.bootstrapExists = fs.existsSync(path.join(workspacePath, "BOOTSTRAP.md"));

  // ── Identity fields ─────────────────────────────────────────
  if (identityContent) {
    result.emoji    = parseIdentityField(identityContent, "Emoji");
    result.creature = parseIdentityField(identityContent, "Creature");
    result.vibe     = parseIdentityField(identityContent, "Vibe");
  }
  if (result.workspaceFiles.user) {
    result.ownerName = parseIdentityField(result.workspaceFiles.user, "Name")
      || parseIdentityField(result.workspaceFiles.user, "name");
  }

  // ── Skills ──────────────────────────────────────────────────
  try {
    const skillsDir = path.join(workspacePath, "skills");
    if (fs.existsSync(skillsDir)) {
      result.skills = fs.readdirSync(skillsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => {
          const meta = readJsonSafe(path.join(skillsDir, d.name, "_meta.json")) as { description?: string } | null;
          return { name: d.name, description: meta?.description };
        });
    }
  } catch { /* ignore */ }

  // ── Connected systems (credential names) ────────────────────
  try {
    const credsDir = path.join(openclawDir, "credentials");
    if (fs.existsSync(credsDir)) {
      result.connectedSystems = fs.readdirSync(credsDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.slice(0, -5));
    }
  } catch { /* ignore */ }

  // ── Sessions (count, lastActive, channels) ──────────────────
  try {
    const agentsDir = path.join(openclawDir, "agents");
    if (fs.existsSync(agentsDir)) {
      for (const dir of fs.readdirSync(agentsDir, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        const sessionsData = readJsonSafe(path.join(agentsDir, dir.name, "sessions", "sessions.json")) as
          Record<string, { updatedAt?: number; lastChannel?: string }> | null;
        if (!sessionsData) continue;
        for (const session of Object.values(sessionsData)) {
          result.sessionCount++;
          if (typeof session.updatedAt === "number") {
            const iso = new Date(session.updatedAt).toISOString();
            if (!result.lastActive || iso > result.lastActive) result.lastActive = iso;
          }
          if (typeof session.lastChannel === "string" && !result.channels.includes(session.lastChannel)) {
            result.channels.push(session.lastChannel);
          }
        }
      }
    }
  } catch { /* ignore */ }

  // ── Cron jobs ────────────────────────────────────────────────
  try {
    const raw = readFileSafe(path.join(openclawDir, "cron", "jobs.json"));
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      result.cronJobs = Array.isArray(parsed) ? parsed : ((parsed as { jobs?: unknown[] })?.jobs ?? []);
    }
  } catch { /* ignore */ }

  return result;
}

/** @deprecated use readAgentProfile() */
export function readAgentInfo(): AgentProfile {
  return readAgentProfile();
}

/**
 * Returns file paths that should be watched for changes to trigger a profile re-upload.
 */
export function getProfileWatchPaths(openclawDir?: string): string[] {
  const dir = openclawDir ?? path.join(os.homedir(), ".openclaw");
  const config = readJsonSafe(path.join(dir, "openclaw.json"));
  const agentsConfig = config?.agents as { defaults?: { workspace?: string } } | undefined;
  const workspace = agentsConfig?.defaults?.workspace ?? path.join(dir, "workspace");
  return [
    path.join(dir, "openclaw.json"),
    path.join(workspace, "IDENTITY.md"),
    path.join(workspace, "SOUL.md"),
    path.join(workspace, "USER.md"),
    path.join(workspace, "AGENTS.md"),
    path.join(workspace, "TOOLS.md"),
    path.join(workspace, "HEARTBEAT.md"),
    path.join(dir, "cron", "jobs.json"),
    path.join(workspace, "skills"),
  ];
}

export function resolveConfig(config?: Partial<OpenClawGuardConfig>): Required<OpenClawGuardConfig> {
  return {
    enabled: config?.enabled ?? DEFAULT_CONFIG.enabled,
    blockOnRisk: config?.blockOnRisk ?? DEFAULT_CONFIG.blockOnRisk,
    apiKey: config?.apiKey ?? DEFAULT_CONFIG.apiKey,
    timeoutMs: config?.timeoutMs ?? DEFAULT_CONFIG.timeoutMs,
    coreUrl: config?.coreUrl ?? DEFAULT_CONFIG.coreUrl,
    agentName: config?.agentName ?? readIdentityName() ?? DEFAULT_CONFIG.agentName,
    dashboardUrl: config?.dashboardUrl ?? DEFAULT_CONFIG.dashboardUrl,
  };
}
