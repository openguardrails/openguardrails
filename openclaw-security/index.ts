/**
 * OpenGuardrails Plugin for OpenClaw
 *
 * Manages the AI Security Gateway and embedded monitoring dashboard.
 * The gateway handles content sanitization — no local hook-based analysis needed.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { OpenClawGuardConfig, Logger } from "./agent/types.js";
import { resolveConfig, saveDashboardConfig } from "./agent/config.js";
import { GatewayManager } from "./gateway-manager.js";
import { DashboardManager } from "./dashboard-manager.js";
import { DashboardClient } from "./platform-client/index.js";
import { AnalysisStore } from "./memory/store.js";

// =============================================================================
// Constants
// =============================================================================

const PLUGIN_ID = "openguardrails";
const PLUGIN_NAME = "OpenGuardrails";
const LOG_PREFIX = `[${PLUGIN_ID}]`;

// =============================================================================
// Logger
// =============================================================================

function createLogger(baseLogger: Logger): Logger {
  return {
    info: (msg: string) => baseLogger.info(`${LOG_PREFIX} ${msg}`),
    warn: (msg: string) => baseLogger.warn(`${LOG_PREFIX} ${msg}`),
    error: (msg: string) => baseLogger.error(`${LOG_PREFIX} ${msg}`),
    debug: (msg: string) => baseLogger.debug?.(`${LOG_PREFIX} ${msg}`),
  };
}

// =============================================================================
// Plugin Definition
// =============================================================================

let globalGatewayManager: GatewayManager | null = null;
let globalDashboardManager: DashboardManager | null = null;
let globalDashboardClient: DashboardClient | null = null;
let globalAnalysisStore: AnalysisStore | null = null;

function getOrCreateStore(config: ReturnType<typeof resolveConfig>): AnalysisStore {
  if (!globalAnalysisStore) {
    const logPath = config.logPath || `${process.env.HOME || "~"}/.openclaw/logs`;
    globalAnalysisStore = new AnalysisStore(logPath, {
      info: () => {},
      warn: () => {},
      error: () => {},
    });
  }
  return globalAnalysisStore;
}

const openClawGuardPlugin = {
  id: PLUGIN_ID,
  name: PLUGIN_NAME,
  description:
    "AI Security Gateway and monitoring dashboard for OpenClaw agents",

  register(api: OpenClawPluginApi) {
    const pluginConfig = (api.pluginConfig ?? {}) as OpenClawGuardConfig;
    const config = resolveConfig(pluginConfig);
    const log = createLogger(api.logger);

    if (!config.gatewayEnabled && !config.dashboardEnabled) {
      log.debug?.("Plugin disabled via config");
      return;
    }

    // ─── Service initialization ─────────────────────────────────────

    let initialized = false;
    let initPromise: Promise<void> | null = null;

    function ensureInitialized(): Promise<void> {
      if (initPromise) return initPromise;
      initialized = true;

      const tasks: Promise<void>[] = [];

      // ─── Start Embedded Dashboard ─────────────────────────────────
      if (config.dashboardEnabled) {
        globalDashboardManager = new DashboardManager(
          { port: config.dashboardPort || 28901 },
          log,
        );

        tasks.push(
          globalDashboardManager.start().then(() => {
            const sessionToken = globalDashboardManager!.getSessionToken();
            const port = config.dashboardPort || 28901;
            const dashboardUrl = `http://127.0.0.1:${port}`;

            if (sessionToken) {
              saveDashboardConfig({ url: dashboardUrl, sessionToken });

              globalDashboardClient = new DashboardClient({
                dashboardUrl,
                sessionToken,
              });

              globalDashboardClient.registerAgent({
                name: config.agentName,
                provider: "openclaw",
                metadata: { embedded: true },
              }).then(() => {
                log.info(`Agent "${config.agentName}" registered with dashboard`);
                globalDashboardClient!.startHeartbeat();
              }).catch((err) => {
                log.warn(`Failed to register agent: ${err}`);
              });

              log.info(`Dashboard: ${dashboardUrl}?session=${sessionToken}`);
            } else {
              log.info(`Dashboard: ${dashboardUrl}`);
            }
          }).catch((error) => {
            log.error(`Failed to start dashboard: ${error}`);
          }),
        );
      }

      // ─── Start AI Security Gateway ────────────────────────────────
      if (config.gatewayEnabled) {
        globalGatewayManager = new GatewayManager(
          {
            port: config.gatewayPort || 28900,
            autoStart: config.gatewayAutoStart ?? true,
          },
          log,
        );

        tasks.push(
          globalGatewayManager.start().catch((error) => {
            log.error(`Failed to start gateway: ${error}`);
          }),
        );
      }

      initPromise = Promise.all(tasks).then(() => {});
      return initPromise;
    }

    // ─── Start services immediately on plugin load ───────────────────
    ensureInitialized();

    // ─── Tool Call Observation Hooks ─────────────────────────────────
    // Observe every tool call to build an agent capability profile.
    // Reports to dashboard when available, falls back to local JSONL.

    api.on("before_tool_call", async (event, ctx) => {
      const agentId = globalDashboardClient?.agentId || ctx.agentId || "unknown";
      const observation = {
        agentId,
        sessionKey: ctx.sessionKey,
        toolName: event.toolName,
        params: event.params,
        phase: "before" as const,
        timestamp: new Date().toISOString(),
      };

      // Report to dashboard (non-blocking)
      if (globalDashboardClient) {
        globalDashboardClient.reportToolCall(observation).catch((err) => {
          log.debug?.(`Failed to report tool call to dashboard: ${err}`);
          // Fallback: log locally
          getOrCreateStore(config).logToolCall(observation);
        });
      } else {
        getOrCreateStore(config).logToolCall(observation);
      }
    }, { priority: 100 });

    api.on("after_tool_call", async (event, ctx) => {
      const agentId = globalDashboardClient?.agentId || ctx.agentId || "unknown";
      const observation = {
        agentId,
        sessionKey: ctx.sessionKey,
        toolName: event.toolName,
        params: event.params,
        phase: "after" as const,
        result: event.result,
        error: event.error,
        durationMs: event.durationMs,
        timestamp: new Date().toISOString(),
      };

      // Report to dashboard (non-blocking)
      if (globalDashboardClient) {
        globalDashboardClient.reportToolCall(observation).catch((err) => {
          log.debug?.(`Failed to report tool result to dashboard: ${err}`);
          getOrCreateStore(config).logToolCall(observation);
        });
      } else {
        getOrCreateStore(config).logToolCall(observation);
      }
    });

    // ─── Register Commands ──────────────────────────────────────────

    api.registerCommand({
      name: "og_status",
      description: "Show OpenGuardrails status",
      requireAuth: true,
      handler: async () => {
        await ensureInitialized();

        const dashboardStatus = globalDashboardManager?.getStatus();
        const gatewayStatus = globalGatewayManager?.getStatus();

        function serviceLabel(s: { running: boolean; ready: boolean; port: number } | undefined, name: string): string {
          if (!s) return `${name}: disabled`;
          if (s.ready) return `${name}: running on port ${s.port}`;
          if (s.running) return `${name}: starting on port ${s.port}...`;
          return `${name}: failed to start`;
        }

        const statusLines = [
          "**OpenGuardrails Status**",
          "",
          `- ${serviceLabel(dashboardStatus, "Dashboard")}`,
          `- ${serviceLabel(gatewayStatus, "Gateway")}`,
        ];

        if (dashboardStatus?.sessionToken) {
          statusLines.push(
            "",
            `**Dashboard URL**: http://127.0.0.1:${dashboardStatus.port}?session=${dashboardStatus.sessionToken}`,
          );
        }

        return { text: statusLines.join("\n") };
      },
    });

    api.registerCommand({
      name: "og_dashboard",
      description: "Open the OpenGuardrails dashboard in your browser",
      requireAuth: true,
      handler: async () => {
        await ensureInitialized();

        const dashboardStatus = globalDashboardManager?.getStatus();
        if (!dashboardStatus) {
          return { text: "Dashboard is disabled in plugin config." };
        }
        if (!dashboardStatus.ready) {
          return { text: `Dashboard failed to start on port ${dashboardStatus.port}. Check logs for details.` };
        }

        const port = dashboardStatus.port;
        const token = dashboardStatus.sessionToken;
        const url = token
          ? `http://127.0.0.1:${port}?session=${token}`
          : `http://127.0.0.1:${port}`;

        const { exec } = await import("node:child_process");
        const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
        exec(`${cmd} "${url}"`);

        return { text: `Opening dashboard: ${url}` };
      },
    });

    // ─── Gateway Management Commands ────────────────────────────────

    if (config.gatewayEnabled) {
      api.registerCommand({
        name: "og_gateway_status",
        description: "Show AI Security Gateway status",
        requireAuth: true,
        handler: async () => {
          const status = globalGatewayManager?.getStatus();
          if (!status) {
            return { text: "Gateway not initialized. It will start with the next agent session." };
          }
          return {
            text: [
              "**AI Security Gateway Status**",
              "",
              `- Running: ${status.running ? "Yes" : "No"}`,
              `- Ready: ${status.ready ? "Yes" : "No"}`,
              `- Port: ${status.port}`,
              `- Endpoint: http://127.0.0.1:${status.port}`,
            ].join("\n"),
          };
        },
      });

      api.registerCommand({
        name: "og_gateway_start",
        description: "Start the AI Security Gateway",
        requireAuth: true,
        handler: async () => {
          await ensureInitialized();
          try {
            if (!globalGatewayManager) {
              return { text: "Gateway not configured." };
            }
            await globalGatewayManager.start();
            return { text: "Gateway started successfully" };
          } catch (error) {
            return {
              text: `Failed to start gateway: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
        },
      });

      api.registerCommand({
        name: "og_gateway_stop",
        description: "Stop the AI Security Gateway",
        requireAuth: true,
        handler: async () => {
          if (!globalGatewayManager) {
            return { text: "Gateway not running." };
          }
          try {
            await globalGatewayManager.stop();
            return { text: "Gateway stopped" };
          } catch (error) {
            return {
              text: `Failed to stop gateway: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
        },
      });

      api.registerCommand({
        name: "og_gateway_restart",
        description: "Restart the AI Security Gateway",
        requireAuth: true,
        handler: async () => {
          await ensureInitialized();
          if (!globalGatewayManager) {
            return { text: "Gateway not configured." };
          }
          try {
            await globalGatewayManager.restart();
            return { text: "Gateway restarted successfully" };
          } catch (error) {
            return {
              text: `Failed to restart gateway: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
        },
      });
    }
  },

  async unregister() {
    if (globalGatewayManager) {
      try {
        await globalGatewayManager.stop();
      } catch (error) {
        console.error("[openguardrails] Failed to stop gateway during cleanup:", error);
      }
    }
    if (globalDashboardManager) {
      try {
        await globalDashboardManager.stop();
      } catch (error) {
        console.error("[openguardrails] Failed to stop dashboard during cleanup:", error);
      }
    }
  },
};

export default openClawGuardPlugin;
