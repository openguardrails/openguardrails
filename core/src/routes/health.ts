import { Router } from "express";
import { db } from "../db/client.js";
import { registeredAgents } from "../db/schema.js";
import { sql } from "drizzle-orm";

export const healthRouter = Router();

healthRouter.get("/", async (_req, res) => {
  try {
    // Quick DB check
    const row = db.select({ count: sql<number>`count(*)` }).from(registeredAgents).get();
    res.json({
      status: "ok",
      service: "openguardrails-core",
      timestamp: new Date().toISOString(),
      db: "ok",
      agents: row?.count ?? 0,
    });
  } catch {
    res.status(503).json({ status: "error", service: "openguardrails-core", db: "error" });
  }
});
