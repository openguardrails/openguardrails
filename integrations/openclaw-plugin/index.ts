/**
 * OpenGuardrails Plugin for OpenClaw
 *
 * Detects prompt injection attacks and provides PII sanitization.
 * Includes embedded OpenGuardrails Dashboard for monitoring.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { OpenClawGuardConfig, AnalysisTarget, Logger } from "./agent/types.js";
import { resolveConfig, loadApiKey, registerApiKey, saveDashboardConfig } from "./agent/config.js";
import { runGuardAgent } from "./agent/runner.js";
import { createAnalysisStore } from "./memory/store.js";
import { GatewayManager } from "./gateway-manager.js";
import { DashboardManager } from "./dashboard-manager.js";
import { DashboardClient } from "./platform-client/index.js";

// =============================================================================
// Constants
// =============================================================================

const PLUGIN_ID = "moltguard";
const PLUGIN_NAME = "OpenGuardrails";
const LOG_PREFIX = `[${PLUGIN_ID}]`;

// =============================================================================
// Helper Functions
// =============================================================================

function extractToolResultContent(message: unknown): string | null {
  if (!message || typeof message !== "object") {
    return null;
  }

  const msg = message as Record<string, unknown>;

  if (typeof msg.content === "string") {
    return msg.content;
  }

  if (Array.isArray(msg.content)) {
    const texts: string[] = [];
    for (const part of msg.content) {
      if (part && typeof part === "object") {
        const p = part as Record<string, unknown>;
        if (p.type === "text" && typeof p.text === "string") {
          texts.push(p.text);
        } else if (p.type === "tool_result" && typeof p.content === "string") {
          texts.push(p.content);
        }
      }
    }
    if (texts.length > 0) {
      return texts.join("\n");
    }
  }

  if (typeof msg.text === "string") {
    return msg.text;
  }

  if (typeof msg.result === "string") {
    return msg.result;
  }

  try {
    const str = JSON.stringify(msg);
    if (str.length > 100) {
      return str;
    }
  } catch {
    // ignore
  }

  return null;
}

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

const openClawGuardPlugin = {
  id: PLUGIN_ID,
  name: PLUGIN_NAME,
  description:
    "AI agent security: prompt injection detection, PII sanitization, and monitoring dashboard",

  register(api: OpenClawPluginApi) {
    const pluginConfig = (api.pluginConfig ?? {}) as OpenClawGuardConfig;
    const config = resolveConfig(pluginConfig);
    const log = createLogger(api.logger);

    if (!config.enabled && !config.sanitizePrompt && !config.dashboardEnabled) {
      log.info("Plugin disabled via config");
      return;
    }

    const logPath = api.resolvePath(config.logPath);
    const store = createAnalysisStore(logPath, log);

    // ─── Start Embedded Dashboard ───────────────────────────────────
    if (config.dashboardEnabled) {
      globalDashboardManager = new DashboardManager(
        { port: config.dashboardPort || 8901 },
        log,
      );

      globalDashboardManager.start().then(() => {
        const sessionToken = globalDashboardManager!.getSessionToken();
        const dashboardUrl = `http://localhost:${config.dashboardPort || 8901}`;

        if (sessionToken) {
          // Save for future use
          saveDashboardConfig({ url: dashboardUrl, sessionToken });

          // Create dashboard client for agent registration
          globalDashboardClient = new DashboardClient({
            dashboardUrl,
            sessionToken,
          });

          // Auto-register this agent
          globalDashboardClient.registerAgent({
            name: config.agentName,
            provider: "openclaw",
            metadata: { embedded: true },
          }).then(() => {
            log.info(`Agent "${config.agentName}" registered with dashboard`);
            // Start heartbeat
            globalDashboardClient!.startHeartbeat();
          }).catch((err) => {
            log.warn(`Failed to register agent: ${err}`);
          });
        }

        log.info(`Dashboard: ${dashboardUrl}`);
      }).catch((error) => {
        log.error(`Failed to start dashboard: ${error}`);
      });
    }

    // ─── Start Gateway ──────────────────────────────────────────────
    if (config.sanitizePrompt) {
      globalGatewayManager = new GatewayManager(
        {
          port: config.gatewayPort || 8900,
          autoStart: config.gatewayAutoStart ?? true,
        },
        log,
      );

      globalGatewayManager.start().catch((error) => {
        log.error(`Failed to start gateway: ${error}`);
      });

      log.info(`Gateway enabled on port ${config.gatewayPort || 8900}`);
    }

    // ─── Resolve API Key (for legacy MoltGuard fallback) ────────────
    let resolvedApiKey = config.apiKey;
    if (!resolvedApiKey) {
      const savedKey = loadApiKey();
      if (savedKey) {
        resolvedApiKey = savedKey;
        log.info("Loaded API key from credentials file");
      } else if (config.autoRegister) {
        log.info("No API key found — will auto-register on first analysis");
      }
    }

    // ─── Register Injection Detection Hooks ─────────────────────────
    if (config.enabled) {
      log.info("Injection detection enabled");

      api.on("tool_result_persist", (event, ctx) => {
        const toolName = ctx.toolName ?? event.toolName ?? "unknown";

        const content = extractToolResultContent(event.message);
        if (!content || content.length < 100) {
          return;
        }

        log.info(`Analyzing tool result from "${toolName}" (${content.length} chars)`);
        const startTime = Date.now();

        const target: AnalysisTarget = {
          type: "tool_result",
          content,
          toolName,
          metadata: {
            sessionKey: ctx.sessionKey,
            agentId: ctx.agentId,
            toolCallId: ctx.toolCallId,
          },
        };

        runGuardAgent(
          target,
          {
            apiKey: resolvedApiKey,
            timeoutMs: config.timeoutMs,
            autoRegister: config.autoRegister,
            apiBaseUrl: config.apiBaseUrl,
            dashboardUrl: config.dashboardSessionToken ? config.dashboardUrl : undefined,
            dashboardSessionToken: config.dashboardSessionToken,
          },
          log,
        ).then((verdict) => {
          const durationMs = Date.now() - startTime;
          const detected = verdict.isInjection && verdict.confidence >= 0.7;

          store.logAnalysis({
            targetType: "tool_result",
            contentLength: content.length,
            chunksAnalyzed: verdict.chunksAnalyzed,
            verdict,
            durationMs,
            blocked: detected && config.blockOnRisk,
          });

          if (detected) {
            log.warn(`INJECTION DETECTED in tool result from "${toolName}": ${verdict.reason}`);
          }
        }).catch((error) => {
          log.error(`Tool result analysis failed: ${error}`);
        });

        return;
      });

      api.on("message_received", (event, ctx) => {
        if (event.content.length < 1000) {
          return;
        }

        if (!resolvedApiKey && !config.autoRegister && !config.dashboardSessionToken) {
          return;
        }

        const startTime = Date.now();

        const target: AnalysisTarget = {
          type: "message",
          content: event.content,
          metadata: {
            channelId: ctx.channelId,
            from: event.from,
          },
        };

        runGuardAgent(
          target,
          {
            apiKey: resolvedApiKey,
            timeoutMs: config.timeoutMs,
            autoRegister: config.autoRegister,
            apiBaseUrl: config.apiBaseUrl,
            dashboardUrl: config.dashboardSessionToken ? config.dashboardUrl : undefined,
            dashboardSessionToken: config.dashboardSessionToken,
          },
          log,
        ).then((verdict) => {
          const durationMs = Date.now() - startTime;

          store.logAnalysis({
            targetType: "message",
            contentLength: event.content.length,
            chunksAnalyzed: verdict.chunksAnalyzed,
            verdict,
            durationMs,
            blocked: false,
          });

          if (verdict.isInjection) {
            log.warn(
              `Suspicious content in message (${event.content.length} chars): ${verdict.reason}`,
            );
          }
        }).catch((error) => {
          log.error(`Message analysis failed: ${error}`);
        });

        return undefined;
      });

      // ─── Register Commands ──────────────────────────────────────────

      api.registerCommand({
        name: "og_status",
        description: "Show OpenGuardrails status and statistics",
        requireAuth: true,
        handler: async () => {
          const stats = store.getStats();
          const feedbackStats = store.getFeedbackStats();
          const recentLogs = store.getRecentLogs(5);

          const dashboardStatus = globalDashboardManager?.getStatus();

          const statusLines = [
            "**OpenGuardrails Status**",
            "",
            `- Injection detection: ${config.enabled ? "enabled" : "disabled"}`,
            `- Block on risk: ${config.blockOnRisk}`,
            `- Dashboard: ${dashboardStatus?.ready ? `running on port ${dashboardStatus.port}` : "not running"}`,
            `- Gateway: ${globalGatewayManager?.isRunning() ? "running" : "not running"}`,
            "",
            "**Statistics**",
            `- Total analyses: ${stats.totalAnalyses}`,
            `- Total blocked: ${stats.totalBlocked}`,
            `- Blocked (24h): ${stats.blockedLast24h}`,
            `- Avg duration: ${stats.avgDurationMs}ms`,
            "",
            "**User Feedback**",
            `- False positives reported: ${feedbackStats.falsePositives}`,
            `- Missed detections reported: ${feedbackStats.missedDetections}`,
          ];

          if (dashboardStatus?.sessionToken) {
            statusLines.push("", `**Dashboard URL**: http://localhost:${dashboardStatus.port}`);
            statusLines.push(`**Session Token**: ${dashboardStatus.sessionToken}`);
          }

          if (recentLogs.length > 0) {
            statusLines.push("", "**Recent Analyses**");
            for (const log of recentLogs) {
              const status = log.blocked ? "BLOCKED" : log.verdict.isInjection ? "DETECTED" : "SAFE";
              statusLines.push(
                `- ${log.timestamp}: ${log.targetType} (${log.contentLength} chars) - ${status}`,
              );
            }
          }

          return { text: statusLines.join("\n") };
        },
      });

      api.registerCommand({
        name: "og_report",
        description: "Show recent prompt injection detections",
        requireAuth: true,
        handler: async () => {
          const detections = store.getRecentDetections(10);

          if (detections.length === 0) {
            return { text: "No prompt injection detections found." };
          }

          const lines = [
            "**Recent Prompt Injection Detections**",
            "",
          ];

          for (const d of detections) {
            const status = d.blocked ? "BLOCKED" : "DETECTED";
            lines.push(`**#${d.id}** - ${d.timestamp}`);
            lines.push(`- Status: ${status}`);
            lines.push(`- Type: ${d.targetType} (${d.contentLength} chars)`);
            lines.push(`- Reason: ${d.verdict.reason}`);
            if (d.verdict.findings.length > 0) {
              const finding = d.verdict.findings[0];
              lines.push(`- Suspicious: "${finding?.suspiciousContent?.slice(0, 100)}..."`);
            }
            lines.push("");
          }

          lines.push("Use `/og_feedback <id> fp` to report false positive");
          lines.push("Use `/og_feedback missed <reason>` to report missed detection");

          return { text: lines.join("\n") };
        },
      });

      api.registerCommand({
        name: "og_feedback",
        description: "Report false positive or missed detection",
        requireAuth: true,
        acceptsArgs: true,
        handler: async (ctx) => {
          const parts = (ctx.args ?? "").trim().split(/\s+/);

          if (parts.length === 0 || parts[0] === "") {
            return {
              text: [
                "**Usage:**",
                "- `/og_feedback <id> fp [reason]` - Report detection #id as false positive",
                "- `/og_feedback missed <reason>` - Report a missed detection",
                "",
                "Use `/og_report` to see recent detections and their IDs.",
              ].join("\n"),
            };
          }

          if (parts[0] === "missed") {
            const reason = parts.slice(1).join(" ") || "No reason provided";
            store.logFeedback({
              feedbackType: "missed_detection",
              reason,
            });
            log.info(`User reported missed detection: ${reason}`);
            return { text: `Thank you! Recorded missed detection report: "${reason}"` };
          }

          const analysisId = parseInt(parts[0]!, 10);
          if (isNaN(analysisId)) {
            return { text: "Invalid analysis ID. Use `/og_report` to see recent detections." };
          }

          if (parts[1] !== "fp") {
            return { text: "Invalid command. Use `/og_feedback <id> fp [reason]`" };
          }

          const reason = parts.slice(2).join(" ") || "No reason provided";
          store.logFeedback({
            analysisId,
            feedbackType: "false_positive",
            reason,
          });
          log.info(`User reported false positive for analysis #${analysisId}: ${reason}`);
          return { text: `Thank you! Recorded false positive report for detection #${analysisId}` };
        },
      });

      log.info(
        `Injection detection initialized (block: ${config.blockOnRisk}, timeout: ${config.timeoutMs}ms)`,
      );
    } else {
      log.info("Injection detection disabled via config");
    }

    // ─── Gateway Management Commands ────────────────────────────────
    if (globalGatewayManager) {
      api.registerCommand({
        name: "mg_status",
        description: "Show gateway status",
        requireAuth: true,
        handler: async () => {
          const status = globalGatewayManager!.getStatus();
          return {
            text: [
              "**Gateway Status**",
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
        name: "mg_start",
        description: "Start the PII sanitization gateway",
        requireAuth: true,
        handler: async () => {
          try {
            await globalGatewayManager!.start();
            return { text: "Gateway started successfully" };
          } catch (error) {
            return {
              text: `Failed to start gateway: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
        },
      });

      api.registerCommand({
        name: "mg_stop",
        description: "Stop the PII sanitization gateway",
        requireAuth: true,
        handler: async () => {
          try {
            await globalGatewayManager!.stop();
            return { text: "Gateway stopped" };
          } catch (error) {
            return {
              text: `Failed to stop gateway: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
        },
      });

      api.registerCommand({
        name: "mg_restart",
        description: "Restart the PII sanitization gateway",
        requireAuth: true,
        handler: async () => {
          try {
            await globalGatewayManager!.restart();
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
        console.error("[moltguard] Failed to stop gateway during cleanup:", error);
      }
    }
    if (globalDashboardManager) {
      try {
        await globalDashboardManager.stop();
      } catch (error) {
        console.error("[moltguard] Failed to stop dashboard during cleanup:", error);
      }
    }
  },
};

export default openClawGuardPlugin;
