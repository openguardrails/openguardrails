import type { Request, Response, NextFunction } from "express";
import { db, settingsQueries } from "@og/db";
import { SESSION_COOKIE_NAME, SESSION_TOKEN_PREFIX, DEFAULT_TENANT_ID } from "@og/shared";
import { generateSessionToken } from "@og/shared";

const settings = settingsQueries(db);

/** Ensure a session token exists in the database */
export async function ensureSessionToken(): Promise<string> {
  let token = await settings.get("session_token");
  if (!token) {
    token = generateSessionToken();
    await settings.set("session_token", token);
    console.log(`Session token generated: ${token}`);
  }
  return token;
}

/** Session authentication middleware */
export async function sessionAuth(req: Request, res: Response, next: NextFunction) {
  // Check cookie first
  const cookieToken = parseCookies(req.headers.cookie || "")[SESSION_COOKIE_NAME];
  // Then check Authorization header
  const headerToken = req.headers.authorization?.replace("Bearer ", "");

  const token = cookieToken || headerToken;

  if (!token) {
    res.status(401).json({ success: false, error: "Session token required" });
    return;
  }

  const validToken = await settings.get("session_token");
  if (!validToken || token !== validToken) {
    res.status(401).json({ success: false, error: "Invalid session token" });
    return;
  }

  res.locals.tenantId = DEFAULT_TENANT_ID;

  next();
}

function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const pair of cookieHeader.split(";")) {
    const [key, ...rest] = pair.trim().split("=");
    if (key) cookies[key] = rest.join("=");
  }
  return cookies;
}
