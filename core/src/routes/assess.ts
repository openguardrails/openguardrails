import { Router, type Request } from "express";
import { db } from "../db/client.js";
import { behaviorEvents } from "../db/schema.js";
import { quotaCheck, recordUsage } from "../middleware/api-key-auth.js";
import { assessBehavior } from "../services/behavior-engine.js";
import type { BehaviorAssessRequest } from "../types.js";

export const assessRouter = Router();

/**
 * Extract the real client IP, respecting X-Forwarded-For from trusted proxies.
 * Returns the first (leftmost) IP in the chain, which is the original client.
 */
function extractSourceIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)
      .split(",")[0]!
      .trim();
    if (first) return first;
  }
  return req.ip ?? req.socket?.remoteAddress ?? "unknown";
}

/**
 * POST /api/v1/behavior/assess
 *
 * Assesses a tool chain for behavioral anomalies.
 * Called by openclaw-security plugin at before_tool_call when local signals indicate risk.
 *
 * Auth: Bearer sk-og-xxx  (agent must be active)
 * Billing: 1 quota unit per call
 *
 * Stored per event for dashboard correlation:
 *   - agentId     from authenticated API key (res.locals.agent.id)
 *   - sessionKey  from request body
 *   - sourceIp    from HTTP request (X-Forwarded-For or socket)
 *   - pluginVersion  from request body meta
 *   - clientTimestamp from request body meta
 */
assessRouter.post(
  "/",
  quotaCheck("assess"),
  async (req, res, next) => {
    const startTime = Date.now();
    try {
      const body = req.body as Partial<BehaviorAssessRequest>;

      // Minimal validation
      if (!body.agentId || !body.sessionKey || !body.runId) {
        res.status(400).json({
          success: false,
          error: "agentId, sessionKey, and runId are required",
        });
        return;
      }
      if (!body.localSignals) {
        res.status(400).json({ success: false, error: "localSignals is required" });
        return;
      }

      // Always use the authenticated agent's ID — client may send "configured"
      // or any placeholder when the API key was manually configured.
      const authenticatedAgentId = res.locals.agent?.id ?? body.agentId;

      const assessReq: BehaviorAssessRequest = {
        agentId: authenticatedAgentId,
        sessionKey: body.sessionKey,
        runId: body.runId,
        userIntent: body.userIntent ?? "",
        toolChain: body.toolChain ?? [],
        localSignals: body.localSignals,
        context: body.context ?? { messageHistoryLength: 0, recentUserMessages: [] },
        meta: body.meta,
      };

      const result = assessBehavior(assessReq);

      // Server-captured metadata
      const sourceIp = extractSourceIp(req);
      const pluginVersion = body.meta?.pluginVersion ?? null;
      const clientTimestamp = body.meta?.clientTimestamp ?? null;

      // Persist event (non-blocking)
      db.insert(behaviorEvents)
        .values({
          id: result.behaviorId,
          agentId: assessReq.agentId,
          runId: assessReq.runId,
          sessionKey: assessReq.sessionKey,
          userIntent: assessReq.userIntent,
          toolChainJson: assessReq.toolChain,
          localSignalsJson: assessReq.localSignals,
          riskLevel: result.riskLevel,
          anomalyTypes: result.anomalyTypes,
          action: result.action,
          confidence: result.confidence,
          explanation: result.explanation,
          affectedTools: result.affectedTools,
          sourceIp,
          pluginVersion,
          clientTimestamp,
          createdAt: new Date().toISOString(),
        })
        .run();

      // Record quota usage (fire and forget)
      const agent = res.locals.agent;
      if (agent) {
        const latencyMs = Date.now() - startTime;
        recordUsage(agent.id, "assess", latencyMs).catch(() => {});
      }

      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  },
);
