import { Router } from "express";
import { db, settingsQueries } from "@og/db";
import { SESSION_COOKIE_NAME } from "@og/shared";

const settings = settingsQueries(db);

export const sessionRouter = Router();

// POST /api/session/verify
sessionRouter.post("/verify", async (req, res, next) => {
  try {
    const { token } = req.body;
    if (!token) {
      res.status(400).json({ success: false, error: "token is required" });
      return;
    }

    const validToken = await settings.get("session_token");
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
  } catch (err) {
    next(err);
  }
});

// POST /api/session/logout
sessionRouter.post("/logout", (_req, res) => {
  res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
  res.json({ success: true });
});
