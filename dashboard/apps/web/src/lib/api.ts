import { getStoredApiKey } from "./auth-context";

function getToken(): string | null {
  return getStoredApiKey();
}

async function request<T = Record<string, unknown>>(path: string, options?: RequestInit): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options?.headers as Record<string, string>),
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const res = await fetch(path, { ...options, headers });
  return res.json();
}

export const api = {
  // Session
  verifyToken: (token: string) =>
    request<{ success: boolean; error?: string }>("/api/session/verify", {
      method: "POST",
      body: JSON.stringify({ token }),
    }),

  logout: () =>
    request("/api/session/logout", { method: "POST" }),

  // Discovery
  listDiscoveryAgents: () =>
    request<{ success: boolean; data: DiscoveredAgent[] }>("/api/discovery/agents"),

  getDiscoveryAgent: (id: string) =>
    request<{ success: boolean; data: DiscoveredAgent }>(`/api/discovery/agents/${encodeURIComponent(id)}`),

  scanAgents: () =>
    request<{ success: boolean; data: DiscoveredAgent[] }>("/api/discovery/scan", { method: "POST" }),

  getAgentProfile: (id: string) =>
    request<{ success: boolean; data: AgentProfile }>(`/api/discovery/agents/${encodeURIComponent(id)}/profile`),

  getAgentSummary: (id: string) =>
    request<{ success: boolean; data: { summary: string } }>(`/api/discovery/agents/${encodeURIComponent(id)}/summary`),

  // Observations / Permissions
  getAgentPermissions: (agentId: string) =>
    request<{ success: boolean; data: AgentPermission[] }>(`/api/observations/agents/${encodeURIComponent(agentId)}/permissions`),

  getAgentObservations: (agentId: string, limit = 50) =>
    request<{ success: boolean; data: ToolCallObservation[] }>(`/api/observations/agents/${encodeURIComponent(agentId)}/observations?limit=${limit}`),

  getAllPermissions: () =>
    request<{ success: boolean; data: AgentPermission[] }>("/api/observations/permissions"),

  getObservationSummary: () =>
    request<{ success: boolean; data: ObservationSummary[] }>("/api/observations/summary"),

  getAnomalies: () =>
    request<{ success: boolean; data: AgentPermission[] }>("/api/observations/anomalies"),

  // Registered agents (database)
  listAgents: () =>
    request<{ success: boolean; data: RegisteredAgent[] }>("/api/agents"),
};

export interface AgentPermission {
  id: string;
  agentId: string;
  toolName: string;
  category: string | null;
  accessPattern: string | null;
  targetsJson: string[];
  callCount: number;
  errorCount: number;
  firstSeen: string;
  lastSeen: string;
}

export interface ToolCallObservation {
  id: string;
  agentId: string;
  toolName: string;
  category: string | null;
  accessPattern: string | null;
  paramsJson: Record<string, unknown> | null;
  phase: string;
  error: string | null;
  durationMs: number | null;
  blocked: boolean;
  timestamp: string;
}

export interface ObservationSummary {
  agentId: string;
  totalCalls: number;
  blockedCalls: number;
  uniqueTools: number;
}

export interface AgentSkill {
  name: string;
  description?: string;
  emoji?: string;
  source: "system" | "workspace";
}

export interface CronJob {
  id?: string;
  schedule?: string;
  task?: string;
  enabled?: boolean;
}

export interface BundledExtension {
  name: string;
  description: string;
  channels: string[];
}

export interface AgentProfile extends DiscoveredAgent {
  workspaceFiles: {
    soul: string;
    identity: string;
    user: string;
    agents: string;
    tools: string;
    heartbeat: string;
  };
  bootstrapExists: boolean;
  cronJobs: CronJob[];
  allSkills: AgentSkill[];
  bundledExtensions: BundledExtension[];
  registeredAgentId?: string | null;
}

export interface DiscoveredAgent {
  id: string;
  name: string;
  emoji: string;
  creature: string;
  vibe: string;
  model: string;
  provider: string;
  workspacePath: string;
  ownerName: string;
  avatarUrl: string | null;
  skills: { name: string; description?: string }[];
  connectedSystems: string[];
  channels: string[];
  plugins: { name: string; enabled: boolean }[];
  hooks: { name: string; enabled: boolean }[];
  sessionCount: number;
  lastActive: string | null;
}

export interface RegisteredAgent {
  id: string;
  name: string;
  description: string | null;
  provider: string;
  status: string;
  metadata: Record<string, unknown>;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Minimal agent info for display in agent lookup maps */
export interface AgentLookup {
  name: string;
  emoji: string;
}

/** Build a combined agent lookup map from discovery + registered agents */
export function buildAgentMap(
  discoveryAgents: DiscoveredAgent[],
  registeredAgents: RegisteredAgent[],
): Map<string, AgentLookup> {
  const map = new Map<string, AgentLookup>();
  // Registered agents first (UUIDs used in permissions/observations)
  for (const a of registeredAgents) {
    map.set(a.id, { name: a.name, emoji: "\uD83E\uDD16" });
  }
  // Discovery agents overlay (richer info with emoji)
  for (const a of discoveryAgents) {
    map.set(a.id, { name: a.name, emoji: a.emoji || "\uD83E\uDD16" });
  }
  return map;
}
