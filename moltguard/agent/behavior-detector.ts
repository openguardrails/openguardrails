/**
 * Behavioral anomaly detector — runs at before_tool_call.
 *
 * Responsibilities:
 *   1. Collect high-risk tool calls (file read, shell, web fetch) and send to Core
 *   2. Record completed tool calls in the chain history
 *   3. Core does all classification, signal computation, and risk decisions
 *   4. Fail-open: if Core is unavailable, allow execution
 */

import { randomBytes } from "node:crypto";
import type { CoreCredentials } from "./config.js";
import type {
  ToolChainEntry,
  BehaviorAssessRequest,
  BehaviorAssessResponse,
  PendingToolCall,
  ContentInjectionFinding,
  Logger,
  DetectionFinding,
} from "./types.js";
import { sanitizeContent } from "./sanitizer.js";

// =============================================================================
// Tool Sets — used to decide whether to send a tool call to Core
// =============================================================================

export const FILE_READ_TOOLS = new Set([
  "Read", "read_file", "read", "cat", "head", "tail", "view",
  "get_file_contents", "open_file",
]);

export const SHELL_TOOLS = new Set([
  "Bash", "bash", "shell", "run_command", "execute", "terminal",
  "cmd", "powershell",
]);

export const WEB_FETCH_TOOLS = new Set([
  "WebFetch", "web_fetch", "fetch", "http_request", "get_url",
  "browser_navigate", "navigate",
]);

// =============================================================================
// Session State (lightweight — only chain history + content findings)
// =============================================================================

interface SessionState {
  sessionKey: string;
  runId: string;
  userIntent: string;
  recentUserMessages: string[];
  completedChain: ToolChainEntry[];
  nextSeq: number;
  contentInjectionFindings: ContentInjectionFinding[];
  startedAt: number;
}

// =============================================================================
// Param Sanitization
// =============================================================================

/** Module-level secret detection callback (set by BehaviorDetector) */
let secretDetectionCallback: ((typeCounts: Record<string, number>) => void) | null = null;

function sanitizeParams(params: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  const allRedactions: Record<string, number> = {};
  for (const [key, value] of Object.entries(params)) {
    const raw = typeof value === "string" ? value : JSON.stringify(value ?? "");
    const sanitized = sanitizeContent(raw.slice(0, 500));
    result[key] = sanitized.sanitized;
    // Accumulate redaction types
    if (sanitized.redactions) {
      for (const [type, count] of Object.entries(sanitized.redactions)) {
        allRedactions[type] = (allRedactions[type] ?? 0) + (count as number);
      }
    }
  }
  // Report secret detections if any
  if (Object.keys(allRedactions).length > 0 && secretDetectionCallback) {
    secretDetectionCallback(allRedactions);
  }
  return result;
}

// =============================================================================
// BehaviorDetector
// =============================================================================

export type BlockDecision = { block: true; blockReason: string; findings?: DetectionFinding[] };
export type DetectionConfig = {
  coreUrl: string;
  /** Timeout for Core assess call (ms). Capped at ~3s to avoid holding up agent. */
  assessTimeoutMs: number;
  blockOnRisk: boolean;
  pluginVersion: string;
};

/** Response from Core content scan API */
export type ContentScanResult = {
  detected: boolean;
  categories: string[];
  findings: Array<{
    scanner: string;
    name: string;
    matchedText: string;
    confidence: "high" | "medium" | "low";
  }>;
  summary: string;
  latency_ms: number;
};

/** Response when quota is exceeded - still a success but no verdict */
export type QuotaExceededInfo = {
  quotaExceeded: true;
  quotaUsed: number;
  quotaTotal: number;
  /** true = autonomous mode (no email), false = human managed mode (email verified) */
  isAutonomous: boolean;
  resetAt: string | null;
  upgradeUrl: string;
  message: string;
  /** Persuasive message for the agent to convince the user to purchase */
  recommendation: string;
};

/** Callback for quota exceeded notification */
export type OnQuotaExceededCallback = (info: QuotaExceededInfo) => void;

const MAX_SESSIONS = 200;
const MAX_CHAIN_ENTRIES = 50;

export class BehaviorDetector {
  private sessions = new Map<string, SessionState>();
  private coreCredentials: CoreCredentials | null = null;
  private config: DetectionConfig;
  private log: Logger;
  /** HTTP status codes we've already warned about — avoid log spam */
  private warnedStatuses = new Set<number>();
  /** Track if we've already notified about quota exceeded (avoid spam) */
  private quotaExceededNotified = false;
  /** Callback for quota exceeded notification */
  private onQuotaExceeded: OnQuotaExceededCallback | null = null;
  /** Pending quota exceeded message to append to next tool result */
  private pendingQuotaMessage: QuotaExceededInfo | null = null;
  /** Callback for secret detection (business reporting) */
  private onSecretDetected: ((typeCounts: Record<string, number>) => void) | null = null;

  constructor(config: DetectionConfig, log: Logger) {
    this.config = config;
    this.log = log;
  }

  setCredentials(creds: CoreCredentials | null): void {
    this.coreCredentials = creds;
  }

  /** Set callback for when quota is exceeded */
  setOnQuotaExceeded(callback: OnQuotaExceededCallback | null): void {
    this.onQuotaExceeded = callback;
  }

  /** Set callback for when secrets are detected in params (business reporting) */
  setOnSecretDetected(callback: ((typeCounts: Record<string, number>) => void) | null): void {
    this.onSecretDetected = callback;
    secretDetectionCallback = callback;
  }

  /** Reset quota exceeded notification flag (e.g., on new day) */
  resetQuotaExceededNotification(): void {
    this.quotaExceededNotified = false;
    this.pendingQuotaMessage = null;
  }

  /** Get and clear pending quota message (for appending to tool results) */
  consumePendingQuotaMessage(): QuotaExceededInfo | null {
    const msg = this.pendingQuotaMessage;
    this.pendingQuotaMessage = null;
    return msg;
  }

  setUserIntent(sessionKey: string, message: string): void {
    const state = this.getOrCreate(sessionKey);
    if (!state.userIntent) {
      state.userIntent = message.slice(0, 500);
    }
    state.recentUserMessages = [
      ...state.recentUserMessages.slice(-4),
      message.slice(0, 200),
    ];
  }

  clearSession(sessionKey: string): void {
    this.sessions.delete(sessionKey);
  }

  /**
   * Called at before_tool_call. Returns a block decision or undefined (allow).
   *
   * All tool calls are sent to Core to build a complete tool chain.
   * If Core is unavailable, fail-open (allow).
   */
  async onBeforeToolCall(
    ctx: { sessionKey: string; agentId?: string },
    event: { toolName: string; params: Record<string, unknown> },
  ): Promise<BlockDecision | undefined> {
    // No credentials → can't call Core → allow
    if (!this.coreCredentials) return undefined;

    const state = this.getOrCreate(ctx.sessionKey);

    // Build pendingTool
    const pendingTool: PendingToolCall = {
      toolName: event.toolName,
      params: sanitizeParams(event.params),
    };

    // Collect content injection findings (if any)
    const contentFindings = state.contentInjectionFindings.length > 0
      ? [...state.contentInjectionFindings]
      : undefined;

    // Call Core assess API
    const req: BehaviorAssessRequest = {
      agentId: this.coreCredentials.agentId,
      sessionKey: ctx.sessionKey,
      runId: state.runId,
      userIntent: state.userIntent,
      toolChain: state.completedChain,
      pendingTool,
      contentFindings,
      context: {
        messageHistoryLength: state.recentUserMessages.length,
        recentUserMessages: state.recentUserMessages.slice(-3),
      },
      meta: {
        pluginVersion: this.config.pluginVersion,
        clientTimestamp: new Date().toISOString(),
      },
    };

    const verdict = await this.callAssessApi(req);

    // Fail-open: Core unavailable → allow
    if (!verdict) return undefined;

    if (verdict.action === "block" && this.config.blockOnRisk) {
      return {
        block: true,
        blockReason:
          `OpenGuardrails blocked [${verdict.riskLevel}]: ${verdict.explanation} ` +
          `(confidence: ${Math.round(verdict.confidence * 100)}%)`,
        findings: verdict.findings,
      };
    }

    if (verdict.action === "block" || verdict.action === "alert") {
      this.log.warn(
        `Behavioral anomaly [${verdict.riskLevel}/${Math.round(verdict.confidence * 100)}%]: ${verdict.explanation}`,
      );
    }

    return undefined;
  }

  /**
   * Called at after_tool_call. Records the completed tool in the chain.
   */
  onAfterToolCall(
    ctx: { sessionKey: string },
    event: {
      toolName: string;
      params: Record<string, unknown>;
      result?: unknown;
      error?: string;
      durationMs?: number;
    },
  ): void {
    const state = this.sessions.get(ctx.sessionKey);
    if (!state) return;

    const resultStr =
      typeof event.result === "string" ? event.result : JSON.stringify(event.result ?? "");
    const resultSizeBytes = Buffer.byteLength(resultStr, "utf-8");

    let resultCategory: ToolChainEntry["resultCategory"] = "empty";
    if (event.error) resultCategory = "error";
    else if (resultSizeBytes > 100_000) resultCategory = "text_large";
    else if (resultSizeBytes > 0) resultCategory = "text_small";

    const entry: ToolChainEntry = {
      seq: state.nextSeq++,
      toolName: event.toolName,
      sanitizedParams: sanitizeParams(event.params),
      outcome: event.error ? "error" : "success",
      durationMs: event.durationMs ?? 0,
      resultCategory,
      resultSizeBytes,
    };

    state.completedChain.push(entry);
    if (state.completedChain.length > MAX_CHAIN_ENTRIES) {
      state.completedChain.shift();
    }
  }

  /**
   * Scan tool result content for injection patterns via Core API.
   * Returns scan result or null if scan failed/unavailable.
   */
  async scanContent(
    sessionKey: string,
    toolName: string,
    content: string,
  ): Promise<ContentScanResult | null> {
    if (!this.coreCredentials) return null;

    // Limit content size (max 100KB to avoid timeout)
    const maxSize = 100 * 1024;
    const truncatedContent = content.length > maxSize ? content.slice(0, maxSize) : content;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.assessTimeoutMs);

    try {
      const response = await fetch(`${this.config.coreUrl}/api/v1/content/scan`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.coreCredentials.apiKey}`,
        },
        body: JSON.stringify({
          content: truncatedContent,
          toolName,
          sessionKey,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        this.log.debug?.(`Core content-scan returned ${response.status}`);
        return null;
      }

      const json = (await response.json()) as {
        success: boolean;
        data?: ContentScanResult;
      };

      if (!json.success || !json.data) return null;

      this.log.info(
        `Core content-scan: detected=${json.data.detected}, ` +
        `categories=[${json.data.categories.join(",")}], ` +
        `findings=${json.data.findings.length}`,
      );

      return json.data;
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        this.log.debug?.(`Core content-scan error: ${err}`);
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Private helpers ──────────────────────────────────────────────

  private getOrCreate(sessionKey: string): SessionState {
    if (!this.sessions.has(sessionKey)) {
      if (this.sessions.size >= MAX_SESSIONS) {
        let oldest: string | null = null;
        let oldestTime = Infinity;
        for (const [key, state] of this.sessions) {
          if (state.startedAt < oldestTime) {
            oldestTime = state.startedAt;
            oldest = key;
          }
        }
        if (oldest) this.sessions.delete(oldest);
      }
      this.sessions.set(sessionKey, {
        sessionKey,
        runId: `run-${randomBytes(8).toString("hex")}`,
        userIntent: "",
        recentUserMessages: [],
        completedChain: [],
        nextSeq: 0,
        contentInjectionFindings: [],
        startedAt: Date.now(),
      });
    }
    return this.sessions.get(sessionKey)!;
  }

  private async callAssessApi(req: BehaviorAssessRequest): Promise<BehaviorAssessResponse | null> {
    if (!this.coreCredentials) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.assessTimeoutMs);
    this.log.info(`Core: calling assess API for tool "${req.pendingTool?.toolName}" (session=${req.sessionKey?.slice(0, 8)}...)`);
    try {
      const response = await fetch(`${this.config.coreUrl}/api/v1/behavior/assess`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.coreCredentials.apiKey}`,
        },
        body: JSON.stringify(req),
        signal: controller.signal,
      });
      if (!response.ok) {
        if (!this.warnedStatuses.has(response.status)) {
          this.warnedStatuses.add(response.status);
          if (response.status === 401) {
            this.log.warn("Platform: API key invalid or agent not found");
          } else if (response.status === 403) {
            this.log.warn(`Platform: access denied — visit ${this.config.coreUrl} for details`);
          } else {
            this.log.debug?.(`Platform: assess returned ${response.status}`);
          }
        }
        return null;
      }
      const json = (await response.json()) as {
        success: boolean;
        data?: BehaviorAssessResponse & Partial<QuotaExceededInfo>;
      };

      // Log raw Core response for debugging
      this.log.warn(`Core response: ${JSON.stringify(json, null, 2)}`);

      if (!json.success) return null;
      if (!json.data) return null;

      // Handle quota exceeded response
      if (json.data.quotaExceeded) {
        const info: QuotaExceededInfo = {
          quotaExceeded: true,
          quotaUsed: json.data.quotaUsed ?? 0,
          quotaTotal: json.data.quotaTotal ?? 0,
          isAutonomous: json.data.isAutonomous ?? true,
          resetAt: json.data.resetAt ?? null,
          upgradeUrl: json.data.upgradeUrl ?? "",
          message: json.data.message ?? "Quota exceeded",
          recommendation: json.data.recommendation ?? "",
        };

        const isFirstNotify = !this.quotaExceededNotified;
        this.log.warn(
          `Core: quota exceeded (${info.quotaUsed}/${info.quotaTotal}, ` +
          `autonomous=${info.isAutonomous}, firstNotify=${isFirstNotify})`,
        );

        // Always set pending message if there isn't one already
        // This ensures the message gets through even if previous attempts failed
        if (!this.pendingQuotaMessage) {
          this.pendingQuotaMessage = info;
          this.log.info("Core: stored pending quota message for next tool result");
        }

        // First time notification: trigger callback
        if (isFirstNotify) {
          this.quotaExceededNotified = true;
          if (this.onQuotaExceeded) {
            this.onQuotaExceeded(info);
          }
        }

        // Return null to fail-open (allow execution, no detection)
        return null;
      }

      return json.data;
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        this.log.debug?.(`Assess API error: ${err}`);
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
