import { Router } from "express";
import { db, detectionResultQueries } from "@og/db";

const results = detectionResultQueries(db);

export const resultsRouter = Router();

// GET /api/results
resultsRouter.get("/", async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const agentId = req.query.agentId as string | undefined;

    const data = agentId
      ? await results.findByAgentId(agentId, { limit, offset })
      : await results.findAll({ limit, offset });

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});
