/**
 * Behavioral anomaly detector — runs at before_tool_call.
 *
 * Responsibilities:
 *   1. Collect high-risk tool calls (file read, shell, web fetch) and send to Core
 *   2. Record completed tool calls in the chain history
 *   3. Scan tool results locally for content injection patterns
 *   4. Core does all classification, signal computation, and risk decisions
 *   5. Fail-open: if Core is unavailable, allow execution
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
import { scanForInjection, type InjectionScanResult } from "./content-injection-scanner.js";

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

function sanitizeParams(params: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    const raw = typeof value === "string" ? value : JSON.stringify(value ?? "");
    result[key] = sanitizeContent(raw.slice(0, 500)).sanitized;
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

const MAX_SESSIONS = 200;
const MAX_CHAIN_ENTRIES = 50;

export class BehaviorDetector {
  private sessions = new Map<string, SessionState>();
  private coreCredentials: CoreCredentials | null = null;
  private config: DetectionConfig;
  private log: Logger;
  /** HTTP status codes we've already warned about — avoid log spam */
  private warnedStatuses = new Set<number>();

  constructor(config: DetectionConfig, log: Logger) {
    this.config = config;
    this.log = log;
  }

  setCredentials(creds: CoreCredentials | null): void {
    this.coreCredentials = creds;
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
   * Scan tool result text for content injection patterns.
   * Updates session state with findings for the next Core call.
   */
  scanToolResult(
    sessionKey: string,
    _toolName: string,
    textContent: string,
  ): InjectionScanResult {
    const result = scanForInjection(textContent);
    if (result.detected) {
      const state = this.getOrCreate(sessionKey);
      for (const match of result.matches) {
        state.contentInjectionFindings.push({
          category: match.category,
          confidence: match.confidence,
          matchedText: match.matchedText,
          pattern: match.pattern,
        });
      }
    }
    return result;
  }

  /**
   * Directly flag content injection on a session (fallback path).
   */
  flagContentInjection(sessionKey: string, labels: string[]): void {
    const state = this.getOrCreate(sessionKey);
    for (const label of labels) {
      state.contentInjectionFindings.push({
        category: label,
        confidence: "high",
        matchedText: "",
        pattern: label,
      });
    }
  }

  /**
   * Query whether content injection has been detected in this session.
   */
  hasContentInjection(sessionKey: string): boolean {
    const state = this.sessions.get(sessionKey);
    return (state?.contentInjectionFindings.length ?? 0) > 0;
  }

  /**
   * Called at before_tool_call. Returns a block decision or undefined (allow).
   *
   * Only high-risk tools (file read, shell, web fetch) are sent to Core.
   * Pure search tools (Glob, Grep, Search, etc.) skip Core entirely.
   * If Core is unavailable, fail-open (allow).
   */
  async onBeforeToolCall(
    ctx: { sessionKey: string; agentId?: string },
    event: { toolName: string; params: Record<string, unknown> },
  ): Promise<BlockDecision | undefined> {
    const isHighRisk =
      FILE_READ_TOOLS.has(event.toolName) ||
      SHELL_TOOLS.has(event.toolName) ||
      WEB_FETCH_TOOLS.has(event.toolName);

    if (!isHighRisk) return undefined;

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
            this.log.warn("Platform: API key invalid or agent not found — run /og_activate to re-register");
          } else if (response.status === 402) {
            this.log.warn("Platform: agent not activated — run /og_activate to complete setup");
          } else if (response.status === 403) {
            this.log.warn(`Platform: detection quota exceeded — visit ${this.config.coreUrl} to upgrade your plan`);
          } else {
            this.log.debug?.(`Platform: assess returned ${response.status}`);
          }
        }
        return null;
      }
      const json = (await response.json()) as {
        success: boolean;
        data?: BehaviorAssessResponse;
      };
      return json.success ? (json.data ?? null) : null;
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
