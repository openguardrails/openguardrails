import type { Request, Response, NextFunction } from "express";
import { getEnv } from "../services/runtime-config.js";

// Local session token for local mode
// Set by the startup process when running via /og_dashboard
export let LOCAL_SESSION_TOKEN: string | null = getEnv("LOCAL_SESSION_TOKEN") || null;

/**
 * Set the local session token (called from index.ts on startup)
 */
export function setLocalSessionToken(token: string): void {
  LOCAL_SESSION_TOKEN = token;
}

/**
 * Session authentication middleware.
 *
 * Only supports session token authentication:
 *   - URL param: ?token=xxx (for browser access)
 *   - Authorization header: Bearer xxx (for plugin/API access)
 *
 * Sets res.locals.tenantId = "local" for all authenticated requests.
 */
export async function sessionAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // Check session token from URL param or Authorization header
  const urlToken = req.query.token as string | undefined;
  const bearerToken = req.headers.authorization?.replace("Bearer ", "");
  const token = urlToken || bearerToken;

  if (token && LOCAL_SESSION_TOKEN && token === LOCAL_SESSION_TOKEN) {
    res.locals.tenantId = "local";
    res.locals.userEmail = null;
    res.locals.agentId = null;
    res.locals.isLocal = true;
    res.locals.authMethod = "sessionToken";
    next();
    return;
  }

  res.status(401).json({ success: false, error: "Invalid session token" });
}
