/**
 * Type definitions for OpenGuardrails Plugin
 */

// =============================================================================
// Configuration Types
// =============================================================================

export type OpenClawGuardConfig = {
  enabled?: boolean;
  /** Enable AI Security Gateway */
  gatewayEnabled?: boolean;
  gatewayPort?: number;
  gatewayAutoStart?: boolean;
  blockOnRisk?: boolean;
  apiKey?: string;
  timeoutMs?: number;
  logPath?: string;
  autoRegister?: boolean;
  apiBaseUrl?: string;
  /** Dashboard URL (local embedded or remote standalone) */
  dashboardUrl?: string;
  /** Dashboard session token for auth */
  dashboardSessionToken?: string;
  /** Agent name for registration with dashboard */
  agentName?: string;
  /** Enable embedded dashboard on dashboardPort */
  dashboardEnabled?: boolean;
  /** Dashboard port (default: 28901) */
  dashboardPort?: number;
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
