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

import type {
  DashboardClientConfig,
  DashboardDetectRequest,
  DashboardDetectResponse,
  AgentRegisterRequest,
  ToolCallObservationRequest,
  AgentPermission,
} from "./types.js";

export class DashboardClient {
  private config: Required<DashboardClientConfig>;

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
          // Update status to active
          await this.request(`/api/agents/${existing.id}`, {
            method: "PUT",
            body: JSON.stringify({ status: "active" }),
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

  /** Start periodic heartbeat */
  startHeartbeat(intervalMs = 60_000): NodeJS.Timeout {
    return setInterval(() => {
      this.heartbeat().catch(() => {});
    }, intervalMs);
  }

  // ─── Tool Call Observations ─────────────────────────────────────

  /** Report a tool call observation to the dashboard */
  async reportToolCall(data: ToolCallObservationRequest): Promise<void> {
    await this.request("/api/observations", {
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
  type PlatformClientConfig,
  type PlatformDetectRequest,
  type PlatformDetectResponse,
} from "./types.js";
