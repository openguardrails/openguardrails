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
/** Maps OpenClaw agent ID (e.g. "main", "杰诺斯") → dashboard UUID */
let globalAgentIdMap: Map<string, string> = new Map();
/** Dashboard UUID of the default/main agent, used as fallback when ctx.agentId is unavailable */
let globalDefaultAgentId: string | null = null;

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

    // DEBUG: dump everything we receive at registration
    log.info(`━━━ PLUGIN REGISTER: dumping api context ━━━`);
    log.info(`  api.id: ${api.id}`);
    log.info(`  api.name: ${api.name}`);
    log.info(`  api.version: ${api.version}`);
    log.info(`  api.source: ${api.source}`);
    log.info(`  api.pluginConfig: ${JSON.stringify(api.pluginConfig, null, 2)}`);
    log.info(`  api.config.agents: ${JSON.stringify(api.config?.agents, null, 2)?.slice(0, 1000)}`);
    log.info(`  api.runtime: ${JSON.stringify((api as any).runtime, null, 2)?.slice(0, 500)}`);
    log.info(`  resolved config: ${JSON.stringify(config, null, 2)}`);
    log.info(`━━━ END PLUGIN REGISTER DUMP ━━━`);

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

              // Register each OpenClaw agent individually with the dashboard.
              // Register the default/main agent LAST so that
              // DashboardClient.agentId (set as side-effect) points to it.
              const openclawAgents = api.config?.agents?.list;

              if (openclawAgents && openclawAgents.length > 0) {
                // Sort: default/main agent last so its UUID becomes the client fallback
                const sorted = [...openclawAgents].sort((a, b) => {
                  const aIsDefault = a.default || a.id === "main" ? 1 : 0;
                  const bIsDefault = b.default || b.id === "main" ? 1 : 0;
                  return aIsDefault - bIsDefault;
                });

                // Register sequentially to ensure deterministic order
                (async () => {
                  for (const agent of sorted) {
                    const agentName = agent.identity?.name || agent.name || agent.id;
                    const agentEmoji = agent.identity?.emoji;
                    try {
                      const res = await globalDashboardClient!.registerAgent({
                        name: agentName,
                        provider: "openclaw",
                        metadata: { embedded: true, openclawId: agent.id, ...(agentEmoji ? { emoji: agentEmoji } : {}) },
                      });
                      if (res.success && res.data?.id) {
                        globalAgentIdMap.set(agent.id, res.data.id);
                        if (agent.default || agent.id === "main") {
                          globalDefaultAgentId = res.data.id;
                        }
                        log.info(`Agent "${agentName}" (${agent.id}) registered with dashboard`);
                      }
                    } catch (err) {
                      log.warn(`Failed to register agent "${agentName}": ${err}`);
                    }
                  }
                  // If no explicit default, use the first agent
                  if (!globalDefaultAgentId && globalAgentIdMap.size > 0) {
                    globalDefaultAgentId = globalAgentIdMap.values().next().value!;
                  }
                  globalDashboardClient!.startHeartbeat();
                })();
              } else {
                // Fallback: register with configured name
                globalDashboardClient!.registerAgent({
                  name: config.agentName,
                  provider: "openclaw",
                  metadata: { embedded: true },
                }).then(() => {
                  globalDefaultAgentId = globalDashboardClient!.agentId || null;
                  log.info(`Agent "${config.agentName}" registered with dashboard`);
                  globalDashboardClient!.startHeartbeat();
                }).catch((err) => {
                  log.warn(`Failed to register agent: ${err}`);
                });
              }

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

    // ─── DEBUG: Dump all hook data ─────────────────────────────────
    // Temporary verbose logging to see every piece of data we can get.

    function truncate(val: unknown, maxLen = 500): string {
      const s = JSON.stringify(val, null, 2);
      if (s && s.length > maxLen) return s.slice(0, maxLen) + `... [truncated, total ${s.length} chars]`;
      return s ?? "undefined";
    }

    // --- before_agent_start ---
    api.on("before_agent_start", async (event, ctx) => {
      log.info(`━━━ HOOK: before_agent_start ━━━`);
      log.info(`  event.prompt: ${truncate(event.prompt, 300)}`);
      log.info(`  event.messages: ${truncate(event.messages, 500)}`);
      log.info(`  ctx.agentId: ${ctx.agentId}`);
      log.info(`  ctx.sessionKey: ${ctx.sessionKey}`);
      log.info(`  ctx.workspaceDir: ${(ctx as any).workspaceDir}`);
      log.info(`  ctx.messageProvider: ${(ctx as any).messageProvider}`);
      log.info(`  ctx (full): ${truncate(ctx)}`);
    });

    // --- agent_end ---
    api.on("agent_end", async (event, ctx) => {
      log.info(`━━━ HOOK: agent_end ━━━`);
      log.info(`  event.success: ${event.success}`);
      log.info(`  event.error: ${event.error}`);
      log.info(`  event.durationMs: ${event.durationMs}`);
      log.info(`  event.messages count: ${Array.isArray(event.messages) ? event.messages.length : "N/A"}`);
      log.info(`  ctx.agentId: ${ctx.agentId}`);
      log.info(`  ctx.sessionKey: ${ctx.sessionKey}`);
      log.info(`  ctx (full): ${truncate(ctx)}`);
    });

    // --- session_start ---
    api.on("session_start", async (event, ctx) => {
      log.info(`━━━ HOOK: session_start ━━━`);
      log.info(`  event.sessionId: ${event.sessionId}`);
      log.info(`  event.resumedFrom: ${(event as any).resumedFrom}`);
      log.info(`  ctx (full): ${truncate(ctx)}`);
    });

    // --- session_end ---
    api.on("session_end", async (event, ctx) => {
      log.info(`━━━ HOOK: session_end ━━━`);
      log.info(`  event.sessionId: ${event.sessionId}`);
      log.info(`  event.messageCount: ${event.messageCount}`);
      log.info(`  event.durationMs: ${(event as any).durationMs}`);
      log.info(`  ctx (full): ${truncate(ctx)}`);
    });

    // --- message_received ---
    api.on("message_received", async (event, ctx) => {
      log.info(`━━━ HOOK: message_received ━━━`);
      log.info(`  event.from: ${event.from}`);
      log.info(`  event.content: ${truncate(event.content, 300)}`);
      log.info(`  event.timestamp: ${event.timestamp}`);
      log.info(`  event.metadata: ${truncate(event.metadata)}`);
      log.info(`  ctx.channelId: ${ctx.channelId}`);
      log.info(`  ctx.accountId: ${(ctx as any).accountId}`);
      log.info(`  ctx.conversationId: ${(ctx as any).conversationId}`);
      log.info(`  ctx (full): ${truncate(ctx)}`);
    });

    // --- message_sending ---
    api.on("message_sending", async (event, ctx) => {
      log.info(`━━━ HOOK: message_sending ━━━`);
      log.info(`  event.to: ${event.to}`);
      log.info(`  event.content: ${truncate(event.content, 300)}`);
      log.info(`  event.metadata: ${truncate((event as any).metadata)}`);
      log.info(`  ctx (full): ${truncate(ctx)}`);
    });

    // --- message_sent ---
    api.on("message_sent", async (event, ctx) => {
      log.info(`━━━ HOOK: message_sent ━━━`);
      log.info(`  event.to: ${event.to}`);
      log.info(`  event.content: ${truncate(event.content, 300)}`);
      log.info(`  event.success: ${event.success}`);
      log.info(`  event.error: ${event.error}`);
      log.info(`  ctx (full): ${truncate(ctx)}`);
    });

    // --- before_compaction ---
    api.on("before_compaction", async (event, ctx) => {
      log.info(`━━━ HOOK: before_compaction ━━━`);
      log.info(`  event.messageCount: ${event.messageCount}`);
      log.info(`  event.tokenCount: ${(event as any).tokenCount}`);
      log.info(`  ctx (full): ${truncate(ctx)}`);
    });

    // --- after_compaction ---
    api.on("after_compaction", async (event, ctx) => {
      log.info(`━━━ HOOK: after_compaction ━━━`);
      log.info(`  event.messageCount: ${event.messageCount}`);
      log.info(`  event.tokenCount: ${(event as any).tokenCount}`);
      log.info(`  event.compactedCount: ${event.compactedCount}`);
      log.info(`  ctx (full): ${truncate(ctx)}`);
    });

    // --- tool_result_persist ---
    api.on("tool_result_persist", (event, ctx) => {
      log.info(`━━━ HOOK: tool_result_persist ━━━`);
      log.info(`  event.toolName: ${(event as any).toolName}`);
      log.info(`  event.toolCallId: ${(event as any).toolCallId}`);
      log.info(`  event.isSynthetic: ${(event as any).isSynthetic}`);
      log.info(`  event.message: ${truncate((event as any).message, 500)}`);
      log.info(`  ctx (full): ${truncate(ctx)}`);
    });

    // --- gateway_start ---
    api.on("gateway_start", async (event, ctx) => {
      log.info(`━━━ HOOK: gateway_start ━━━`);
      log.info(`  event (full): ${truncate(event)}`);
      log.info(`  ctx (full): ${truncate(ctx)}`);
    });

    // --- gateway_stop ---
    api.on("gateway_stop", async (event, ctx) => {
      log.info(`━━━ HOOK: gateway_stop ━━━`);
      log.info(`  event (full): ${truncate(event)}`);
      log.info(`  ctx (full): ${truncate(ctx)}`);
    });

    // ─── Tool Call Observation Hooks ─────────────────────────────────
    // Observe every tool call to build an agent permission profile.
    // Reports to dashboard when available, falls back to local JSONL.

    api.on("before_tool_call", async (event, ctx) => {
      const agentId = (ctx.agentId && globalAgentIdMap.get(ctx.agentId)) || ctx.agentId || globalDefaultAgentId || globalDashboardClient?.agentId || "unknown";

      // DEBUG: dump everything
      log.info(`━━━ HOOK: before_tool_call ━━━`);
      log.info(`  event.toolName: ${event.toolName}`);
      log.info(`  event.params: ${truncate(event.params)}`);
      log.info(`  ctx.agentId (raw): ${ctx.agentId}`);
      log.info(`  ctx.sessionKey: ${ctx.sessionKey}`);
      log.info(`  ctx.toolName: ${ctx.toolName}`);
      log.info(`  resolved agentId: ${agentId}`);
      log.info(`  globalAgentIdMap: ${truncate(Object.fromEntries(globalAgentIdMap))}`);
      log.info(`  globalDefaultAgentId: ${globalDefaultAgentId}`);

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
      const agentId = (ctx.agentId && globalAgentIdMap.get(ctx.agentId)) || ctx.agentId || globalDefaultAgentId || globalDashboardClient?.agentId || "unknown";

      // DEBUG: dump everything
      log.info(`━━━ HOOK: after_tool_call ━━━`);
      log.info(`  event.toolName: ${event.toolName}`);
      log.info(`  event.params: ${truncate(event.params)}`);
      log.info(`  event.result: ${truncate(event.result)}`);
      log.info(`  event.error: ${event.error}`);
      log.info(`  event.durationMs: ${event.durationMs}`);
      log.info(`  ctx.agentId (raw): ${ctx.agentId}`);
      log.info(`  ctx.sessionKey: ${ctx.sessionKey}`);
      log.info(`  ctx.toolName: ${ctx.toolName}`);
      log.info(`  resolved agentId: ${agentId}`);

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
    // Don't stop services — they run detached and survive plugin/agent restarts.
    // Users can explicitly stop them via /og_gateway_stop or similar commands.
    globalGatewayManager = null;
    globalDashboardManager = null;
    globalDashboardClient = null;
    globalAnalysisStore = null;
    globalAgentIdMap = new Map();
    globalDefaultAgentId = null;
  },
};

export default openClawGuardPlugin;
