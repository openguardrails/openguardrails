import { Router } from "express";
import { LOCAL_SESSION_TOKEN } from "../middleware/session-auth.js";

export const authRouter = Router();

/**
 * GET /api/auth/me
 *
 * Returns session info. Only supports session token authentication.
 */
authRouter.get("/me", async (req, res) => {
  // Check session token from URL param or Authorization header
  const urlToken = req.query.token as string | undefined;
  const bearerToken = req.headers.authorization?.replace("Bearer ", "");
  const token = urlToken || bearerToken;

  if (token && LOCAL_SESSION_TOKEN && token === LOCAL_SESSION_TOKEN) {
    res.json({
      success: true,
      email: null,
      agentId: null,
      name: "Local Dashboard",
      isLocal: true,
      authMethod: "sessionToken",
    });
    return;
  }

  res.status(401).json({ success: false, error: "Invalid session token" });
});

/**
 * POST /api/auth/logout
 *
 * No-op for session token auth (token is managed by the launcher).
 */
authRouter.post("/logout", (_req, res) => {
  res.json({ success: true });
});
