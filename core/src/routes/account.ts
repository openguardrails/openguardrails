import { Router } from "express";
import { db } from "../db/client.js";
import { agentQueries } from "../db/queries/agents.js";

const agents = agentQueries(db);

export const accountRouter = Router();

/**
 * GET /api/v1/account
 *
 * Returns account info for the authenticated API key.
 * Used by the dashboard to validate API keys and resolve tenant context.
 * Requires: Authorization: Bearer sk-og-xxx
 */
accountRouter.get("/", async (req, res, next) => {
  try {
    const agent = res.locals.agent;
    if (!agent) {
      // Internal-key callers don't have agent context — shouldn't call this
      res.status(403).json({ success: false, error: "Agent context required" });
      return;
    }

    // Read quota from the accounts table (where it's actually tracked)
    const quota = await agents.getQuota(agent.id);
    const quotaTotal = quota?.total ?? agent.quotaTotal;
    const quotaUsed = quota?.used ?? agent.quotaUsed;

    res.json({
      success: true,
      agentId: agent.id,
      name: agent.name,
      email: agent.email ?? null,
      status: agent.status,
      quotaTotal,
      quotaUsed,
      quotaRemaining: Math.max(0, quotaTotal - quotaUsed),
    });
  } catch (err) {
    next(err);
  }
});
