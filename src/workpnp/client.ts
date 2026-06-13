/**
 * WorkPnP API client — exactly the worker surface of CONTRACT_v0.md §2.
 *
 * Auth: workers send `Authorization: Bearer <apiKey>`. Registration is open
 * (no auth) and returns the apiKey exactly once — the server stores a hash.
 *
 * Endpoints used here:
 *   POST /api/workers/register {name, walletAddress?, agentKind} → {workerId, apiKey}
 *   GET  /api/me                                                → own profile + unpaid wages
 *   GET  /api/work?status=open                                  → open work items
 *   GET  /api/work/:id                                          → work item detail
 *   POST /api/work/:id/submit  (body = Forecast JSON)           → {submissionId, status:"accepted"}
 *                                                                  or 400 {error, reason}
 */

import type { Forecast, WorkItem } from "../core/types.js";

export interface RegisterRequest {
  name: string;
  walletAddress?: string;
  agentKind: string;
}

export interface RegisterResponse {
  workerId: string;
  apiKey: string;
}

export interface SubmitResponse {
  submissionId: string;
  status: "accepted";
}

export class WorkPnpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly reason?: string,
  ) {
    super(message);
    this.name = "WorkPnpError";
  }
}

export interface WorkPnpClientOptions {
  /** Defaults to WORKPNP_URL env, then http://localhost:8787. */
  baseUrl?: string;
  /** Defaults to WORKPNP_API_KEY env. Only needed for authed endpoints. */
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export class WorkPnpClient {
  readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: WorkPnpClientOptions = {}, env: NodeJS.ProcessEnv = process.env) {
    this.baseUrl = (opts.baseUrl ?? env["WORKPNP_URL"] ?? "http://localhost:8787").replace(/\/+$/, "");
    this.apiKey = opts.apiKey ?? env["WORKPNP_API_KEY"];
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** POST /api/workers/register — open registration, apiKey returned once. */
  async register(req: RegisterRequest): Promise<RegisterResponse> {
    return this.request<RegisterResponse>("POST", "/api/workers/register", {
      body: req,
      auth: false,
    });
  }

  /** GET /api/me — own profile + unpaid wages. Requires apiKey. */
  async me(): Promise<unknown> {
    return this.request<unknown>("GET", "/api/me", { auth: true });
  }

  /** GET /api/work?status=open — open work items (public, no submission contents). */
  async listOpenWork(): Promise<WorkItem[]> {
    return this.request<WorkItem[]>("GET", "/api/work?status=open", { auth: false });
  }

  /** GET /api/work/:id — work item detail. */
  async getWork(id: string): Promise<WorkItem> {
    return this.request<WorkItem>("GET", `/api/work/${encodeURIComponent(id)}`, { auth: false });
  }

  /**
   * POST /api/work/:id/submit — body is the Forecast JSON itself (contract §1.1).
   * One submission per worker per work item; re-submitting before closesAt
   * overwrites (last one counts).
   */
  async submitForecast(workId: string, forecast: Forecast): Promise<SubmitResponse> {
    return this.request<SubmitResponse>("POST", `/api/work/${encodeURIComponent(workId)}/submit`, {
      body: forecast,
      auth: true,
    });
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    opts: { body?: unknown; auth: boolean },
  ): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.auth) {
      if (!this.apiKey) {
        throw new WorkPnpError(
          "WORKPNP_API_KEY is not set — run `openthomas register --name <name>` and export the key",
          0,
        );
      }
      headers["authorization"] = `Bearer ${this.apiKey}`;
    }
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!res.ok) {
      const err = (parsed ?? {}) as { error?: string; reason?: string };
      throw new WorkPnpError(
        `WorkPnP ${res.status} on ${method} ${path}: ${err.error ?? (text || res.statusText)}`,
        res.status,
        err.reason,
      );
    }
    return parsed as T;
  }
}
