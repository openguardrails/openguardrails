// ─── Agent Registration ──────────────────────────────────────────

export type AgentStatus = "pending_claim" | "active" | "suspended";

export interface RegisteredAgent {
  id: string;
  name: string;
  description: string | null;
  apiKey: string;           // sk-og-<32hex>
  claimToken: string;       // openguardrails_claim_<random>
  verificationCode: string; // reef-X4B2
  email: string | null;
  status: AgentStatus;
  quotaTotal: number;       // lifetime free quota + purchased
  quotaUsed: number;
  createdAt: string;
  updatedAt: string;
}

// ─── Account ────────────────────────────────────────────────────

export type AccountPlan = "free" | "starter" | "pro" | "business";

export interface Account {
  id: string;
  email: string;
  plan: AccountPlan;
  quotaTotal: number;
  quotaUsed: number;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Behavior Assessment ─────────────────────────────────────────

export type SensitivePathCategory =
  | "SSH_KEY"
  | "AWS_CREDS"
  | "GPG_KEY"
  | "ENV_FILE"
  | "CRYPTO_CERT"
  | "SYSTEM_AUTH"
  | "BROWSER_COOKIE"
  | "KEYCHAIN";

export type RiskTag =
  | "READ_SENSITIVE_WRITE_NETWORK"
  | "MULTI_CRED_ACCESS"
  | "SHELL_EXEC_AFTER_WEB_FETCH"
  | "DATA_EXFIL_PATTERN"
  | "INTENT_ACTION_MISMATCH"
  | "UNUSUAL_TOOL_SEQUENCE";

export type ResultCategory = "text_small" | "text_large" | "binary" | "empty" | "error";

export interface ToolChainEntry {
  seq: number;
  toolName: string;
  sanitizedParams: Record<string, string>;
  outcome: "success" | "error" | "timeout";
  durationMs: number;
  resultCategory: ResultCategory;
  resultSizeBytes: number;
  dataFlowFrom?: string;
}

export interface LocalSignals {
  sensitivePathsAccessed: SensitivePathCategory[];
  externalDomainsContacted: string[];
  patterns: {
    readThenExfil: boolean;
    credentialAccess: boolean;
    shellEscapeAttempt: boolean;
    crossAgentDataFlow: boolean;
  };
  intentToolOverlapScore: number;
  riskTags: RiskTag[];
}

export interface BehaviorAssessRequest {
  agentId: string;
  sessionKey: string;
  runId: string;
  userIntent: string;
  toolChain: ToolChainEntry[];
  localSignals: LocalSignals;
  context: {
    messageHistoryLength: number;
    recentUserMessages: string[];
  };
  /** Client-supplied metadata merged with server-captured fields for dashboard correlation */
  meta?: {
    pluginVersion?: string;
    clientTimestamp?: string; // ISO 8601
    model?: string;
  };
}

export type RiskLevel = "no_risk" | "low" | "medium" | "high" | "critical";
export type AssessAction = "allow" | "alert" | "block";

export interface BehaviorAssessResponse {
  behaviorId: string;
  riskLevel: RiskLevel;
  anomalyTypes: string[];
  confidence: number;
  action: AssessAction;
  explanation: string;
  affectedTools: number[];
}

// ─── Content Detection (S01-S10) ────────────────────────────────

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
  role?: "system" | "user" | "assistant" | "tool";
  agentId?: string;
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

// ─── API ────────────────────────────────────────────────────────

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}
