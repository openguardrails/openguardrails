import type { Request, Response, NextFunction } from "express";
import { DEFAULT_TENANT_ID } from "@og/shared";

const CORE_URL = process.env.OG_CORE_URL || "http://localhost:53666";
const DASHBOARD_MODE = process.env.DASHBOARD_MODE || "selfhosted";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CachedSession {
  email: string;
  agentId: string;
  cachedAt: number;
}

// In-memory cache: apiKey → validated session info
const sessionCache = new Map<string, CachedSession>();

/**
 * Session authentication middleware.
 *
 * Expects: Authorization: Bearer sk-og-xxx
 * Validates the API key against the core (cached for 5 minutes).
 * Sets res.locals.tenantId and res.locals.coreApiKey.
 *
 * In selfhosted/embedded mode, tenantId is always DEFAULT_TENANT_ID ("default")
 * since the dashboard is single-tenant.
 */
export async function sessionAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const apiKey = req.headers.authorization?.replace("Bearer ", "");

  if (!apiKey?.startsWith("sk-og-")) {
    res.status(401).json({ success: false, error: "Not authenticated" });
    return;
  }

  // Single-tenant modes always use DEFAULT_TENANT_ID
  const isSingleTenant = DASHBOARD_MODE === "selfhosted" || DASHBOARD_MODE === "embedded";

  // Check in-memory cache
  const cached = sessionCache.get(apiKey);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    res.locals.tenantId = isSingleTenant ? DEFAULT_TENANT_ID : cached.email;
    res.locals.userEmail = cached.email;
    res.locals.coreApiKey = apiKey;
    next();
    return;
  }

  // Validate with core
  try {
    const coreRes = await fetch(`${CORE_URL}/api/v1/account`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!coreRes.ok) {
      res.status(401).json({ success: false, error: "Invalid or inactive API key" });
      return;
    }

    const data = await coreRes.json() as {
      success: boolean;
      email: string | null;
      agentId: string;
    };

    if (!data.success || !data.email) {
      res.status(401).json({ success: false, error: "Agent not activated" });
      return;
    }

    // Cache and populate locals
    sessionCache.set(apiKey, { email: data.email, agentId: data.agentId, cachedAt: Date.now() });
    res.locals.tenantId = isSingleTenant ? DEFAULT_TENANT_ID : data.email;
    res.locals.userEmail = data.email;
    res.locals.coreApiKey = apiKey;
    next();
  } catch {
    res.status(503).json({ success: false, error: "Core service unavailable" });
  }
}
