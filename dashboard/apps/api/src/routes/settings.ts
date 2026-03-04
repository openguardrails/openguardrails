import { Router } from "express";
import { db, settingsQueries } from "@og/db";
import { maskSecret } from "@og/shared";
import { checkCoreHealth } from "../services/core-client.js";

const settings = settingsQueries(db);

export const settingsRouter = Router();

// GET /api/settings
settingsRouter.get("/", async (_req, res, next) => {
  try {
    const all = await settings.getAll();
    // Mask sensitive values
    const masked: Record<string, string> = {};
    for (const [key, value] of Object.entries(all)) {
      if (key === "og_core_key" || key === "session_token") {
        masked[key] = maskSecret(value);
      } else {
        masked[key] = value;
      }
    }
    res.json({ success: true, data: masked });
  } catch (err) {
    next(err);
  }
});

// PUT /api/settings
settingsRouter.put("/", async (req, res, next) => {
  try {
    const updates = req.body as Record<string, string>;
    if (!updates || typeof updates !== "object") {
      res.status(400).json({ success: false, error: "Request body must be a key-value object" });
      return;
    }

    // Prevent overwriting session_token via this endpoint
    delete updates.session_token;

    for (const [key, value] of Object.entries(updates)) {
      await settings.set(key, value);
    }

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/settings/connection-status
settingsRouter.get("/connection-status", async (_req, res, next) => {
  try {
    const ogCoreKey = await settings.get("og_core_key");

    // Agent is always connected to Core (auto-registered)
    // The only difference is whether it's linked to a user account (claimed) or not (autonomous)
    const mode = ogCoreKey ? "claimed" : "autonomous";

    res.json({
      success: true,
      data: {
        mode,
        message: mode === "claimed"
          ? "Agent is linked to your account"
          : "Agent is running in autonomous mode",
      },
    });
  } catch (err) {
    next(err);
  }
});
