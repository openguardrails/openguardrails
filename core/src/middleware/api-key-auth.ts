import type { Request, Response, NextFunction } from "express";
import { db } from "../db/client.js";
import { agentQueries } from "../db/queries/agents.js";
import type { RegisteredAgent } from "../types.js";

const agents = agentQueries(db);

// Extend Express locals with authenticated agent
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Locals {
      agent: RegisteredAgent;
    }
  }
}

const INTERNAL_KEY = process.env.OG_INTERNAL_KEY || "";

/**
 * Validates `Authorization: Bearer sk-og-xxx` header.
 * Populates res.locals.agent on success.
 * Also accepts the internal key (X-Internal-Key header) for dashboard→core calls.
 */
export async function apiKeyAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // Internal key path (dashboard calling core)
  const internalKey = req.headers["x-internal-key"];
  if (INTERNAL_KEY && internalKey === INTERNAL_KEY) {
    // Internal caller — no agent context needed, skip agent lookup
    next();
    return;
  }

  // Agent API key path
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ success: false, error: "Missing Authorization header" });
    return;
  }

  const apiKey = authHeader.slice(7).trim();
  if (!apiKey.startsWith("sk-og-")) {
    res.status(401).json({ success: false, error: "Invalid API key format" });
    return;
  }

  const agent = await agents.findByApiKey(apiKey);
  if (!agent) {
    res.status(401).json({ success: false, error: "Invalid API key" });
    return;
  }

  if (agent.status === "suspended") {
    res.status(403).json({ success: false, error: "Agent account is suspended" });
    return;
  }

  if (agent.status === "pending_claim") {
    // 402 = not activated (claim + email verification incomplete)
    res.status(402).json({
      success: false,
      error: "Agent not yet activated. Complete email verification first.",
    });
    return;
  }

  res.locals.agent = agent;
  next();
}

/**
 * Quota check middleware — must run after apiKeyAuth.
 * Records usage and returns 402 if quota is exhausted.
 */
export function quotaCheck(endpoint: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Internal calls bypass quota
    if (!res.locals.agent) {
      next();
      return;
    }

    const agent = res.locals.agent;
    const quota = await agents.getQuota(agent.id);
    if (!quota) {
      res.status(500).json({ success: false, error: "Failed to read quota" });
      return;
    }

    if (quota.remaining <= 0) {
      // 403 = quota exceeded (authenticated but not permitted to call)
      res.status(403).json({
        success: false,
        error: "Quota exhausted. Upgrade your plan at https://platform.openguardrails.com/billing",
        data: { quotaTotal: quota.total, quotaUsed: quota.used, remaining: 0 },
      });
      return;
    }

    // Attach start time for latency tracking
    res.locals.startTime = Date.now();
    res.locals.endpoint = endpoint;
    next();
  };
}

/**
 * Call after sending the response to record usage.
 */
export async function recordUsage(agentId: string, endpoint: string, latencyMs: number, model?: string): Promise<void> {
  await agentQueries(db).consumeQuota(agentId, endpoint, latencyMs, model);
}
