/**
 * OpenGuardrails Plugin for OpenClaw
 *
 * Responsibilities:
 *   1. Load credentials from disk on startup (no network)
 *   2. Detect behavioral anomalies at before_tool_call (block / alert)
 *   3. Expose /og_status and /og_activate commands
 *      - /og_activate triggers registration if not yet registered
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { OpenClawGuardConfig, Logger } from "./agent/types.js";
import {
  resolveConfig,
  loadCoreCredentials,
  saveCoreCredentials,
  registerWithCore,
  pollAccountEmail,
  type CoreCredentials,
} from "./agent/config.js";
import { BehaviorDetector } from "./agent/behavior-detector.js";

// =============================================================================
// Constants
// =============================================================================

const PLUGIN_ID = "openguardrails";
const PLUGIN_NAME = "OpenGuardrails";
const PLUGIN_VERSION = "6.0.3";
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
// Plugin state (module-level — survives plugin re-registration within a process)
// =============================================================================

let globalCoreCredentials: CoreCredentials | null = null;
let globalBehaviorDetector: BehaviorDetector | null = null;
let emailPollTimer: ReturnType<typeof setInterval> | null = null;

// =============================================================================
// Plugin Definition
// =============================================================================

const openClawGuardPlugin = {
  id: PLUGIN_ID,
  name: PLUGIN_NAME,
  description: "Behavioral anomaly detection for OpenClaw agents",

  register(api: OpenClawPluginApi) {
    const pluginConfig = (api.pluginConfig ?? {}) as OpenClawGuardConfig;
    const config = resolveConfig(pluginConfig);
    const log = createLogger(api.logger);

    if (config.enabled === false) {
      log.info("Plugin disabled via config");
      return;
    }

    // ── Local initialization (no network) ────────────────────────

    if (!globalBehaviorDetector) {
      globalBehaviorDetector = new BehaviorDetector(
        {
          platformUrl: config.platformUrl,
          assessTimeoutMs: Math.min(config.timeoutMs, 3000),
          blockOnRisk: config.blockOnRisk,
          pluginVersion: PLUGIN_VERSION,
        },
        log,
      );
    }

    if (!globalCoreCredentials) {
      if (config.apiKey) {
        globalCoreCredentials = {
          apiKey: config.apiKey,
          agentId: "configured",
          claimUrl: "",
          verificationCode: "",
        };
        globalBehaviorDetector.setCredentials(globalCoreCredentials);
        log.info("Platform: using configured API key");
      } else {
        globalCoreCredentials = loadCoreCredentials();
        if (globalCoreCredentials) {
          // If email is set, activation is complete — clean up stale claim fields
          if (globalCoreCredentials.email && globalCoreCredentials.claimUrl) {
            globalCoreCredentials.claimUrl = "";
            globalCoreCredentials.verificationCode = "";
            saveCoreCredentials(globalCoreCredentials);
          }
          globalBehaviorDetector.setCredentials(globalCoreCredentials);
          if (globalCoreCredentials.claimUrl) {
            log.info(
              `Platform: registered, pending activation (${globalCoreCredentials.agentId}) — run /og_activate`,
            );
          } else {
            log.info(`Platform: active (${globalCoreCredentials.agentId})`);
          }
        } else {
          log.info("Platform: not registered — run /og_activate to enable behavioral detection");
        }
      }
    }

    // ── Email polling ─────────────────────────────────────────────
    // If credentials exist but no email, poll Core immediately + every 60s

    if (globalCoreCredentials && !globalCoreCredentials.email && !emailPollTimer) {
      const creds = globalCoreCredentials;
      const checkEmail = async () => {
        const result = await pollAccountEmail(creds.apiKey, config.platformUrl);
        if (result?.email) {
          creds.email = result.email;
          creds.claimUrl = "";
          creds.verificationCode = "";
          saveCoreCredentials(creds);
          log.info(`Platform: activated — ${result.email}`);
          if (emailPollTimer) {
            clearInterval(emailPollTimer);
            emailPollTimer = null;
          }
        }
      };
      // Immediate check (non-blocking), then every 60s
      checkEmail();
      emailPollTimer = setInterval(checkEmail, 60_000);
    }

    // ── Hooks ────────────────────────────────────────────────────

    // Capture initial user prompt as intent for overlap scoring
    api.on("before_agent_start", async (event, ctx) => {
      if (globalBehaviorDetector && event.prompt) {
        const text = typeof event.prompt === "string" ? event.prompt : JSON.stringify(event.prompt);
        globalBehaviorDetector.setUserIntent(ctx.sessionKey ?? "", text);
      }
    });

    // Capture ongoing user messages
    api.on("message_received", async (event, ctx) => {
      if (globalBehaviorDetector && event.from === "user") {
        const text =
          typeof event.content === "string"
            ? event.content
            : Array.isArray(event.content)
              ? (event.content as Array<{ text?: string }>).map((c) => c.text ?? "").join(" ")
              : String(event.content ?? "");
        globalBehaviorDetector.setUserIntent((ctx as any).sessionKey ?? "", text);
      }
    });

    // Clear behavioral state when session ends
    api.on("session_end", async (event, ctx) => {
      globalBehaviorDetector?.clearSession((ctx as any).sessionKey ?? event.sessionId ?? "");
    });

    // Core detection hook — may block the tool call
    api.on("before_tool_call", async (event, ctx) => {
      log.debug?.(`before_tool_call: ${event.toolName}`);

      if (globalBehaviorDetector) {
        const decision = await globalBehaviorDetector.onBeforeToolCall(
          { sessionKey: ctx.sessionKey ?? "", agentId: ctx.agentId },
          { toolName: event.toolName, params: event.params as Record<string, unknown> },
        );
        if (decision?.block) {
          log.warn(`BLOCKED "${event.toolName}": ${decision.blockReason}`);
          return { block: true, blockReason: decision.blockReason };
        }
      }
    }, { priority: 100 });

    // Record completed tool for chain history
    api.on("after_tool_call", async (event, ctx) => {
      log.debug?.(`after_tool_call: ${event.toolName} (${event.durationMs}ms)`);

      globalBehaviorDetector?.onAfterToolCall(
        { sessionKey: ctx.sessionKey ?? "" },
        {
          toolName: event.toolName,
          params: event.params as Record<string, unknown>,
          result: event.result,
          error: event.error,
          durationMs: event.durationMs,
        },
      );
    });

    // ── Commands ─────────────────────────────────────────────────

    api.registerCommand({
      name: "og_status",
      description: "Show OpenGuardrails status",
      requireAuth: true,
      handler: async () => {
        const creds = globalCoreCredentials;
        const lines = ["**OpenGuardrails Status**", ""];

        if (creds) {
          lines.push(`- Agent ID:  ${creds.agentId}`);
          lines.push(`- API Key:   ${creds.apiKey.slice(0, 12)}...`);
          if (creds.email) {
            lines.push(`- Email:     ${creds.email}`);
          }
          lines.push(`- Platform:  ${config.platformUrl}`);
          if (creds.claimUrl) {
            lines.push("- Status:    pending activation — run `/og_activate`");
          } else {
            lines.push("- Status:    active");
          }
        } else {
          lines.push("- Status:    not registered — run `/og_activate` to register");
          lines.push(`- Platform:  ${config.platformUrl}`);
        }

        lines.push("");
        lines.push(`- blockOnRisk: ${config.blockOnRisk}`);

        return { text: lines.join("\n") };
      },
    });

    api.registerCommand({
      name: "og_activate",
      description: "Register and show activation instructions",
      requireAuth: true,
      handler: async () => {
        // Already registered — show current status
        if (globalCoreCredentials) {
          const { agentId, claimUrl, verificationCode, apiKey } = globalCoreCredentials;

          if (!claimUrl) {
            return {
              text: [
                "**OpenGuardrails: Active**",
                "",
                `Agent ID: ${agentId}`,
                `API Key:  ${apiKey.slice(0, 12)}...`,
                "",
                "Behavioral detection is active.",
              ].join("\n"),
            };
          }

          return {
            text: [
              "**OpenGuardrails: Claim Your Agent**",
              "",
              `Agent ID: ${agentId}`,
              "",
              "Complete these steps to activate behavioral detection:",
              "",
              `  1. Visit:  ${claimUrl}`,
              `  2. Code:   ${verificationCode}`,
              `  3. Email:  your email becomes your dashboard login`,
              `             (magic link, no password needed)`,
              "",
              "After claiming you get **30,000 free** detections.",
              `Dashboard: ${config.platformUrl}`,
            ].join("\n"),
          };
        }

        // Not registered yet — register now
        try {
          log.info(`Registering with ${config.platformUrl}...`);
          globalCoreCredentials = await registerWithCore(
            config.agentName,
            "OpenClaw AI Agent secured by OpenGuardrails",
            config.platformUrl,
          );
          globalBehaviorDetector!.setCredentials(globalCoreCredentials);
          log.info("Registration successful!");
        } catch (err) {
          return {
            text: [
              "**OpenGuardrails: Registration Failed**",
              "",
              `Could not reach ${config.platformUrl}.`,
              `Error: ${err}`,
              "",
              "Possible fixes:",
              "- Check that the platform is running",
              "- Set `platformUrl` in plugin config to point to your local instance",
              "- Or set `apiKey` directly in plugin config to skip registration",
            ].join("\n"),
          };
        }

        const { agentId, claimUrl, verificationCode } = globalCoreCredentials;

        return {
          text: [
            "**OpenGuardrails: Claim Your Agent**",
            "",
            `Agent ID: ${agentId}`,
            "",
            "Complete these steps to activate behavioral detection:",
            "",
            `  1. Visit:  ${claimUrl}`,
            `  2. Code:   ${verificationCode}`,
            `  3. Email:  your email becomes your dashboard login`,
            `             (magic link, no password needed)`,
            "",
            "After claiming you get **30,000 free** detections.",
            `Dashboard: ${config.platformUrl}`,
          ].join("\n"),
        };
      },
    });
  },

  async unregister() {
    if (emailPollTimer) {
      clearInterval(emailPollTimer);
      emailPollTimer = null;
    }
    globalCoreCredentials = null;
    globalBehaviorDetector = null;
  },
};

export default openClawGuardPlugin;
