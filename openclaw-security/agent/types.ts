/**
 * Type definitions for OpenGuardrails Plugin
 */

// =============================================================================
// Configuration Types
// =============================================================================

export type OpenClawGuardConfig = {
  enabled?: boolean;
  blockOnRisk?: boolean;
  /** sk-og-xxx API key for platform.openguardrails.com. Auto-registered if empty. */
  apiKey?: string;
  timeoutMs?: number;
  /** Platform URL for core API (registration + behavior detection).
   *  Default: https://platform.openguardrails.com */
  platformUrl?: string;
  /** @deprecated use platformUrl */
  apiBaseUrl?: string;
  /** Agent name for registration */
  agentName?: string;
  /** Dashboard URL (standalone, for optional reporting) */
  dashboardUrl?: string;
  /** Dashboard session token */
  dashboardSessionToken?: string;
};

// =============================================================================
// Analysis Types
// =============================================================================

export type AnalysisTarget = {
  type: "message" | "tool_call" | "tool_result";
  content: string;
  toolName?: string;
  toolParams?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type Finding = {
  suspiciousContent: string;
  reason: string;
  confidence: number; // 0-1
  location?: {
    start: number;
    end: number;
  };
};

export type AnalysisVerdict = {
  isInjection: boolean;
  confidence: number; // 0-1
  reason: string;
  findings: Finding[];
  chunksAnalyzed: number;
};

// =============================================================================
// OpenGuardrails API Response
// =============================================================================

export type OpenGuardrailsApiResponse = {
  ok: boolean;
  verdict: {
    isInjection: boolean;
    confidence: number;
    reason: string;
    findings: Array<{
      suspiciousContent: string;
      reason: string;
      confidence: number;
    }>;
  };
  error?: string;
};

// =============================================================================
// Analysis Log Types
// =============================================================================

export type AnalysisLogEntry = {
  id: number;
  timestamp: string;
  targetType: string;
  contentLength: number;
  chunksAnalyzed: number;
  verdict: AnalysisVerdict;
  durationMs: number;
  blocked: boolean;
};

// =============================================================================
// Logger Type
// =============================================================================

export type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
};

// =============================================================================
// Sanitization Types
// =============================================================================

export type SanitizeResult = {
  sanitized: string;
  redactions: Record<string, number>;
  totalRedactions: number;
};

// =============================================================================
// Behavioral Detection Types (mirrors core/src/types.ts contract)
// =============================================================================

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

export type RiskLevel = "no_risk" | "low" | "medium" | "high" | "critical";
export type AssessAction = "allow" | "alert" | "block";

export type ToolChainEntry = {
  seq: number;
  toolName: string;
  sanitizedParams: Record<string, string>;
  outcome: "success" | "error" | "timeout";
  durationMs: number;
  resultCategory: "text_small" | "text_large" | "binary" | "empty" | "error";
  resultSizeBytes: number;
  dataFlowFrom?: string;
};

export type LocalSignals = {
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
};

export type BehaviorAssessRequest = {
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
  /**
   * Client-supplied metadata for server-side correlation.
   * Server merges these with its own fields (sourceIp, apiKey ref, serverTimestamp)
   * before storing in behavior_events and surfacing in the dashboard.
   */
  meta: {
    pluginVersion: string;
    clientTimestamp: string; // ISO 8601
  };
};

export type BehaviorAssessResponse = {
  behaviorId: string;
  riskLevel: RiskLevel;
  anomalyTypes: string[];
  confidence: number;
  action: AssessAction;
  explanation: string;
  affectedTools: number[];
};
