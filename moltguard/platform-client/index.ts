/**
 * DashboardClient - SDK for communicating with OpenGuardrails Dashboard
 *
 * Handles:
 * - Agent registration & heartbeat
 * - Detection requests (routed through dashboard → core)
 * - Usage & results queries
 *
 * Works with both local embedded dashboard and remote standalone dashboard.
 */

import fs from "node:fs";
import path from "node:path";
import { openclawHome } from "../agent/env.js";
import type {
  DashboardClientConfig,
  DashboardDetectRequest,
  DashboardDetectResponse,
  AgentRegisterRequest,
  ToolCallObservationRequest,
  AgentPermission,
  DetectionResultRequest,
  AgenticHoursRequest,
} from "./types.js";

export class DashboardClient {
  private config: Required<DashboardClientConfig>;

  private debugFileLog(msg: string): void {
    try {
      const logPath = path.join(openclawHome, "logs", "moltguard-debug.log");
      fs.appendFileSync(logPath, `[${new Date().toISOString()}] [DashboardClient] ${msg}\n`);
    } catch { /* ignore */ }
  }

  constructor(config: DashboardClientConfig) {
    this.config = {
      dashboardUrl: config.dashboardUrl.replace(/\/$/, ""),
      sessionToken: config.sessionToken,
      agentId: config.agentId ?? "",
      timeoutMs: config.timeoutMs ?? 30000,
    };
  }

  get agentId(): string {
    return this.config.agentId;
  }

  private async request<T>(
    path: string,
    options: RequestInit = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.sessionToken}`,
        ...((options.headers as Record<string, string>) || {}),
      };

      const res = await fetch(`${this.config.dashboardUrl}${path}`, {
        ...options,
        headers,
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Dashboard API ${res.status}: ${text}`);
      }

      return (await res.json()) as T;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ─── Detection ──────────────────────────────────────────────────

  /**
   * Send messages for detection through the dashboard.
   * Dashboard handles scanner config, policy evaluation, and routes to core.
   */
  async detect(req: DashboardDetectRequest): Promise<DashboardDetectResponse> {
    return this.request<DashboardDetectResponse>("/api/detect", {
      method: "POST",
      body: JSON.stringify({
        ...req,
        agentId: req.agentId || this.config.agentId || undefined,
      }),
    });
  }

  // ─── Agent Management ───────────────────────────────────────────

  /** Register this agent with the dashboard (upserts by name) */
  async registerAgent(req: AgentRegisterRequest): Promise<{ success: boolean; data?: { id: string } }> {
    // Check if agent with same name already exists
    try {
      const list = await this.request<{ success: boolean; data: { id: string; name: string }[] }>(
        "/api/agents",
      );
      if (list.success && list.data) {
        const existing = list.data.find((a) => a.name === req.name);
        if (existing) {
          this.config.agentId = existing.id;
          // Update status and metadata
          await this.request(`/api/agents/${existing.id}`, {
            method: "PUT",
            body: JSON.stringify({
              status: "active",
              ...(req.provider && { provider: req.provider }),
              ...(req.metadata && { metadata: req.metadata }),
            }),
          }).catch(() => {});
          return { success: true, data: { id: existing.id } };
        }
      }
    } catch {
      // Fall through to create
    }

    const result = await this.request<{ success: boolean; data?: { id: string } }>(
      "/api/agents",
      {
        method: "POST",
        body: JSON.stringify(req),
      }
    );
    if (result.success && result.data?.id) {
      this.config.agentId = result.data.id;
    }
    return result;
  }

  /** Send heartbeat to indicate this agent is alive */
  async heartbeat(): Promise<void> {
    if (!this.config.agentId) return;
    await this.request(`/api/agents/${this.config.agentId}/heartbeat`, {
      method: "POST",
    });
  }

  /** Upload full agent profile (workspace files, skills, cron jobs, etc.) */
  async updateProfile(profile: Record<string, unknown>): Promise<void> {
    if (!this.config.agentId) return;
    await this.request(`/api/agents/${this.config.agentId}`, {
      method: "PUT",
      body: JSON.stringify({ metadata: profile }),
    });
  }

  /** Start periodic heartbeat */
  startHeartbeat(intervalMs = 60_000): NodeJS.Timeout {
    // Send first heartbeat immediately so agent shows as active right away
    this.heartbeat().catch(() => {});
    const timer = setInterval(() => {
      this.heartbeat().catch(() => {});
    }, intervalMs);
    timer.unref();
    return timer;
  }

  // ─── Tool Call Observations ─────────────────────────────────────

  /** Report a tool call observation to the dashboard */
  async reportToolCall(data: ToolCallObservationRequest): Promise<void> {
    await this.request("/api/observations", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  /** Report a detection result to the dashboard */
  async reportDetection(data: DetectionResultRequest): Promise<void> {
    await this.request("/api/detections", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  /** Get observed permissions for an agent */
  async getPermissions(agentId?: string): Promise<AgentPermission[]> {
    const id = agentId || this.config.agentId;
    if (!id) return [];
    const result = await this.request<{ success: boolean; data: AgentPermission[] }>(
      `/api/observations/agents/${id}/permissions`,
    );
    return result.data ?? [];
  }

  // ─── Agentic Hours ──────────────────────────────────────────────

  /** Report agentic hours data to the dashboard */
  async reportAgenticHours(data: AgenticHoursRequest): Promise<void> {
    await this.request("/api/agentic-hours", {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  // ─── Agentic Hours Accumulator ────────────────────────────────

  private hoursAccum = {
    toolCallDurationMs: 0,
    llmDurationMs: 0,
    totalDurationMs: 0,
    toolCallCount: 0,
    llmCallCount: 0,
    sessionCount: 0,
    blockCount: 0,
    riskEventCount: 0,
  };
  private hoursFlushTimer: NodeJS.Timeout | null = null;

  /** Record a tool call duration for agentic hours */
  recordToolCallDuration(durationMs: number, blocked = false): void {
    this.hoursAccum.toolCallDurationMs += durationMs;
    this.hoursAccum.totalDurationMs += durationMs;
    this.hoursAccum.toolCallCount += 1;
    if (blocked) this.hoursAccum.blockCount += 1;
    this.ensureHoursFlush();
  }

  /** Record an LLM call duration for agentic hours */
  recordLlmDuration(durationMs: number): void {
    this.hoursAccum.llmDurationMs += durationMs;
    this.hoursAccum.totalDurationMs += durationMs;
    this.hoursAccum.llmCallCount += 1;
    this.ensureHoursFlush();
  }

  /** Record a session start */
  recordSessionStart(): void {
    this.hoursAccum.sessionCount += 1;
    this.ensureHoursFlush();
  }

  /** Record a risk event */
  recordRiskEvent(): void {
    this.hoursAccum.riskEventCount += 1;
    this.ensureHoursFlush();
  }

  private ensureHoursFlush(): void {
    if (this.hoursFlushTimer) return;
    this.hoursFlushTimer = setTimeout(() => {
      this.flushAgenticHours();
      this.hoursFlushTimer = null;
    }, 60_000);
    this.hoursFlushTimer.unref();
  }

  private async flushAgenticHours(): Promise<void> {
    this.debugFileLog(`flushAgenticHours: agentId=${this.config.agentId} accum=${JSON.stringify(this.hoursAccum)}`);
    if (!this.config.agentId) { this.debugFileLog("flushAgenticHours: no agentId, skipping"); return; }
    const accum = { ...this.hoursAccum };
    // Reset
    this.hoursAccum = {
      toolCallDurationMs: 0,
      llmDurationMs: 0,
      totalDurationMs: 0,
      toolCallCount: 0,
      llmCallCount: 0,
      sessionCount: 0,
      blockCount: 0,
      riskEventCount: 0,
    };

    // Only flush if there's data
    const hasData =
      accum.totalDurationMs > 0 ||
      accum.toolCallCount > 0 ||
      accum.llmCallCount > 0 ||
      accum.sessionCount > 0;
    if (!hasData) return;

    try {
      this.debugFileLog(`flushAgenticHours: POSTing to dashboard: ${JSON.stringify(accum)}`);
      await this.reportAgenticHours({
        agentId: this.config.agentId,
        ...accum,
      });
      this.debugFileLog(`flushAgenticHours: POST success`);
    } catch (err) {
      this.debugFileLog(`flushAgenticHours: POST FAILED: ${err}`);
      // Re-add on failure
      this.hoursAccum.toolCallDurationMs += accum.toolCallDurationMs;
      this.hoursAccum.llmDurationMs += accum.llmDurationMs;
      this.hoursAccum.totalDurationMs += accum.totalDurationMs;
      this.hoursAccum.toolCallCount += accum.toolCallCount;
      this.hoursAccum.llmCallCount += accum.llmCallCount;
      this.hoursAccum.sessionCount += accum.sessionCount;
      this.hoursAccum.blockCount += accum.blockCount;
      this.hoursAccum.riskEventCount += accum.riskEventCount;
    }
  }

  /** Flush pending agentic hours and clean up timers */
  async stop(): Promise<void> {
    if (this.hoursFlushTimer) {
      clearTimeout(this.hoursFlushTimer);
      this.hoursFlushTimer = null;
    }
    await this.flushAgenticHours();
  }

  // ─── Health ───────────────────────────────────────────────────────

  /** Check if dashboard is reachable */
  async checkHealth(): Promise<boolean> {
    try {
      const res = await fetch(`${this.config.dashboardUrl}/health`);
      const json = (await res.json()) as { status: string };
      return json.status === "ok";
    } catch {
      return false;
    }
  }
}

// Keep PlatformClient as alias
export { DashboardClient as PlatformClient };

export {
  type DashboardClientConfig,
  type DashboardDetectRequest,
  type DashboardDetectResponse,
  type ToolCallObservationRequest,
  type AgentPermission,
  type DetectionResultRequest,
  type AgenticHoursRequest,
  type PlatformClientConfig,
  type PlatformDetectRequest,
  type PlatformDetectResponse,
} from "./types.js";
