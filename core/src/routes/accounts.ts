import { Router } from "express";
import { db } from "../db/client.js";
import { agentQueries } from "../db/queries/agents.js";

const agents = agentQueries(db);

export const accountsRouter = Router();

function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 16) return apiKey.slice(0, 6) + "...";
  return apiKey.slice(0, 12) + "..." + apiKey.slice(-4);
}

/**
 * GET /api/v1/accounts
 *
 * Returns all agents associated with the authenticated agent's email.
 * Requires: Authorization: Bearer sk-og-xxx (active agent with verified email)
 */
accountsRouter.get("/", async (req, res, next) => {
  try {
    const agent = res.locals.agent;
    if (!agent) {
      res.status(403).json({ success: false, error: "Agent context required" });
      return;
    }

    if (!agent.email) {
      res.status(403).json({ success: false, error: "Email not verified" });
      return;
    }

    const allAgents = await agents.findAllByEmail(agent.email);

    res.json({
      success: true,
      email: agent.email,
      agents: allAgents.map((a) => ({
        agentId: a.id,
        name: a.name,
        apiKeyMasked: maskApiKey(a.apiKey),
        status: a.status,
        quotaTotal: a.quotaTotal,
        quotaUsed: a.quotaUsed,
        quotaRemaining: Math.max(0, a.quotaTotal - a.quotaUsed),
      })),
    });
  } catch (err) {
    next(err);
  }
});
