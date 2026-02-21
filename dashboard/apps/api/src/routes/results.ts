import { Router } from "express";
import { db, detectionResultQueries } from "@og/db";

const results = detectionResultQueries(db);

export const resultsRouter = Router();

// GET /api/results
resultsRouter.get("/", async (req, res, next) => {
  try {
    const tenantId = res.locals.tenantId as string;
    const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);
    const agentId = req.query.agentId as string | undefined;

    const data = agentId
      ? await results.findByAgentId(agentId, { limit, offset, tenantId })
      : await results.findAll({ limit, offset, tenantId });

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});
