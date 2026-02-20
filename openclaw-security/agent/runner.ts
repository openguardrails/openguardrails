/**
 * Agent Runner - Multi-backend analysis
 *
 * Supports two detection backends:
 * 1. Dashboard (preferred) - Routes through local/remote dashboard → core
 * 2. OpenGuardrails API (fallback) - Direct API call
 *
 * Content is always sanitized locally before being sent to any API.
 */

import type {
  AnalysisTarget,
  AnalysisVerdict,
  Finding,
  Logger,
  OpenGuardrailsApiResponse,
} from "./types.js";
import {
  DEFAULT_PLATFORM_URL,
  loadCoreCredentials,
  registerWithCore,
} from "./config.js";
import { sanitizeContent } from "./sanitizer.js";

// =============================================================================
// Runner Config
// =============================================================================

export type RunnerConfig = {
  apiKey: string;
  timeoutMs: number;
  autoRegister: boolean;
  apiBaseUrl: string;
  /** Dashboard URL - when set, uses dashboard for detection */
  dashboardUrl?: string;
  /** Dashboard session token */
  dashboardSessionToken?: string;
};

// =============================================================================
// Dashboard Detection
// =============================================================================

type DashboardDetectResult = {
  success: boolean;
  data?: {
    safe: boolean;
    verdict: string;
    categories: string[];
    sensitivity_score: number;
    findings: Array<{ scanner: string; name: string; description: string }>;
    latency_ms: number;
    request_id: string;
    policy_action?: string;
  };
  blocked?: boolean;
  error?: string;
};

async function runViaDashboard(
  sanitizedContent: string,
  config: RunnerConfig,
  log: Logger,
): Promise<AnalysisVerdict> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (config.dashboardSessionToken) {
      headers["Authorization"] = `Bearer ${config.dashboardSessionToken}`;
    }

    const response = await fetch(`${config.dashboardUrl}/api/detect`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        messages: [{ role: "user", content: sanitizedContent }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Dashboard API error: ${response.status} ${text}`);
    }

    const result = (await response.json()) as DashboardDetectResult;

    if (!result.success || !result.data) {
      throw new Error(`Dashboard error: ${result.error ?? "unknown"}`);
    }

    const data = result.data;

    const findings: Finding[] = data.findings.map((f) => ({
      suspiciousContent: f.name,
      reason: f.description,
      confidence: data.sensitivity_score,
    }));

    return {
      isInjection: !data.safe,
      confidence: data.sensitivity_score,
      reason: data.safe ? "No issues detected" : `Detected: ${data.categories.join(", ")}`,
      findings,
      chunksAnalyzed: 1,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

// =============================================================================
// OpenGuardrails API Detection (Fallback)
// =============================================================================

async function ensureApiKey(
  configKey: string,
  autoRegister: boolean,
  apiBaseUrl: string,
  log: Logger,
): Promise<string> {
  if (configKey) return configKey;

  const savedKey = loadCoreCredentials()?.apiKey;
  if (savedKey) return savedKey;

  if (!autoRegister) {
    throw new Error(
      "No API key configured and autoRegister is disabled. " +
      "Please set apiKey in your OpenGuardrails plugin config or enable autoRegister.",
    );
  }

  log.info("No API key found — registering with OpenGuardrails...");

  try {
    const creds = await registerWithCore("openclaw-agent", "OpenClaw AI Agent", apiBaseUrl);
    log.info("Registered with OpenGuardrails. API key saved to ~/.openclaw/credentials/openguardrails/credentials.json");
    return creds.apiKey;
  } catch (error) {
    throw new Error(
      `Failed to auto-register API key: ${error instanceof Error ? error.message : String(error)}. ` +
      "Please check your network connection or set apiKey manually in config."
    );
  }
}

export function mapApiResponseToVerdict(apiResponse: OpenGuardrailsApiResponse): AnalysisVerdict {
  const verdict = apiResponse.verdict;

  const findings: Finding[] = (verdict.findings ?? []).map((f) => ({
    suspiciousContent: f.suspiciousContent,
    reason: f.reason,
    confidence: f.confidence,
  }));

  return {
    isInjection: verdict.isInjection,
    confidence: verdict.confidence,
    reason: verdict.reason,
    findings,
    chunksAnalyzed: 1,
  };
}

async function runViaApi(
  sanitizedContent: string,
  config: RunnerConfig,
  log: Logger,
): Promise<AnalysisVerdict> {
  const baseUrl = config.apiBaseUrl || DEFAULT_PLATFORM_URL;
  const apiKey = await ensureApiKey(config.apiKey, config.autoRegister, baseUrl, log);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(`${baseUrl}/api/check/tool-call`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ content: sanitizedContent, async: false }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`OpenGuardrails API error: ${response.status} ${response.statusText}`);
    }

    const apiResponse = (await response.json()) as OpenGuardrailsApiResponse;

    if (!apiResponse.ok) {
      throw new Error(`OpenGuardrails API returned error: ${apiResponse.error ?? "unknown"}`);
    }

    return mapApiResponseToVerdict(apiResponse);
  } finally {
    clearTimeout(timeoutId);
  }
}

// =============================================================================
// Main Analysis Function
// =============================================================================

export async function runGuardAgent(
  target: AnalysisTarget,
  config: RunnerConfig,
  log: Logger,
): Promise<AnalysisVerdict> {
  const startTime = Date.now();

  log.info(`Analyzing content: ${target.content.length} chars`);

  // Always sanitize locally first
  const { sanitized, redactions, totalRedactions } = sanitizeContent(target.content);
  if (totalRedactions > 0) {
    log.info(`Sanitized ${totalRedactions} sensitive items: ${Object.entries(redactions).map(([k, v]) => `${v} ${k}`).join(", ")}`);
  }

  try {
    let verdict: AnalysisVerdict;

    // Route to dashboard if configured, otherwise fall back to API
    if (config.dashboardUrl) {
      log.info("Using dashboard for detection");
      verdict = await runViaDashboard(sanitized, config, log);
    } else {
      verdict = await runViaApi(sanitized, config, log);
    }

    const durationMs = Date.now() - startTime;
    log.info(`Analysis complete in ${durationMs}ms: ${verdict.isInjection ? "INJECTION DETECTED" : "SAFE"}`);

    return verdict;
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      log.warn("Analysis timed out");
      return {
        isInjection: false,
        confidence: 0,
        reason: "Timeout",
        findings: [],
        chunksAnalyzed: 0,
      };
    }
    throw error;
  }
}
