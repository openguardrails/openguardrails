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

// Keep old names as aliases for backwards compat during transition
export type PlatformDetectRequest = DashboardDetectRequest;
export type PlatformDetectResponse = DashboardDetectResponse;
export type PlatformClientConfig = DashboardClientConfig;
