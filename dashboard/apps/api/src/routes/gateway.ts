/**
 * Gateway API routes
 *
 * Provides status and management endpoints for the AI Security Gateway.
 */

import { Router } from "express";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { db, gatewayActivityQueries } from "@og/db";

const gatewayActivityDb = gatewayActivityQueries(db);
const DEFAULT_TENANT_ID = "default";

const router = Router();

// File paths - unified to moltguard data directory
const OPENCLAW_DIR = join(homedir(), ".openclaw");
const MOLTGUARD_DATA_DIR = join(OPENCLAW_DIR, "extensions", "moltguard", "data");
const GATEWAY_CONFIG = join(MOLTGUARD_DATA_DIR, "gateway.json");
const GATEWAY_PID_FILE = join(MOLTGUARD_DATA_DIR, "gateway.pid");
const GATEWAY_BACKUP = join(MOLTGUARD_DATA_DIR, "gateway-backup.json");

/**
 * Check if gateway process is running by checking PID file
 * Note: In-process gateway (embedded in moltguard) won't have a PID file
 */
function checkPidFile(): { hasPid: boolean; pid?: number } {
  if (!existsSync(GATEWAY_PID_FILE)) {
    return { hasPid: false };
  }

  try {
    const pid = parseInt(readFileSync(GATEWAY_PID_FILE, "utf-8").trim(), 10);
    // Signal 0 doesn't kill, just checks if process exists
    process.kill(pid, 0);
    return { hasPid: true, pid };
  } catch {
    return { hasPid: false };
  }
}

/**
 * Check if gateway is actually responding by calling health endpoint
 */
async function checkGatewayHealth(port: number): Promise<{ healthy: boolean; error?: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (response.ok) {
      return { healthy: true };
    } else {
      return { healthy: false, error: `Status ${response.status}` };
    }
  } catch (err) {
    clearTimeout(timeoutId);
    return { healthy: false, error: err instanceof Error ? err.message : "Connection failed" };
  }
}

/**
 * Read gateway configuration
 */
function readGatewayConfig(): Record<string, unknown> | null {
  if (!existsSync(GATEWAY_CONFIG)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(GATEWAY_CONFIG, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Read gateway backup (enabled state)
 */
function readGatewayBackup(): { enabled: boolean; agents: string[]; providers: string[]; timestamp?: string } {
  if (!existsSync(GATEWAY_BACKUP)) {
    return { enabled: false, agents: [], providers: [] };
  }

  try {
    const backup = JSON.parse(readFileSync(GATEWAY_BACKUP, "utf-8"));
    const agents = backup.entries?.map((e: { agentName: string }) => e.agentName) || [];
    const providerSet = new Set<string>();
    for (const entry of backup.entries || []) {
      for (const providerName of Object.keys(entry.providers || {})) {
        providerSet.add(providerName);
      }
    }
    return {
      enabled: true,
      agents,
      providers: Array.from(providerSet),
      timestamp: backup.timestamp,
    };
  } catch {
    return { enabled: false, agents: [], providers: [] };
  }
}

/**
 * GET /api/gateway/status
 * Get current gateway status
 */
router.get("/status", async (_req, res) => {
  try {
    const { hasPid, pid } = checkPidFile();
    const backup = readGatewayBackup();
    const config = readGatewayConfig();
    const port = (config as { port?: number })?.port || 53669;

    // Check if gateway is actually running by calling health endpoint
    // This works for both standalone and in-process (embedded) gateway
    const { healthy } = await checkGatewayHealth(port);

    const status = {
      enabled: backup.enabled,
      running: healthy, // Use health check instead of PID file
      pid: hasPid ? pid : undefined,
      port,
      url: `http://127.0.0.1:${port}`,
      agents: backup.agents,
      providers: backup.providers,
      enabledAt: backup.timestamp || null,
      backends: config ? Object.keys((config as { backends?: Record<string, unknown> }).backends || {}) : [],
    };

    res.json({ success: true, data: status });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Failed to get gateway status",
    });
  }
});

/**
 * GET /api/gateway/config
 * Get gateway configuration (without sensitive data)
 */
router.get("/config", (_req, res) => {
  try {
    const config = readGatewayConfig();

    if (!config) {
      res.json({
        success: true,
        data: {
          configured: false,
          port: 53669,
          backends: [],
        },
      });
      return;
    }

    // Return config without API keys
    const backends = (config as { backends?: Record<string, { baseUrl?: string }> }).backends || {};
    const sanitizedBackends: Record<string, { baseUrl: string; hasApiKey: boolean }> = {};

    for (const [name, backend] of Object.entries(backends)) {
      sanitizedBackends[name] = {
        baseUrl: backend.baseUrl || "",
        hasApiKey: true, // We know it exists, just don't expose it
      };
    }

    res.json({
      success: true,
      data: {
        configured: true,
        port: (config as { port?: number }).port || 53669,
        backends: sanitizedBackends,
        routing: (config as { routing?: Record<string, string> }).routing || {},
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Failed to get gateway config",
    });
  }
});

/**
 * GET /api/gateway/health
 * Check if gateway is responding
 */
router.get("/health", async (_req, res) => {
  try {
    const config = readGatewayConfig();
    const port = (config as { port?: number })?.port || 53669;

    const { healthy, error } = await checkGatewayHealth(port);

    res.json({
      success: true,
      data: {
        healthy,
        ...(error ? { error } : {}),
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Failed to check gateway health",
    });
  }
});

/**
 * POST /api/gateway/activity
 * Receive gateway activity events from MoltGuard
 */
router.post("/activity", async (req, res) => {
  try {
    const event = req.body;

    if (!event || !event.id || !event.type) {
      res.status(400).json({
        success: false,
        error: "Invalid activity event: missing id or type",
      });
      return;
    }

    await gatewayActivityDb.create({
      eventId: event.id,
      requestId: event.requestId,
      timestamp: event.timestamp,
      type: event.type,
      direction: event.direction,
      backend: event.backend,
      endpoint: event.endpoint,
      model: event.model || null,
      redactionCount: event.redactionCount || 0,
      categories: event.categories || {},
      durationMs: event.durationMs || null,
      tenantId: DEFAULT_TENANT_ID,
    });

    res.json({ success: true });
  } catch (error) {
    console.error("[gateway] Failed to save activity:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Failed to save activity",
    });
  }
});

/**
 * GET /api/gateway/activity
 * List recent gateway activity events
 */
router.get("/activity", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string || "100", 10), 1000);
    const type = req.query.type as "sanitize" | "restore" | undefined;

    const events = await gatewayActivityDb.findRecent({
      tenantId: DEFAULT_TENANT_ID,
      limit,
      type: type === "sanitize" || type === "restore" ? type : undefined,
    });

    // Transform events for API response
    const data = [];
    for (const e of events) {
      data.push({
        id: e.eventId,
        requestId: e.requestId,
        timestamp: e.timestamp,
        type: e.type,
        direction: e.direction,
        backend: e.backend,
        endpoint: e.endpoint,
        model: e.model,
        redactionCount: e.redactionCount,
        categories: e.categories,
        durationMs: e.durationMs,
      });
    }

    res.json({ success: true, data });
  } catch (error) {
    console.error("[gateway] Failed to get activity:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Failed to get activity",
    });
  }
});

/**
 * GET /api/gateway/activity/stats
 * Get aggregated gateway activity statistics
 */
router.get("/activity/stats", async (_req, res) => {
  try {
    const stats = await gatewayActivityDb.stats(DEFAULT_TENANT_ID);

    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    console.error("[gateway] Failed to get activity stats:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Failed to get activity stats",
    });
  }
});

export { router as gatewayRouter };
