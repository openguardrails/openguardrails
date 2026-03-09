import { getSessionToken } from "./auth-context";

/** When deployed under /dashboard/, API is at /dashboard/api */
const API_BASE = typeof import.meta.env.BASE_URL === "string" && import.meta.env.BASE_URL !== "/" ? import.meta.env.BASE_URL.replace(/\/$/, "") : "";

function getToken(): string | null {
  return getSessionToken();
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
  const url = path.startsWith("/") ? API_BASE + path : API_BASE + "/" + path;
  const res = await fetch(url, { ...options, headers });
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

  getAllObservations: (limit = 100) =>
    request<{ success: boolean; data: ToolCallObservation[] }>(`/api/observations?limit=${limit}`),

  getAllPermissions: () =>
    request<{ success: boolean; data: AgentPermission[] }>("/api/observations/permissions"),

  getObservationSummary: () =>
    request<{ success: boolean; data: ObservationSummary[] }>("/api/observations/summary"),

  getAnomalies: () =>
    request<{ success: boolean; data: AgentPermission[] }>("/api/observations/anomalies"),

  // Registered agents (database)
  listAgents: () =>
    request<{ success: boolean; data: RegisteredAgent[] }>("/api/agents"),

  // Detection results
  getDetections: (options?: { limit?: number; unsafe?: boolean }) => {
    const params = new URLSearchParams();
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.unsafe) params.set("unsafe", "true");
    const qs = params.toString();
    return request<{ success: boolean; data: DetectionResult[] }>(`/api/detections${qs ? `?${qs}` : ""}`);
  },

  getDetectionSummary: () =>
    request<{ success: boolean; data: DetectionSummary }>("/api/detections/summary"),

  // Settings
  getSettings: () =>
    request<{ success: boolean; data: Record<string, string> }>("/api/settings"),

  updateSettings: (settings: Record<string, string>) =>
    request<{ success: boolean }>("/api/settings", {
      method: "PUT",
      body: JSON.stringify(settings),
    }),

  getConnectionStatus: () =>
    request<{ success: boolean; data: { mode: "autonomous" | "claimed"; message: string } }>(
      "/api/settings/connection-status"
    ),

  // Gateway
  getGatewayStatus: () =>
    request<{ success: boolean; data: GatewayStatus }>("/api/gateway/status"),

  getGatewayConfig: () =>
    request<{ success: boolean; data: GatewayConfig }>("/api/gateway/config"),

  getGatewayHealth: () =>
    request<{ success: boolean; data: GatewayHealth }>("/api/gateway/health"),

  getGatewayActivity: (options?: { limit?: number; type?: "sanitize" | "restore" }) => {
    const params = new URLSearchParams();
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.type) params.set("type", options.type);
    const qs = params.toString();
    return request<{ success: boolean; data: GatewayActivityEvent[] }>(`/api/gateway/activity${qs ? `?${qs}` : ""}`);
  },

  getGatewayActivityStats: () =>
    request<{ success: boolean; data: GatewayActivityStats }>("/api/gateway/activity/stats"),

  // Agentic Hours
  getAgenticHoursToday: () =>
    request<{ success: boolean; data: AgenticHoursSummary }>("/api/agentic-hours/today"),

  getAgenticHoursDaily: (options?: { from?: string; to?: string }) => {
    const params = new URLSearchParams();
    if (options?.from) params.set("from", options.from);
    if (options?.to) params.set("to", options.to);
    const qs = params.toString();
    return request<{ success: boolean; data: AgenticHoursDaily[] }>(`/api/agentic-hours/daily${qs ? `?${qs}` : ""}`);
  },

  getAgenticHoursByAgent: (options?: { from?: string; to?: string }) => {
    const params = new URLSearchParams();
    if (options?.from) params.set("from", options.from);
    if (options?.to) params.set("to", options.to);
    const qs = params.toString();
    return request<{ success: boolean; data: AgenticHoursByAgent[] }>(`/api/agentic-hours/by-agent${qs ? `?${qs}` : ""}`);
  },
};

export interface GatewayStatus {
  enabled: boolean;
  running: boolean;
  pid?: number;
  port: number;
  url: string;
  agents: string[];
  providers: string[];
  enabledAt: string | null;
  backends: string[];
}

export interface GatewayConfig {
  configured: boolean;
  port: number;
  backends: Record<string, { baseUrl: string; hasApiKey: boolean }>;
  routing?: Record<string, string>;
}

export interface GatewayHealth {
  healthy: boolean;
  status?: string;
  version?: string;
  error?: string;
}

export interface GatewayActivityEvent {
  id: string;
  requestId: string;
  timestamp: string;
  type: "sanitize" | "restore";
  direction: "request" | "response";
  backend: string;
  endpoint: string;
  model?: string;
  redactionCount: number;
  categories: Record<string, number>;
  durationMs?: number;
}

export interface GatewayActivityStats {
  last24Hours: {
    sanitizeCount: number;
    restoreCount: number;
    totalRedactions: number;
  };
  allTime: {
    sanitizeCount: number;
    restoreCount: number;
    totalRedactions: number;
    categories: Record<string, number>;
    backends: Record<string, number>;
  };
}

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
  metadata: {
    openclawId?: string;
    emoji?: string;
    creature?: string;
    vibe?: string;
    model?: string;
    skills?: { name: string; description?: string }[];
    plugins?: { name: string; enabled: boolean }[];
    ownerName?: string;
    [key: string]: unknown;
  };
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Minimal agent info for display in agent lookup maps */
export interface AgentLookup {
  name: string;
  emoji: string;
}

export interface DetectionResult {
  id: string;
  agentId: string | null;
  safe: boolean;
  categories: string[];
  sensitivityScore: number;
  findings: Array<{
    scanner: string;
    name: string;
    description?: string;
    matchedText?: string;
    confidence?: "high" | "medium" | "low";
  }>;
  latencyMs: number;
  requestId: string;
  // Static scan fields
  scanType?: "static" | "dynamic";
  filePath?: string | null;
  fileType?: "soul" | "agent" | "memory" | "task" | "skill" | "plugin" | "other" | null;
  createdAt: string;
}

export interface DetectionSummary {
  total: number;
  safe: number;
  unsafe: number;
}

export interface AgenticHoursSummary {
  toolCallDurationMs: number;
  llmDurationMs: number;
  totalDurationMs: number;
  toolCallCount: number;
  llmCallCount: number;
  sessionCount: number;
  blockCount: number;
  riskEventCount: number;
}

export interface AgenticHoursDaily {
  date: string;
  toolCallDurationMs: number;
  llmDurationMs: number;
  totalDurationMs: number;
  toolCallCount: number;
  llmCallCount: number;
}

export interface AgenticHoursByAgent {
  agentId: string;
  toolCallDurationMs: number;
  llmDurationMs: number;
  totalDurationMs: number;
  toolCallCount: number;
  llmCallCount: number;
}

/** Build a combined agent lookup map from discovery + registered agents */
export function buildAgentMap(
  discoveryAgents: DiscoveredAgent[],
  registeredAgents: RegisteredAgent[],
): Map<string, AgentLookup> {
  const map = new Map<string, AgentLookup>();
  // Registered agents first (UUIDs used in permissions/observations)
  for (const a of registeredAgents) {
    map.set(a.id, { name: a.name, emoji: a.metadata?.emoji || "\uD83E\uDD16" });
  }
  // Discovery agents overlay (richer info with emoji)
  for (const a of discoveryAgents) {
    map.set(a.id, { name: a.name, emoji: a.emoji || "\uD83E\uDD16" });
  }
  return map;
}
