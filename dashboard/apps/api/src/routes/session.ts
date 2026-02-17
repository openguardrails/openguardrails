import { Router } from "express";
import { db, settingsQueries } from "@og/db";
import { SESSION_COOKIE_NAME } from "@og/shared";

const settings = settingsQueries(db);

function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const pair of cookieHeader.split(";")) {
    const [key, ...rest] = pair.trim().split("=");
    if (key) cookies[key] = rest.join("=");
  }
  return cookies;
}

export const sessionRouter = Router();

// POST /api/session/verify
sessionRouter.post("/verify", async (req, res, next) => {
  try {
    const { token } = req.body;
    const validToken = await settings.get("session_token");

    // If body token provided, validate and set cookie
    if (token) {
      if (!validToken || token !== validToken) {
        res.status(401).json({ success: false, error: "Invalid session token" });
        return;
      }

      // Set HTTP-only cookie
      res.cookie(SESSION_COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: "strict",
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
        path: "/",
      });

      res.json({ success: true });
      return;
    }

    // No body token — check existing cookie or Authorization header
    const cookieToken = parseCookies(req.headers.cookie || "")[SESSION_COOKIE_NAME];
    const bearerToken = req.headers.authorization?.replace("Bearer ", "");
    const existingToken = cookieToken || bearerToken;

    if (existingToken && validToken && existingToken === validToken) {
      res.json({ success: true });
      return;
    }

    res.status(401).json({ success: false, error: "Not authenticated" });
  } catch (err) {
    next(err);
  }
});

// POST /api/session/logout
sessionRouter.post("/logout", (_req, res) => {
  res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
  res.json({ success: true });
});
