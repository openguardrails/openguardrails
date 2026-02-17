// ─── Dashboard Mode ─────────────────────────────────────────────
export type DashboardMode = "embedded" | "selfhosted" | "saas";

// ─── Gateway Mode ───────────────────────────────────────────────
export type GatewayMode = "embedded" | "selfhosted" | "saas";

export interface TenantContext {
  tenantId: string;
  mode: DashboardMode;
}

// ─── Agents ─────────────────────────────────────────────────────
export type AgentStatus = "active" | "inactive" | "disconnected";
export type AgentProvider = "openclaw" | "langchain" | "crewai" | "autogen" | "custom";

export interface Agent {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  provider: AgentProvider;
  status: AgentStatus;
  lastSeenAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// ─── Policies ───────────────────────────────────────────────────
export type PolicyAction = "block" | "alert" | "log";

export interface Policy {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  scannerIds: string[];
  action: PolicyAction;
  sensitivityThreshold: number;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// ─── Detection Results ──────────────────────────────────────────
export interface DetectionResult {
  id: string;
  tenantId: string;
  agentId: string | null;
  safe: boolean;
  categories: string[];
  sensitivityScore: number;
  findings: unknown[];
  latencyMs: number;
  requestId: string;
  createdAt: string;
}

// ─── Usage ──────────────────────────────────────────────────────
export interface UsageLog {
  id: string;
  tenantId: string;
  agentId: string | null;
  endpoint: string;
  statusCode: number;
  responseSafe: boolean | null;
  categories: string[];
  latencyMs: number;
  requestId: string;
  createdAt: string;
}

export interface UsageSummary {
  totalCalls: number;
  safeCount: number;
  unsafeCount: number;
}

// ─── Scanners ───────────────────────────────────────────────────
export interface ScannerDefinition {
  id: string;
  tenantId: string;
  scannerId: string;
  name: string;
  description: string;
  config: Record<string, unknown>;
  isEnabled: boolean;
  isDefault: boolean;
}

// ─── Detection (core contract) ───────────────────────────────
export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface CoreScannerDef {
  scannerId: string;
  name: string;
  description: string;
  isEnabled: boolean;
}

export interface CoreDetectRequest {
  messages: unknown[];
  format?: "openai" | "anthropic" | "gemini" | "raw";
  scanners: CoreScannerDef[];
  role?: MessageRole;
}

export interface CoreDetectResponse {
  safe: boolean;
  verdict: "safe" | "unsafe";
  categories: string[];
  sensitivity_score: number;
  findings: Array<{ scanner: string; name: string; description: string }>;
  latency_ms: number;
  request_id: string;
}

// ─── API Responses ──────────────────────────────────────────────
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

// ─── Feature Types ──────────────────────────────────────────────
export type Feature = "discovery" | "detection" | "protection";

// ─── Tiers ─────────────────────────────────────────────────────
export type TierId = "free" | "starter" | "pro" | "business" | "enterprise";

export interface TierConfig {
  features: Feature[];
  maxAgents: number;
}

export const TIERS: Record<TierId, TierConfig> = {
  free: { features: ["discovery", "detection"], maxAgents: 1 },
  starter: { features: ["discovery", "detection"], maxAgents: 3 },
  pro: { features: ["discovery", "detection"], maxAgents: 5 },
  business: { features: ["discovery", "detection", "protection"], maxAgents: 10 },
  enterprise: { features: ["discovery", "detection", "protection"], maxAgents: 100 },
};
