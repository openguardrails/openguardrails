// ─── Agents ─────────────────────────────────────────────────────
export type AgentStatus = "active" | "inactive" | "disconnected";
export type AgentProvider = "openclaw" | "langchain" | "crewai" | "autogen" | "custom";

export interface Agent {
  id: string;
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
