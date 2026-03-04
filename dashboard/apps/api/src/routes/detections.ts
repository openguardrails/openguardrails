import { Router } from "express";
import { db, detectionResultQueries } from "@og/db";

const detectionResults = detectionResultQueries(db);

export const detectionsRouter = Router();

/**
 * POST /api/detections
 * Record detection results from the plugin
 */
detectionsRouter.post("/", async (req, res, next) => {
  try {
    const tenantId = res.locals.tenantId as string;
    const {
      agentId,
      safe,
      categories,
      findings,
      sensitivityScore,
      latencyMs,
      quotaExceeded,
      quotaInfo,
    } = req.body;

    if (typeof safe !== "boolean") {
      res.status(400).json({ success: false, error: "safe (boolean) is required" });
      return;
    }

    await detectionResults.create({
      agentId: agentId || null,
      safe,
      categories: categories || [],
      sensitivityScore: sensitivityScore || 0,
      findings: findings || [],
      latencyMs: latencyMs || 0,
      requestId: crypto.randomUUID(),
      tenantId,
      // Store quota info in findings if exceeded
      ...(quotaExceeded && {
        findings: [{
          scanner: "quota",
          name: "quota_exceeded",
          description: `Quota exceeded: ${quotaInfo?.used || 0}/${quotaInfo?.total || 0}`,
        }],
      }),
    });

    res.status(201).json({ success: true });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/detections
 * Get recent detection results
 */
detectionsRouter.get("/", async (req, res, next) => {
  try {
    const tenantId = res.locals.tenantId as string;
    const limit = parseInt(req.query.limit as string) || 50;
    const safeOnly = req.query.safe === "true";
    const unsafeOnly = req.query.unsafe === "true";

    const data = await detectionResults.findRecent({
      tenantId,
      limit,
      safe: safeOnly ? true : unsafeOnly ? false : undefined,
    });

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/detections/summary
 * Get detection summary stats
 */
detectionsRouter.get("/summary", async (req, res, next) => {
  try {
    const tenantId = res.locals.tenantId as string;

    const data = await detectionResults.summary(tenantId);

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});
