import { Router } from "express";
import { db, usageQueries } from "@og/db";

const usage = usageQueries(db);

export const usageRouter = Router();

// GET /api/usage/summary
usageRouter.get("/summary", async (req, res, next) => {
  try {
    const tenantId = res.locals.tenantId as string;
    // Default to last 30 days
    const end = new Date();
    const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

    const stats = await usage.summary(start.toISOString(), end.toISOString(), tenantId);

    res.json({
      success: true,
      data: {
        totalCalls: stats.totalCalls,
        safeCount: stats.safeCount ?? 0,
        unsafeCount: stats.unsafeCount ?? 0,
        periodStart: start.toISOString(),
        periodEnd: end.toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/usage/daily
usageRouter.get("/daily", async (req, res, next) => {
  try {
    const tenantId = res.locals.tenantId as string;
    const end = new Date();
    const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

    const data = await usage.daily(start.toISOString(), end.toISOString(), tenantId);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});
