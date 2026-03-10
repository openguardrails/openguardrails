/**
 * OpenGuardrails plugin configuration and credential management
 */

import type { OpenClawGuardConfig } from "./types.js";
import os from "node:os";
import path from "node:path";
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { defaultCoreUrl, envApiKey } from "./env.js";
import { loadTextSync, loadTextSafe, loadJsonSafe } from "./fs-utils.js";

// =============================================================================
// Constants
// =============================================================================

export const DEFAULT_CORE_URL = defaultCoreUrl;

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
  /** The Core URL these credentials were issued by */
  coreUrl?: string;
};

/**
 * Load credentials from disk.
 * If the credentials were issued by a different Core URL, returns null
 * (credentials from production won't work in dev and vice versa).
 *
 * @param configuredCoreUrl - The Core URL from plugin config (openclaw.json).
 *   When provided, credentials are validated against this URL instead of DEFAULT_CORE_URL.
 */
export function loadCoreCredentials(configuredCoreUrl?: string): CoreCredentials | null {
  try {
    if (!existsSync(CREDENTIALS_FILE)) return null;
    const data = JSON.parse(loadTextSync(CREDENTIALS_FILE));
    if (typeof data.apiKey === "string" && typeof data.agentId === "string") {
      const creds = data as CoreCredentials;
      const expectedUrl = configuredCoreUrl ?? DEFAULT_CORE_URL;
      // Check if credentials match current environment
      if (creds.coreUrl && creds.coreUrl !== expectedUrl) {
        // Credentials from a different Core instance - don't use them
        // Credentials from a different Core instance - skip
        return null;
      }
      return creds;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveCoreCredentials(creds: CoreCredentials, coreUrl?: string): void {
  if (!existsSync(CREDENTIALS_DIR)) {
    mkdirSync(CREDENTIALS_DIR, { recursive: true });
  }
  // Save the Core URL with credentials so we know which instance issued them
  const toSave = { ...creds, coreUrl: coreUrl ?? DEFAULT_CORE_URL };
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(toSave, null, 2), "utf-8");
}

export function deleteCoreCredentials(): boolean {
  try {
    if (existsSync(CREDENTIALS_FILE)) {
      unlinkSync(CREDENTIALS_FILE);
      return true;
    }
    return false;
  } catch {
    return false;
  }
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
  const url = coreUrl.replace(/\/+$/, "");
  const response = await fetch(`${url}/api/v1/agents/register`, {
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
    coreUrl: url,
  };

  saveCoreCredentials(creds, url);

  return {
    credentials: creds,
    activateUrl: json.activate_url ?? "",
    loginUrl: json.login_url ?? `${url}/login`,
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
    const url = coreUrl.replace(/\/+$/, "");
    const res = await fetch(`${url}/api/v1/account`, {
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

export type ResolvedGuardConfig = Required<Omit<OpenClawGuardConfig, "plan">> & Pick<OpenClawGuardConfig, "plan">;

export const DEFAULT_CONFIG: ResolvedGuardConfig = {
  enabled: true,
  blockOnRisk: true,
  apiKey: envApiKey,
  timeoutMs: 60000,
  coreUrl: DEFAULT_CORE_URL,
  agentName: "OpenClaw Agent",
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
    const content = loadTextSync(identityPath);
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
  const config = loadJsonSafe(path.join(openclawDir, "openclaw.json"));
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
  const identityContent = loadTextSafe(path.join(workspacePath, "IDENTITY.md"));
  result.workspaceFiles.identity = identityContent;
  result.workspaceFiles.soul     = loadTextSafe(path.join(workspacePath, "SOUL.md"));
  result.workspaceFiles.user     = loadTextSafe(path.join(workspacePath, "USER.md"));
  result.workspaceFiles.agents   = loadTextSafe(path.join(workspacePath, "AGENTS.md"));
  result.workspaceFiles.tools    = loadTextSafe(path.join(workspacePath, "TOOLS.md"));
  result.workspaceFiles.heartbeat = loadTextSafe(path.join(workspacePath, "HEARTBEAT.md"));
  result.bootstrapExists = existsSync(path.join(workspacePath, "BOOTSTRAP.md"));

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
    if (existsSync(skillsDir)) {
      result.skills = readdirSync(skillsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => {
          const meta = loadJsonSafe(path.join(skillsDir, d.name, "_meta.json")) as { description?: string } | null;
          return { name: d.name, description: meta?.description };
        });
    }
  } catch { /* ignore */ }

  // ── Connected systems (credential names) ────────────────────
  try {
    const credsDir = path.join(openclawDir, "credentials");
    if (existsSync(credsDir)) {
      result.connectedSystems = readdirSync(credsDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.slice(0, -5));
    }
  } catch { /* ignore */ }

  // ── Sessions (count, lastActive, channels) ──────────────────
  try {
    const agentsDir = path.join(openclawDir, "agents");
    if (existsSync(agentsDir)) {
      for (const dir of readdirSync(agentsDir, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        const sessionsData = loadJsonSafe(path.join(agentsDir, dir.name, "sessions", "sessions.json")) as
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
    const raw = loadTextSafe(path.join(openclawDir, "cron", "jobs.json"));
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
  const config = loadJsonSafe(path.join(dir, "openclaw.json"));
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

export function resolveConfig(config?: Partial<OpenClawGuardConfig>): ResolvedGuardConfig {
  const plan = config?.plan;
  return {
    enabled: config?.enabled ?? DEFAULT_CONFIG.enabled,
    blockOnRisk: config?.blockOnRisk ?? DEFAULT_CONFIG.blockOnRisk,
    apiKey: config?.apiKey ?? DEFAULT_CONFIG.apiKey,
    timeoutMs: config?.timeoutMs ?? DEFAULT_CONFIG.timeoutMs,
    coreUrl: (config?.coreUrl ?? DEFAULT_CONFIG.coreUrl).replace(/\/+$/, ""),
    agentName: config?.agentName ?? readIdentityName() ?? DEFAULT_CONFIG.agentName,
    plan,
  };
}
