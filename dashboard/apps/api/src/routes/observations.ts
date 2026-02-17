import { Router } from "express";
import { db, observationQueries } from "@og/db";

const observations = observationQueries(db);

export const observationsRouter = Router();

// POST /api/observations — Record one or more tool call observations
observationsRouter.post("/", async (req, res, next) => {
  try {
    const tenantId = res.locals.tenantId as string;
    const body = req.body;

    // Accept single object or array
    const items = Array.isArray(body) ? body : [body];

    for (const item of items) {
      if (!item.agentId || !item.toolName || !item.phase) {
        res.status(400).json({
          success: false,
          error: "agentId, toolName, and phase are required",
        });
        return;
      }

      await observations.record({
        agentId: item.agentId,
        sessionKey: item.sessionKey,
        toolName: item.toolName,
        params: item.params,
        phase: item.phase,
        result: item.result,
        error: item.error,
        durationMs: item.durationMs,
        blocked: item.blocked,
        blockReason: item.blockReason,
        tenantId,
      });
    }

    res.status(201).json({ success: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/observations — Recent observations (optional ?agentId= filter)
observationsRouter.get("/", async (req, res, next) => {
  try {
    const tenantId = res.locals.tenantId as string;
    const agentId = req.query.agentId as string | undefined;
    const limit = parseInt(req.query.limit as string) || 50;

    const data = await observations.findRecent({ agentId, limit, tenantId });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// GET /api/observations/capabilities — All capabilities across all agents
observationsRouter.get("/capabilities", async (req, res, next) => {
  try {
    const tenantId = res.locals.tenantId as string;
    const data = await observations.getAllCapabilities(tenantId);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// GET /api/observations/anomalies — First-seen tool calls
observationsRouter.get("/anomalies", async (req, res, next) => {
  try {
    const tenantId = res.locals.tenantId as string;
    const limit = parseInt(req.query.limit as string) || 20;

    const data = await observations.findAnomalies(tenantId, limit);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// GET /api/observations/summary — Per-agent summary
observationsRouter.get("/summary", async (req, res, next) => {
  try {
    const tenantId = res.locals.tenantId as string;
    const data = await observations.summary(tenantId);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// GET /api/agents/:id/capabilities — Capability profile for an agent
observationsRouter.get("/agents/:id/capabilities", async (req, res, next) => {
  try {
    const tenantId = res.locals.tenantId as string;
    const agentId = req.params.id as string;

    const data = await observations.getCapabilities(agentId, tenantId);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// GET /api/agents/:id/observations — Observations for a specific agent
observationsRouter.get("/agents/:id/observations", async (req, res, next) => {
  try {
    const tenantId = res.locals.tenantId as string;
    const agentId = req.params.id as string;
    const limit = parseInt(req.query.limit as string) || 50;

    const data = await observations.findRecent({ agentId, limit, tenantId });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});
