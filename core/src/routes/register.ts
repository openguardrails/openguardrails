import { Router } from "express";
import { db } from "../db/client.js";
import { agentQueries } from "../db/queries/agents.js";
import {
  generateApiKey,
  generateClaimToken,
  generateVerificationCode,
} from "../lib/tokens.js";

const agents = agentQueries(db);
const PLATFORM_URL = process.env.PLATFORM_URL || "https://platform.openguardrails.com";

export const registerRouter = Router();

/**
 * POST /api/v1/agents/register
 *
 * Called automatically by the openclaw-security plugin on first load.
 * No auth required — anyone can register (rate limiting handled upstream).
 *
 * Body: { name: string, description?: string }
 *
 * Response:
 * {
 *   agent: {
 *     id: string,
 *     api_key: "sk-og-xxx",
 *     claim_url: "https://platform.openguardrails.com/claim/openguardrails_claim_xxx",
 *     verification_code: "reef-X4B2"
 *   },
 *   important: "⚠️ SAVE YOUR API KEY!"
 * }
 */
registerRouter.post("/", async (req, res, next) => {
  try {
    const { name, description } = req.body as { name?: string; description?: string };

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      res.status(400).json({ success: false, error: "name is required" });
      return;
    }

    const trimmedName = name.trim().slice(0, 100);
    const id = crypto.randomUUID();
    const apiKey = generateApiKey();
    const claimToken = generateClaimToken();
    const verificationCode = generateVerificationCode();

    await agents.create({
      id,
      name: trimmedName,
      description: description?.trim().slice(0, 500) ?? null,
      apiKey,
      claimToken,
      verificationCode,
    });

    const claimUrl = `${PLATFORM_URL}/claim/${claimToken}`;

    res.status(201).json({
      success: true,
      agent: {
        id,
        api_key: apiKey,
        claim_url: claimUrl,
        verification_code: verificationCode,
      },
      important: "⚠️ SAVE YOUR API KEY! You will need it for all security checks.",
    });
  } catch (err) {
    next(err);
  }
});
