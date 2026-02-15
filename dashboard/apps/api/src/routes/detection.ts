import { Router } from "express";
import { db, scannerQueries, policyQueries, usageQueries, detectionResultQueries, settingsQueries } from "@og/db";
import type { CoreScannerDef } from "@og/shared";
import { callCoreDetect } from "../services/core-client.js";

const scanners = scannerQueries(db);
const policies = policyQueries(db);
const usage = usageQueries(db);
const detectionResults = detectionResultQueries(db);
const settings = settingsQueries(db);

export const detectionRouter = Router();

/**
 * POST /api/detect
 * Detection proxy endpoint.
 * Flow:
 * 1. Check core key is configured
 * 2. Get scanner config
 * 3. Call core /v1/detect
 * 4. Evaluate policies
 * 5. Record usage + detection result
 * 6. Return response
 */
detectionRouter.post("/", async (req, res, next) => {
  try {
    // 1. Check core key
    const coreKey = await settings.get("og_core_key");
    if (!coreKey) {
      res.status(503).json({
        success: false,
        error: "core key not configured. Go to Settings to add your key.",
      });
      return;
    }

    // 2. Get scanner config
    const allScanners = await scanners.getAll();
    const coreScanners: CoreScannerDef[] = allScanners.map((s) => ({
      scannerId: s.scannerId,
      name: s.name,
      description: s.description,
      isEnabled: s.isEnabled,
    }));

    // Validate request body
    const { messages, format, role, agentId } = req.body;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ success: false, error: "messages array is required and must not be empty" });
      return;
    }

    // 3. Call core
    const coreResult = await callCoreDetect(messages, coreScanners, { format, role });

    // 4. Evaluate policies
    let policyAction: string | null = null;
    if (!coreResult.safe) {
      const enabledPolicies = await policies.getEnabled();
      for (const policy of enabledPolicies) {
        const policyScannerIds = policy.scannerIds as string[];
        const matchesCategory = coreResult.categories.some((c: string) => policyScannerIds.includes(c));
        if (matchesCategory && coreResult.sensitivity_score >= policy.sensitivityThreshold) {
          policyAction = policy.action as string;
          break;
        }
      }
    }

    // 5. Record usage + detection result
    await usage.log({
      agentId: agentId || null,
      endpoint: "/api/detect",
      statusCode: 200,
      responseSafe: coreResult.safe,
      categories: coreResult.categories,
      latencyMs: coreResult.latency_ms,
      requestId: coreResult.request_id,
    });

    await detectionResults.create({
      agentId: agentId || null,
      safe: coreResult.safe,
      categories: coreResult.categories,
      sensitivityScore: coreResult.sensitivity_score,
      findings: coreResult.findings,
      latencyMs: coreResult.latency_ms,
      requestId: coreResult.request_id,
    });

    // 6. Return response with policy action
    const response: Record<string, unknown> = {
      ...coreResult,
      ...(policyAction && { policy_action: policyAction }),
    };

    if (policyAction === "block") {
      res.status(403).json({ success: true, data: response, blocked: true });
      return;
    }

    res.json({ success: true, data: response });
  } catch (err) {
    if (err instanceof Error && (err.message.includes("ECONNREFUSED") || err.message.includes("fetch failed"))) {
      res.status(503).json({ success: false, error: "Detection service is temporarily unavailable. Please try again later." });
      return;
    }
    next(err);
  }
});
