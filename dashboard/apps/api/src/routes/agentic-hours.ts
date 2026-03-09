import { Router } from "express";
import { db, agenticHoursQueries } from "@og/db";

const hours = agenticHoursQueries(db);

export const agenticHoursRouter = Router();

// POST /api/agentic-hours — Accumulate agentic hours
agenticHoursRouter.post("/", async (req, res, next) => {
  try {
    const tenantId = res.locals.tenantId as string;
    const body = req.body as {
      agentId: string;
      date?: string; // YYYY-MM-DD, defaults to today
      toolCallDurationMs?: number;
      llmDurationMs?: number;
      totalDurationMs?: number;
      toolCallCount?: number;
      llmCallCount?: number;
      sessionCount?: number;
      blockCount?: number;
      riskEventCount?: number;
    };

    if (!body.agentId) {
      res.status(400).json({ success: false, error: "agentId is required" });
      return;
    }

    const date = body.date ?? new Date().toISOString().slice(0, 10);

    await hours.accumulate({
      agentId: body.agentId,
      date,
      toolCallDurationMs: body.toolCallDurationMs,
      llmDurationMs: body.llmDurationMs,
      totalDurationMs: body.totalDurationMs,
      toolCallCount: body.toolCallCount,
      llmCallCount: body.llmCallCount,
      sessionCount: body.sessionCount,
      blockCount: body.blockCount,
      riskEventCount: body.riskEventCount,
      tenantId,
    });

    res.status(201).json({ success: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/agentic-hours/today — Today's summary
agenticHoursRouter.get("/today", async (req, res, next) => {
  try {
    const tenantId = res.locals.tenantId as string;
    const data = await hours.todaySummary(tenantId);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// GET /api/agentic-hours/daily — Daily breakdown
agenticHoursRouter.get("/daily", async (req, res, next) => {
  try {
    const tenantId = res.locals.tenantId as string;
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const start = (req.query.from as string) ?? thirtyDaysAgo.toISOString().slice(0, 10);
    const end = (req.query.to as string) ?? now.toISOString().slice(0, 10);

    const data = await hours.daily(start, end, tenantId);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

// GET /api/agentic-hours/by-agent — Per-agent breakdown
agenticHoursRouter.get("/by-agent", async (req, res, next) => {
  try {
    const tenantId = res.locals.tenantId as string;
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const start = (req.query.from as string) ?? thirtyDaysAgo.toISOString().slice(0, 10);
    const end = (req.query.to as string) ?? now.toISOString().slice(0, 10);

    const data = await hours.byAgent(start, end, tenantId);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});
