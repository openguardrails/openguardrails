/** Types for Dashboard API communication */

export type DashboardDetectRequest = {
  messages: unknown[];
  format?: "openai" | "anthropic" | "gemini" | "raw";
  role?: "system" | "user" | "assistant" | "tool";
  agentId?: string;
};

export type DashboardDetectResponse = {
  success: boolean;
  data?: {
    safe: boolean;
    verdict: "safe" | "unsafe";
    categories: string[];
    sensitivity_score: number;
    findings: Array<{ scanner: string; name: string; description: string }>;
    latency_ms: number;
    request_id: string;
    policy_action?: "block" | "alert" | "log";
  };
  blocked?: boolean;
  error?: string;
};

export type AgentRegisterRequest = {
  name: string;
  description?: string;
  provider?: string;
  metadata?: Record<string, unknown>;
};

export type DashboardClientConfig = {
  /** Dashboard URL (local or remote) */
  dashboardUrl: string;
  /** Session token for dashboard auth */
  sessionToken: string;
  /** Agent ID (set after registration) */
  agentId?: string;
  /** Request timeout in ms */
  timeoutMs?: number;
};

// ─── Tool Call Observations ──────────────────────────────────────

export type ToolCallObservationRequest = {
  agentId: string;
  sessionKey?: string;
  toolName: string;
  params?: Record<string, unknown>;
  phase: "before" | "after";
  result?: unknown;
  error?: string;
  durationMs?: number;
  blocked?: boolean;
  blockReason?: string;
};

export type AgentCapability = {
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
};

// Keep old names as aliases for backwards compat during transition
export type PlatformDetectRequest = DashboardDetectRequest;
export type PlatformDetectResponse = DashboardDetectResponse;
export type PlatformClientConfig = DashboardClientConfig;
