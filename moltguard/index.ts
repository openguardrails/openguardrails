/**
 * OpenGuardrails Plugin for OpenClaw
 *
 * Responsibilities:
 *   1. Load credentials from disk on startup (no network)
 *   2. Auto-register on first load (autonomous mode, 500/day quota)
 *   3. Detect behavioral anomalies at before_tool_call (block / alert)
 *   4. Expose /og_status, /og_upgrade, /og_config commands
 */

// SDK compatibility: try new path first, fall back to old path
// New SDK (>=2.0): openclaw/plugin-sdk/plugin-entry
// Old SDK (<2.0): openclaw/plugin-sdk (deprecated but still works)
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

let definePluginEntry: ((def: any) => any) | null = null;
try {
  // Dynamic require to avoid build-time errors on old SDK
  const mod = require("openclaw/plugin-sdk/plugin-entry");
  definePluginEntry = mod.definePluginEntry;
} catch {
  // Old SDK - definePluginEntry not available, will use direct export
}

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { OpenClawGuardConfig, Logger } from "./agent/types.js";
import {
  resolveConfig,
  loadCoreCredentials,
  saveCoreCredentials,
  deleteCoreCredentials,
  registerWithCore,
  readAgentProfile,
  getProfileWatchPaths,
  DEFAULT_CORE_URL,
  type CoreCredentials,
  type RegisterResult,
} from "./agent/config.js";
import { BehaviorDetector, FILE_READ_TOOLS, WEB_FETCH_TOOLS } from "./agent/behavior-detector.js";
import { EventReporter } from "./agent/event-reporter.js";
import { BusinessReporter } from "./agent/business-reporter.js";
import { ConfigSync, type BusinessConfig } from "./agent/config-sync.js";
import { isBlockingHook, type HookType } from "./agent/hook-types.js";
import { DashboardClient } from "./platform-client/index.js";
import { enableGateway, disableGateway, getGatewayStatus, startGateway, stopGateway, setDashboardPort, setGatewayActivityCallback } from "./agent/gateway-manager.js";
import { FileWatcher } from "./agent/file-watcher.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { openclawHome } from "./agent/env.js";
import { loadJsonSync } from "./agent/fs-utils.js";

// =============================================================================
// Constants
// =============================================================================

const PLUGIN_ID = "moltguard";
const PLUGIN_NAME = "MoltGuard";
const PLUGIN_VERSION = "6.7.0";
const LOG_PREFIX = `[${PLUGIN_ID}]`;

// =============================================================================
// Debug file logger — writes to openclaw logs dir for agentic hours diagnosis
// =============================================================================

const DEBUG_LOG_PATH = path.join(
  openclawHome,
  "logs",
  "moltguard-debug.log",
);

function debugLog(msg: string): void {
  try {
    const ts = new Date().toISOString();
    fs.appendFileSync(DEBUG_LOG_PATH, `[${ts}] ${msg}\n`);
  } catch { /* ignore */ }
}

// =============================================================================
// API Helpers
// =============================================================================

/** Infer tool category from tool name for business reporting */
function inferToolCategory(toolName: string): string {
  const name = toolName.toLowerCase();
  if (FILE_READ_TOOLS.has(toolName) || FILE_READ_TOOLS.has(name)) return "file_read";
  if (WEB_FETCH_TOOLS.has(toolName) || WEB_FETCH_TOOLS.has(name)) return "web_fetch";
  if (["bash", "shell", "run_command", "execute"].some((t) => name.includes(t))) return "shell";
  if (["write", "edit", "create_file", "delete"].some((t) => name.includes(t))) return "file_write";
  if (name.includes("agent") || name.includes("subagent")) return "agent";
  return "other";
}

/** Mask API key for display: sk-og-abc... */
function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 12) return apiKey;
  return `${apiKey.slice(0, 12)}...`;
}


type AccountStatus = {
  email: string | null;
  plan: string;
  quotaUsed: number;
  quotaTotal: number;
  /** true = autonomous mode (no email), false = human managed mode (email verified) */
  isAutonomous: boolean;
  resetAt: string | null;
};

/** Get account status from Core API */
async function getAccountStatus(apiKey: string, coreUrl: string): Promise<AccountStatus> {
  try {
    const res = await fetch(`${coreUrl}/api/v1/account`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      return { email: null, plan: "free", quotaUsed: 0, quotaTotal: 500, isAutonomous: true, resetAt: null };
    }
    const data = (await res.json()) as {
      success: boolean;
      email?: string | null;
      plan?: string;
      quotaUsed?: number;
      quotaTotal?: number;
      isAutonomous?: boolean;
      resetAt?: string | null;
    };
    if (!data.success) {
      return { email: null, plan: "free", quotaUsed: 0, quotaTotal: 500, isAutonomous: true, resetAt: null };
    }
    return {
      email: data.email ?? null,
      plan: data.plan ?? "free",
      quotaUsed: data.quotaUsed ?? 0,
      quotaTotal: data.quotaTotal ?? 100,
      isAutonomous: data.isAutonomous ?? !data.email,
      resetAt: data.resetAt ?? null,
    };
  } catch {
    return { email: null, plan: "free", quotaUsed: 0, quotaTotal: 500, isAutonomous: true, resetAt: null };
  }
}

type ApiKeyValidation = {
  valid: boolean;
  agentId?: string;
  email?: string | null;
  plan?: string;
  quotaUsed?: number;
  quotaTotal?: number;
  error?: string;
};

/** Validate an API key against Core */
async function validateApiKey(apiKey: string, coreUrl: string): Promise<ApiKeyValidation> {
  try {
    const res = await fetch(`${coreUrl}/api/v1/account`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      if (res.status === 401) {
        return { valid: false, error: "Invalid API key" };
      }
      return { valid: false, error: `API error: ${res.status}` };
    }
    const data = (await res.json()) as {
      success: boolean;
      agentId?: string;
      email?: string | null;
      plan?: string;
      quotaUsed?: number;
      quotaTotal?: number;
    };
    if (!data.success) {
      return { valid: false, error: "API returned failure" };
    }
    return {
      valid: true,
      agentId: data.agentId,
      email: data.email,
      plan: data.plan ?? "free",
      quotaUsed: data.quotaUsed ?? 0,
      quotaTotal: data.quotaTotal ?? 100,
    };
  } catch (err) {
    return { valid: false, error: `Network error: ${err}` };
  }
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
// Database driver check (libsql)
// =============================================================================
// Note: @libsql/client has native bindings with WASM fallback, no manual setup needed.

// =============================================================================
// Plugin state (module-level — survives plugin re-registration within a process)
// =============================================================================

let globalCoreCredentials: CoreCredentials | null = null;
let globalBehaviorDetector: BehaviorDetector | null = null;
let globalEventReporter: EventReporter | null = null;
let globalBusinessReporter: BusinessReporter | null = null;
let globalConfigSync: ConfigSync | null = null;
let globalDashboardClient: DashboardClient | null = null;
let globalFileWatcher: FileWatcher | null = null;
let dashboardHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
let profileWatchers: ReturnType<typeof fs.watch>[] = [];
let profileDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let lastRegisterResult: RegisterResult | null = null;
// Track quota exceeded notification (only notify once per session)
let quotaExceededNotified = false;
// Track personal dashboard auto-start state
let personalDashboardStarted = false;
// Track LLM input timestamps per session for duration calculation
const llmInputTimestamps = new Map<string, number>();
// Track auto-scan state
let autoScanEnabled = false;
// Track current account plan
let currentAccountPlan = "free";

// =============================================================================
// Ensure default config in openclaw.json
// =============================================================================

/**
 * Previously wrote default config to openclaw.json on first load.
 * Now a no-op — we don't modify openclaw.json automatically.
 * Config is optional; defaults are applied in resolveConfig().
 */
function ensureDefaultConfig(_log: Logger): void {
  // no-op: don't write config to openclaw.json on fresh install
}

// =============================================================================
// Profile sync — watches workspace files and re-uploads on change
// =============================================================================

function startProfileSync(log: Logger): void {
  if (profileWatchers.length > 0) return; // already watching

  const paths = getProfileWatchPaths();

  const scheduleUpload = () => {
    if (profileDebounceTimer) clearTimeout(profileDebounceTimer);
    profileDebounceTimer = setTimeout(() => {
      if (!globalDashboardClient?.agentId) return;
      const profile = readAgentProfile();
      globalDashboardClient
        .updateProfile({
          ...(globalCoreCredentials?.agentId !== "configured"
            ? { openclawId: globalCoreCredentials?.agentId }
            : {}),
          ...profile,
        })
        .then(() => log.debug?.("Dashboard: profile synced"))
        .catch((err) => log.debug?.(`Dashboard: profile sync failed — ${err}`));
    }, 2000);
    profileDebounceTimer.unref();
  };

  for (const watchPath of paths) {
    try {
      if (!fs.existsSync(watchPath)) continue;
      const watcher = fs.watch(watchPath, { recursive: false }, scheduleUpload);
      watcher.unref();
      profileWatchers.push(watcher);
    } catch {
      // Non-critical — fs.watch may not be available in all environments
    }
  }

  if (profileWatchers.length > 0) {
    log.debug?.(`Dashboard: watching ${profileWatchers.length} path(s) for profile changes`);
  }
}

// =============================================================================
// Plugin Definition
// =============================================================================

const openClawGuardPlugin = {
  id: PLUGIN_ID,
  name: PLUGIN_NAME,
  description: "Security guard for OpenClaw agents",

  register(api: OpenClawPluginApi) {
    const log = createLogger(api.logger);

    // ── Start AI Security Gateway (in-process) ────────────────────────
    // Gateway runs in the plugin process and is always available.
    // Users enable sanitization via /og_sanitize on, which routes agents through it.
    // Async: waits for port availability (old process may hold it during plugin update).
    startGateway()
      .then(() => log.debug?.("AI Security Gateway started"))
      .catch((err) => log.error(`Failed to start AI Security Gateway: ${err}`));

    // Set dashboard port immediately so gateway can report activity
    // (Dashboard will start later, but port is fixed at 53667)
    const DASHBOARD_PORT = 53667;
    setDashboardPort(DASHBOARD_PORT);
    log.debug?.(`Gateway activity reporting enabled on port ${DASHBOARD_PORT}`);

    // Ensure openclaw.json has default config (coreUrl) on first load
    const pluginConfig = (api.pluginConfig ?? {}) as OpenClawGuardConfig;
    debugLog(`=== PLUGIN REGISTER ===`);
    debugLog(`pluginConfig: ${JSON.stringify(pluginConfig)}`);
    if (!pluginConfig.coreUrl) {
      ensureDefaultConfig(log);
    }

    const config = resolveConfig(pluginConfig);
    const isEnterprise = config.plan === "enterprise";

    if (config.enabled === false) {
      log.info("Plugin disabled via config");
      return;
    }

    debugLog(`resolved config: plan=${config.plan}, coreUrl=${config.coreUrl}, isEnterprise=${isEnterprise}`);

    if (isEnterprise) {
      log.info(`Enterprise mode: Core → ${config.coreUrl}`);
    }

    // ── Local initialization (no network) ────────────────────────

    if (!globalBehaviorDetector) {
      globalBehaviorDetector = new BehaviorDetector(
        {
          coreUrl: config.coreUrl,
          assessTimeoutMs: Math.min(config.timeoutMs, 3000),
          blockOnRisk: config.blockOnRisk,
          pluginVersion: PLUGIN_VERSION,
        },
        log,
      );
    }

    if (!globalEventReporter) {
      globalEventReporter = new EventReporter(
        {
          coreUrl: config.coreUrl,
          pluginVersion: PLUGIN_VERSION,
          timeoutMs: Math.min(config.timeoutMs, 3000),
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
        globalEventReporter?.setCredentials(globalCoreCredentials);
        log.info("Platform: using configured API key");
      } else {
        debugLog(`loadCoreCredentials(${config.coreUrl}) called`);
        globalCoreCredentials = loadCoreCredentials(config.coreUrl);
        debugLog(`loadCoreCredentials result: ${globalCoreCredentials ? `apiKey=${globalCoreCredentials.apiKey?.slice(0,10)}... agentId=${globalCoreCredentials.agentId} coreUrl=${globalCoreCredentials.coreUrl}` : "null"}`);
        if (globalCoreCredentials) {
          globalBehaviorDetector.setCredentials(globalCoreCredentials);
          globalEventReporter?.setCredentials(globalCoreCredentials);
          const mode = globalCoreCredentials.email ? "human managed" : "autonomous";
          log.info(`Platform: active (${mode} mode)`);
        } else {
          // Auto-register on first load — agent is immediately usable with autonomous quota
          log.info("Platform: auto-registering...");
          debugLog(`registerWithCore(${config.agentName}, coreUrl=${config.coreUrl})`);
          registerWithCore(
            config.agentName,
            "OpenClaw AI Agent secured by OpenGuardrails",
            config.coreUrl,
          )
            .then((result) => {
              debugLog(`registerWithCore SUCCESS: agentId=${result.credentials.agentId} apiKey=${result.credentials.apiKey?.slice(0,10)}...`);
              lastRegisterResult = result;
              globalCoreCredentials = result.credentials;
              globalBehaviorDetector!.setCredentials(result.credentials);
              globalEventReporter?.setCredentials(result.credentials);

              // Start personal dashboard (auto-starts local dashboard and connects to it)
              initPersonalDashboard(config.coreUrl);

              // Check for business plan features
              initBusinessFeatures(config.coreUrl);

              // Agent is immediately active
              log.info(isEnterprise
                ? "Platform: registered (enterprise mode, unlimited quota)"
                : "Platform: registered (autonomous mode, 500/day quota)");
            })
            .catch((err) => {
              debugLog(`registerWithCore FAILED: ${err}`);
              log.warn(`Platform: auto-registration failed — ${err}`);
              log.info("Platform: local protections still active");
            });
        }
      }
    }

    // ── Personal Dashboard auto-start ─────────────────────────────────
    // Starts the local dashboard automatically when the plugin loads.
    // Data is stored in the plugin's data directory.

    async function initPersonalDashboard(coreUrl: string): Promise<void> {
      debugLog(`initPersonalDashboard: called, personalDashboardStarted=${personalDashboardStarted}`);
      if (personalDashboardStarted) { debugLog("initPersonalDashboard: already started, skipping"); return; }
      personalDashboardStarted = true;

      // Delay startup to avoid starting in short-lived CLI processes (e.g., openclaw plugins install).
      // The unref'd timer won't prevent short-lived processes from exiting, so the dashboard
      // never starts in CLI context. In the long-lived gateway daemon, the timer fires normally.
      await new Promise<void>(resolve => {
        const t = setTimeout(resolve, 5000);
        t.unref();
      });

      try {
        const { startLocalDashboard, getPluginDataDir, DASHBOARD_PORT, DevModeError } = await import("./dashboard-launcher.js");
        const dataDir = getPluginDataDir();
        const result = await startLocalDashboard({
          apiKey: globalCoreCredentials?.apiKey ?? "",
          agentId: globalCoreCredentials?.agentId ?? "",
          coreUrl,
          dataDir,
          autoStart: true,
        });
        log.info(`OpenGuardrails dashboard started at ${result.localUrl}`);

        // Connect to local dashboard for observation reporting
        // Use the session token from startLocalDashboard, not the Core API key
        initDashboardClient(result.token, `http://localhost:${DASHBOARD_PORT}`);
      } catch (err) {
        // Dev mode or startup failure - silently continue
        debugLog(`initPersonalDashboard FAILED: ${err}`);
        log.debug?.(`Dashboard auto-start skipped: ${err}`);
      }
    }

    // ── Dashboard client initialization ─────────────────────────────
    // Connects to the dashboard for observation reporting.
    // Uses the local session token for auth.

    function initDashboardClient(sessionToken: string, dashboardUrl: string): void {
      debugLog(`initDashboardClient: dashboardUrl=${dashboardUrl} token=${sessionToken?.slice(0,8)}...`);
      if (globalDashboardClient) { debugLog("initDashboardClient: already initialized, skipping"); return; }
      if (!dashboardUrl || !sessionToken) { debugLog("initDashboardClient: missing url or token, skipping"); return; }

      globalDashboardClient = new DashboardClient({
        dashboardUrl,
        sessionToken,
      });

      // Register agent then upload full profile (non-blocking)
      const profile = readAgentProfile();
      globalDashboardClient
        .registerAgent({
          name: config.agentName,
          description: "OpenClaw AI Agent secured by OpenGuardrails",
          provider: profile.provider || undefined,
          metadata: {
            ...(globalCoreCredentials?.agentId !== "configured" ? { openclawId: globalCoreCredentials?.agentId } : {}),
            ...profile,
          },
        })
        .then((result) => {
          if (result.success && result.data?.id) {
            log.debug?.(`Dashboard: agent registered (${result.data.id})`);
            startProfileSync(log);
          }
        })
        .catch((err) => {
          log.warn(`Dashboard: registration failed — ${err}`);
        });

      // Start periodic heartbeat
      dashboardHeartbeatTimer = globalDashboardClient.startHeartbeat(60_000);
      log.debug?.(`Dashboard: connected to ${dashboardUrl}`);
    }

    // Start personal dashboard unconditionally (like gateway at line 306).
    // Dashboard server starts even without credentials — credentials are optional.
    // If registerWithCore() is in-flight, dashboard will start with empty credentials;
    // the dashboard server itself doesn't need them to listen.
    initPersonalDashboard(config.coreUrl);

    // ── Business plan initialization ───────────────────────────────
    // Check account plan and initialize BusinessReporter + ConfigSync if business.

    async function initBusinessFeatures(coreUrl: string): Promise<void> {
      debugLog(`initBusinessFeatures: called, credentials=${!!globalCoreCredentials}, isEnterprise=${isEnterprise}`);
      if (!globalCoreCredentials) { debugLog("initBusinessFeatures: no credentials, skipping"); return; }

      try {
        let plan: string;
        if (isEnterprise) {
          // Enterprise mode: always business plan, skip remote check
          plan = "business";
        } else {
          const status = await getAccountStatus(globalCoreCredentials.apiKey, coreUrl);
          plan = status.plan;
        }
        currentAccountPlan = plan;
        debugLog(`initBusinessFeatures: plan=${plan}`);

        if (plan !== "business") {
          debugLog(`initBusinessFeatures: plan is not business, skipping`);
          log.debug?.(`Account plan is "${plan}", business features not enabled`);
          return;
        }

        // Initialize BusinessReporter
        if (!globalBusinessReporter) {
          globalBusinessReporter = new BusinessReporter(
            { coreUrl, pluginVersion: PLUGIN_VERSION },
            log,
          );
          globalBusinessReporter.setCredentials(globalCoreCredentials);

          // Set profile from workspace
          const profile = readAgentProfile();
          globalBusinessReporter.setProfile({
            ownerName: profile.ownerName,
            agentName: config.agentName,
            provider: profile.provider,
            model: profile.model,
          });

          globalBusinessReporter.initialize(plan);
          debugLog(`BusinessReporter initialized, enabled=${globalBusinessReporter.isEnabled()}`);

          // Wire gateway activity to business reporter
          if (globalBusinessReporter.isEnabled()) {
            setGatewayActivityCallback((redactionCount, typeCounts) => {
              globalBusinessReporter?.recordGatewayActivity(redactionCount, typeCounts);
            });

            // Wire secret detection to business reporter
            globalBehaviorDetector?.setOnSecretDetected((typeCounts) => {
              globalBusinessReporter?.recordSecretDetection(typeCounts);
            });
          }
        }

        // Initialize ConfigSync
        if (!globalConfigSync) {
          globalConfigSync = new ConfigSync(
            {
              coreUrl,
              onUpdate: (bizConfig: BusinessConfig) => {
                log.info(`ConfigSync: received ${bizConfig.policies.length} policies`);
                // Future: apply gateway config and policies locally
              },
            },
            log,
          );
          globalConfigSync.setCredentials(globalCoreCredentials);
          await globalConfigSync.initialize(plan);
        }
      } catch (err) {
        log.debug?.(`Business features init failed: ${err}`);
      }
    }

    if (globalCoreCredentials) {
      initBusinessFeatures(config.coreUrl);
    }

    // ── Hooks ────────────────────────────────────────────────────

    // Capture initial user prompt as intent + inject OpenGuardrails context
    api.on("before_agent_start", async (event, ctx) => {
      const sessionKey = ctx.sessionKey ?? "";
      const text = typeof event.prompt === "string" ? event.prompt : JSON.stringify(event.prompt ?? "");

      // Set up run ID for this session
      const runId = `run-${randomBytes(8).toString("hex")}`;
      globalEventReporter?.setRunId(sessionKey, runId);

      if (globalBehaviorDetector && event.prompt) {
        globalBehaviorDetector.setUserIntent(sessionKey, text);
      }

      // Report to Core (non-blocking)
      globalEventReporter?.report(sessionKey, "before_agent_start", {
        timestamp: new Date().toISOString(),
        prompt: text,
        systemPrompt: (event as any).systemPrompt,
        conversationId: (event as any).conversationId,
      });

    });

    // Capture ongoing user messages
    api.on("message_received", async (event, ctx) => {
      const sessionKey = (ctx as any).sessionKey ?? "";
      const text =
        typeof event.content === "string"
          ? event.content
          : Array.isArray(event.content)
            ? (event.content as Array<{ text?: string }>).map((c) => c.text ?? "").join(" ")
            : String(event.content ?? "");

      if (globalBehaviorDetector && event.from === "user") {
        globalBehaviorDetector.setUserIntent(sessionKey, text);
      }

      // Report to Core (non-blocking)
      globalEventReporter?.report(sessionKey, "message_received", {
        timestamp: new Date().toISOString(),
        from: event.from as "user" | "assistant" | "system" | "tool",
        content: text.slice(0, 100000), // Truncate very large content
        contentLength: text.length,
      });
    });

    // Clear behavioral state when session ends
    api.on("session_end", async (event, ctx) => {
      const sessionKey = (ctx as any).sessionKey ?? event.sessionId ?? "";

      // Report to Core (non-blocking)
      globalEventReporter?.report(sessionKey, "session_end", {
        timestamp: new Date().toISOString(),
        sessionId: event.sessionId ?? sessionKey,
        durationMs: (event as any).durationMs,
      });

      // Report session end to business reporter
      globalBusinessReporter?.recordSession("end", (event as any).durationMs);

      globalBehaviorDetector?.clearSession(sessionKey);
      globalEventReporter?.clearSession(sessionKey);
    });

    // Core detection hook — may block the tool call
    api.on("before_tool_call", async (event, ctx) => {
      log.debug?.(`before_tool_call: ${event.toolName}`);

      let blocked = false;
      let blockReason: string | undefined;

      if (globalBehaviorDetector) {
        const decision = await globalBehaviorDetector.onBeforeToolCall(
          { sessionKey: ctx.sessionKey ?? "", agentId: ctx.agentId },
          { toolName: event.toolName, params: event.params as Record<string, unknown> },
        );
        if (decision?.block) {
          blocked = true;
          blockReason = decision.blockReason;
          log.warn(`BLOCKED "${event.toolName}": ${decision.blockReason}`);
        }
      }

      // Report to dashboard (non-blocking)
      if (globalDashboardClient?.agentId) {
        globalDashboardClient
          .reportToolCall({
            agentId: globalDashboardClient.agentId,
            sessionKey: ctx.sessionKey,
            toolName: event.toolName,
            params: event.params as Record<string, unknown>,
            phase: "before",
            blocked,
            blockReason,
          })
          .catch((err) => {
            log.debug?.(`Dashboard: report failed (before ${event.toolName}) — ${err}`);
          });
      }

      if (blocked) {
        // Report blocked tool call to business reporter
        globalBusinessReporter?.recordToolCall(
          event.toolName,
          inferToolCategory(event.toolName),
          0,
          true,
        );
        // Record blocked call for local agentic hours
        globalDashboardClient?.recordToolCallDuration(0, true);
        return { block: true, blockReason };
      }
    }, { priority: 100 });

    // Scan tool results for content injection before they reach the LLM
    // Also append quota exceeded messages when applicable
    api.on("tool_result_persist", (event, ctx) => {
      log.info(`tool_result_persist triggered: toolName=${event.toolName ?? ctx.toolName ?? "unknown"}`);

      if (!globalBehaviorDetector) {
        log.debug?.("tool_result_persist: no detector");
        return;
      }

      // Resolve tool name from event, context, or the message itself
      const message = event.message;
      const msgToolName = message && "toolName" in message ? (message as { toolName?: string }).toolName : undefined;
      const toolName = event.toolName ?? ctx.toolName ?? msgToolName;
      log.debug?.(`tool_result_persist: toolName=${toolName ?? "(none)"} [event=${event.toolName}, ctx=${ctx.toolName}, msg=${msgToolName}]`);

      // Check message structure first before consuming quota message
      if (!message || !("content" in message) || !Array.isArray(message.content)) {
        log.debug?.(`tool_result_persist: message.content not an array (role=${message && "role" in message ? (message as any).role : "?"})`);
        // Don't consume quota message if we can't append it
        return;
      }

      // Report to Core (non-blocking)
      globalEventReporter?.report(ctx.sessionKey ?? "", "tool_result_persist", {
        timestamp: new Date().toISOString(),
        toolName,
        modified: false,
      });

      // Local injection scanning removed - all detection handled by Core
      return undefined;
    }, { priority: 100 });

    // Record completed tool for chain history + scan content for injection via Core
    api.on("after_tool_call", async (event, ctx) => {
      log.debug?.(`after_tool_call: ${event.toolName} (${event.durationMs}ms)`);

      if (globalBehaviorDetector) {
        globalBehaviorDetector.onAfterToolCall(
          { sessionKey: ctx.sessionKey ?? "" },
          {
            toolName: event.toolName,
            params: event.params as Record<string, unknown>,
            result: event.result,
            error: event.error,
            durationMs: event.durationMs,
          },
        );

        // Scan ALL tool results for injection via Core (not just file read / web fetch)
        if (event.result && !event.error) {
          const resultText = typeof event.result === "string"
            ? event.result
            : JSON.stringify(event.result);

          // Only scan if content is non-trivial (> 20 chars to avoid noise)
          if (resultText.length > 20) {
            const scanResult = await globalBehaviorDetector.scanContent(
              ctx.sessionKey ?? "",
              event.toolName,
              resultText,
            );

            if (scanResult?.detected) {
              log.warn(
                `Core: injection detected in "${event.toolName}" result: ${scanResult.summary}`,
              );

              // Report detection to business reporter
              globalBusinessReporter?.recordDetection(
                scanResult.detected ? "high" : "no_risk",
                false,
                scanResult.summary,
              );
              // Report dynamic scan result to business reporter
              globalBusinessReporter?.recordScanResult(
                "dynamic",
                scanResult.categories ?? [],
                true,
              );
              // Record risk event for local agentic hours
              globalDashboardClient?.recordRiskEvent();
            }

            // Report detection result to dashboard (non-blocking)
            if (scanResult && globalDashboardClient) {
              // Calculate sensitivity score from findings confidence
              // high=0.9, medium=0.7, low=0.5, take max
              const confidenceScores: Record<string, number> = { high: 0.9, medium: 0.7, low: 0.5 };
              const sensitivityScore = scanResult.findings.length > 0
                ? Math.max(...scanResult.findings.map((f) => confidenceScores[f.confidence] ?? 0.5))
                : 0;

              globalDashboardClient
                .reportDetection({
                  agentId: globalDashboardClient.agentId || "unknown",
                  sessionKey: ctx.sessionKey,
                  toolName: event.toolName,
                  safe: !scanResult.detected,
                  categories: scanResult.categories,
                  findings: scanResult.findings.map((f) => ({
                    scanner: f.scanner,
                    name: f.name,
                    matchedText: f.matchedText,
                    confidence: f.confidence,
                  })),
                  sensitivityScore,
                  latencyMs: scanResult.latency_ms,
                })
                .catch((err) => {
                  log.debug?.(`Dashboard: detection report failed — ${err}`);
                });
            }
          }
        }
      }

      // Report to dashboard (non-blocking)
      if (globalDashboardClient?.agentId) {
        globalDashboardClient
          .reportToolCall({
            agentId: globalDashboardClient.agentId,
            sessionKey: ctx.sessionKey,
            toolName: event.toolName,
            params: event.params as Record<string, unknown>,
            phase: "after",
            result: event.error ? undefined : "ok",
            error: event.error,
            durationMs: event.durationMs,
          })
          .catch((err) => {
            log.debug?.(`Dashboard: report failed (after ${event.toolName}) — ${err}`);
          });
      }

      // Report tool call to business reporter (with duration and category)
      debugLog(`after_tool_call: tool=${event.toolName} durationMs=${event.durationMs} dashboardClient=${!!globalDashboardClient} businessReporter=${!!globalBusinessReporter} businessEnabled=${globalBusinessReporter?.isEnabled()}`);
      globalBusinessReporter?.recordToolCall(
        event.toolName,
        inferToolCategory(event.toolName),
        event.durationMs ?? 0,
        false, // not blocked (blocked calls don't reach after_tool_call)
      );

      // Record tool call duration for local agentic hours
      globalDashboardClient?.recordToolCallDuration(event.durationMs ?? 0);
    });

    // ── New Hooks (18 additional hooks for complete context) ────
    // Note: Many of these hooks may not be in the OpenClaw SDK types yet.
    // We use type assertions to register them, and they'll work at runtime
    // when/if OpenClaw supports them.

    const apiAny = api as any;

    // Agent lifecycle: agent_end
    apiAny.on("agent_end", async (event: any, ctx: any) => {
      const sessionKey = ctx?.sessionKey ?? "";
      globalEventReporter?.report(sessionKey, "agent_end", {
        timestamp: new Date().toISOString(),
        reason: event?.reason ?? "unknown",
        error: event?.error,
        durationMs: event?.durationMs,
      });
    });

    // Session lifecycle: session_start
    apiAny.on("session_start", async (event: any, ctx: any) => {
      const sessionKey = ctx?.sessionKey ?? "";
      const sessionId = event?.sessionId ?? sessionKey;

      // Set up run ID if not already set
      if (!globalEventReporter?.getRunId(sessionKey)) {
        const runId = `run-${randomBytes(8).toString("hex")}`;
        globalEventReporter?.setRunId(sessionKey, runId);
      }

      globalEventReporter?.report(sessionKey, "session_start", {
        timestamp: new Date().toISOString(),
        sessionId,
        isNew: event?.isNew ?? true,
      });

      // Report session start to business reporter
      debugLog(`session_start: sessionKey=${sessionKey} dashboardClient=${!!globalDashboardClient} businessReporter=${!!globalBusinessReporter}`);
      globalBusinessReporter?.recordSession("start");

      // Record session start for local agentic hours
      globalDashboardClient?.recordSessionStart();
    });

    // Model resolution: before_model_resolve
    apiAny.on("before_model_resolve", async (event: any, ctx: any) => {
      const sessionKey = ctx?.sessionKey ?? "";
      globalEventReporter?.report(sessionKey, "before_model_resolve", {
        timestamp: new Date().toISOString(),
        requestedModel: event?.model ?? event?.requestedModel ?? "unknown",
      });
    });

    // Prompt building: before_prompt_build
    apiAny.on("before_prompt_build", async (event: any, ctx: any) => {
      const sessionKey = ctx?.sessionKey ?? "";
      globalEventReporter?.report(sessionKey, "before_prompt_build", {
        timestamp: new Date().toISOString(),
        messageCount: event?.messageCount ?? event?.messages?.length ?? 0,
        tokenEstimate: event?.tokenEstimate,
      });
    });

    // LLM input: llm_input (critical for context)
    apiAny.on("llm_input", async (event: any, ctx: any) => {
      const sessionKey = ctx?.sessionKey ?? "";
      // Track timestamp for LLM duration calculation (OpenClaw may not provide latencyMs)
      llmInputTimestamps.set(sessionKey, Date.now());

      const content = typeof event?.content === "string"
        ? event.content
        : JSON.stringify(event?.messages ?? event?.content ?? "");

      globalEventReporter?.report(sessionKey, "llm_input", {
        timestamp: new Date().toISOString(),
        model: event?.model ?? "unknown",
        content: content.slice(0, 100000), // Truncate very large content
        contentLength: content.length,
        messageCount: event?.messages?.length ?? 1,
        tokenCount: event?.tokenCount,
        systemPrompt: event?.systemPrompt,
      });
    });

    // LLM output: llm_output (critical for context)
    apiAny.on("llm_output", async (event: any, ctx: any) => {
      const sessionKey = ctx?.sessionKey ?? "";
      const content = typeof event?.content === "string"
        ? event.content
        : JSON.stringify(event?.content ?? "");

      // Compute LLM duration: prefer event-provided, fall back to our own timing
      const inputTs = llmInputTimestamps.get(sessionKey);
      const llmDuration = event?.latencyMs ?? event?.durationMs ?? (inputTs ? Date.now() - inputTs : 0);
      if (inputTs) llmInputTimestamps.delete(sessionKey);

      globalEventReporter?.report(sessionKey, "llm_output", {
        timestamp: new Date().toISOString(),
        model: event?.model ?? "unknown",
        content: content.slice(0, 100000),
        contentLength: content.length,
        streamed: event?.streamed ?? false,
        tokenUsage: event?.usage ?? event?.tokenUsage,
        latencyMs: llmDuration,
        stopReason: event?.stopReason ?? event?.stop_reason,
      });

      // Report LLM call to business reporter
      debugLog(`llm_output: model=${event?.model} latencyMs=${event?.latencyMs} durationMs=${event?.durationMs} computed=${llmDuration} dashboardClient=${!!globalDashboardClient} businessReporter=${!!globalBusinessReporter}`);
      if (llmDuration > 0) {
        globalBusinessReporter?.recordLlmCall(llmDuration, event?.model);
        // Record LLM duration for local agentic hours
        globalDashboardClient?.recordLlmDuration(llmDuration);
      }
    });

    // Message sending: message_sending (blocking - can modify/cancel)
    // Note: This hook IS in the SDK, but we need special handling for the return type
    api.on("message_sending", async (event, ctx) => {
      const sessionKey = (ctx as any).sessionKey ?? "";
      const content = typeof event.content === "string"
        ? event.content
        : JSON.stringify(event.content ?? "");

      // Report to Core (non-blocking for now - blocking would require SDK support)
      globalEventReporter?.report(
        sessionKey,
        "message_sending",
        {
          timestamp: new Date().toISOString(),
          to: (event as any).to ?? "user",
          content: content.slice(0, 100000),
          contentLength: content.length,
        },
        false, // non-blocking until SDK supports return type
      );
    });

    // Message sent: message_sent
    api.on("message_sent", async (event, ctx) => {
      const sessionKey = (ctx as any).sessionKey ?? "";
      globalEventReporter?.report(sessionKey, "message_sent", {
        timestamp: new Date().toISOString(),
        to: (event as any).to ?? "user",
        success: true,
        durationMs: (event as any).durationMs,
      });
    });

    // Before message write: before_message_write (blocking)
    apiAny.on("before_message_write", async (event: any, ctx: any) => {
      const sessionKey = ctx?.sessionKey ?? "";
      const content = typeof event?.content === "string"
        ? event.content
        : JSON.stringify(event?.message ?? event?.content ?? "");

      const decision = await globalEventReporter?.report(
        sessionKey,
        "before_message_write",
        {
          timestamp: new Date().toISOString(),
          filePath: event?.filePath ?? event?.path ?? "unknown",
          content: content.slice(0, 100000),
          contentLength: content.length,
        },
        true, // blocking
      );

      if (decision?.block) {
        return { block: true, blockReason: decision.reason };
      }
    });

    // Compaction: before_compaction
    api.on("before_compaction", async (event, ctx) => {
      const sessionKey = (ctx as any).sessionKey ?? "";
      globalEventReporter?.report(sessionKey, "before_compaction", {
        timestamp: new Date().toISOString(),
        messageCount: (event as any).messageCount ?? 0,
        tokenEstimate: (event as any).tokenEstimate,
        reason: (event as any).reason ?? "auto",
      });
    });

    // Compaction: after_compaction
    api.on("after_compaction", async (event, ctx) => {
      const sessionKey = (ctx as any).sessionKey ?? "";
      globalEventReporter?.report(sessionKey, "after_compaction", {
        timestamp: new Date().toISOString(),
        messageCount: (event as any).messageCount ?? 0,
        removedCount: (event as any).removedCount ?? 0,
        tokenEstimate: (event as any).tokenEstimate,
      });
    });

    // Reset: before_reset
    apiAny.on("before_reset", async (event: any, ctx: any) => {
      const sessionKey = ctx?.sessionKey ?? "";
      globalEventReporter?.report(sessionKey, "before_reset", {
        timestamp: new Date().toISOString(),
        reason: event?.reason ?? "unknown",
        messageCount: event?.messageCount ?? 0,
      });
    });

    // Subagent: subagent_spawning (blocking - critical for security)
    apiAny.on("subagent_spawning", async (event: any, ctx: any) => {
      const sessionKey = ctx?.sessionKey ?? "";
      const task = typeof event?.task === "string"
        ? event.task
        : typeof event?.prompt === "string"
          ? event.prompt
          : JSON.stringify(event?.task ?? event?.prompt ?? "");

      const decision = await globalEventReporter?.report(
        sessionKey,
        "subagent_spawning",
        {
          timestamp: new Date().toISOString(),
          subagentId: event?.subagentId ?? event?.id ?? "unknown",
          subagentType: event?.subagentType ?? event?.type ?? "unknown",
          task: task.slice(0, 100000),
          taskLength: task.length,
          parentContext: event?.parentContext,
        },
        true, // blocking
      );

      if (decision?.block) {
        log.warn(`BLOCKED subagent spawn: ${decision.reason}`);
        return { block: true, blockReason: decision.reason };
      }
    });

    // Subagent: subagent_delivery_target
    apiAny.on("subagent_delivery_target", async (event: any, ctx: any) => {
      const sessionKey = ctx?.sessionKey ?? "";
      globalEventReporter?.report(sessionKey, "subagent_delivery_target", {
        timestamp: new Date().toISOString(),
        subagentId: event?.subagentId ?? event?.id ?? "unknown",
        targetType: event?.targetType ?? event?.type ?? "unknown",
        targetDetails: event?.targetDetails ?? event?.details,
      });
    });

    // Subagent: subagent_spawned
    apiAny.on("subagent_spawned", async (event: any, ctx: any) => {
      const sessionKey = ctx?.sessionKey ?? "";
      globalEventReporter?.report(sessionKey, "subagent_spawned", {
        timestamp: new Date().toISOString(),
        subagentId: event?.subagentId ?? event?.id ?? "unknown",
        subagentType: event?.subagentType ?? event?.type ?? "unknown",
        success: event?.success ?? true,
        error: event?.error,
      });
    });

    // Subagent: subagent_ended
    apiAny.on("subagent_ended", async (event: any, ctx: any) => {
      const sessionKey = ctx?.sessionKey ?? "";
      globalEventReporter?.report(sessionKey, "subagent_ended", {
        timestamp: new Date().toISOString(),
        subagentId: event?.subagentId ?? event?.id ?? "unknown",
        reason: event?.reason ?? "unknown",
        resultSummary: event?.resultSummary ?? event?.result,
        error: event?.error,
        durationMs: event?.durationMs,
      });
    });

    // Gateway: gateway_start
    apiAny.on("gateway_start", async (event: any, ctx: any) => {
      const sessionKey = ctx?.sessionKey ?? "";
      globalEventReporter?.report(sessionKey, "gateway_start", {
        timestamp: new Date().toISOString(),
        port: event?.port ?? 0,
        url: event?.url ?? "",
      });
    });

    // Gateway: gateway_stop
    apiAny.on("gateway_stop", async (event: any, ctx: any) => {
      const sessionKey = ctx?.sessionKey ?? "";
      globalEventReporter?.report(sessionKey, "gateway_stop", {
        timestamp: new Date().toISOString(),
        reason: event?.reason ?? "unknown",
        error: event?.error,
      });
    });

    // ── Commands ─────────────────────────────────────────────────

    api.registerCommand({
      name: "og_status",
      description: "Show MoltGuard status, API key, and quota",
      requireAuth: true,
      handler: async () => {
        const creds = globalCoreCredentials;

        if (!creds) {
          return {
            text: [
              "**MoltGuard Status**",
              "",
              "- Status: Not registered (will auto-register on first use)",
              "- Local protection: Active",
            ].join("\n"),
          };
        }

        // Get live quota status from Core (skip in enterprise mode)
        const status = isEnterprise
          ? { email: "", plan: "enterprise", quotaUsed: 0, quotaTotal: 999_999_999, isAutonomous: false, resetAt: "" }
          : await getAccountStatus(creds.apiKey, config.coreUrl);
        const mode = status.isAutonomous ? "autonomous" : "human managed";
        const quotaDisplay = `${status.quotaUsed}/${status.quotaTotal}/day`;

        const lines = [
          "**MoltGuard Status**",
          "",
          `- API Key: ${maskApiKey(creds.apiKey)}`,
          `- Agent ID: ${creds.agentId}`,
          `- Email: ${status.email || "(not set)"}`,
          `- Plan: ${isEnterprise ? "enterprise" : status.plan}`,
          `- Quota: ${isEnterprise ? "unlimited" : quotaDisplay}${!isEnterprise && status.resetAt ? " (resets at UTC 0:00)" : ""}`,
          `- Mode: ${isEnterprise ? "enterprise" : mode}`,
          ...(isEnterprise ? [`- Core: ${config.coreUrl}`] : []),
          `- blockOnRisk: ${config.blockOnRisk}`,
          "",
          "Commands:",
          ...(isEnterprise ? [] : [
            "- /og_core — Open Core portal to upgrade plan",
            "- /og_claim — Show agent info for claiming",
          ]),
          "- /og_config — Configure API key",
        ];

        return { text: lines.join("\n") };
      },
    });

    api.registerCommand({
      name: "og_config",
      description: "Show how to configure API key for cross-machine sharing",
      requireAuth: true,
      handler: async () => {
        // Show configuration instructions
        // Note: OpenClaw commands don't support arguments directly.
        // Users configure API key via openclaw.json or environment variable.
        return {
          text: [
            "**Configure MoltGuard API Key**",
            "",
            "To use an existing API key (e.g., from a paid plan) across multiple machines:",
            "",
            "**Option 1: Edit openclaw.json**",
            "```json",
            "{",
            '  "plugins": {',
            '    "entries": {',
            '      "moltguard": {',
            '        "config": { "apiKey": "sk-og-<your-key>" }',
            "      }",
            "    }",
            "  }",
            "}",
            "```",
            "",
            "**Option 2: Environment variable**",
            "```bash",
            "export OG_API_KEY=sk-og-<your-key>",
            "```",
            "",
            "Then restart the gateway: `openclaw gateway restart`",
            "",
            `Get your API key from: ${config.coreUrl}/login`,
            "",
            `Current API key: ${globalCoreCredentials?.apiKey ? maskApiKey(globalCoreCredentials.apiKey) : "(none)"}`,
          ].join("\n"),
        };
      },
    });

    api.registerCommand({
      name: "og_core",
      description: "Open Core portal for account and billing",
      requireAuth: true,
      handler: async () => {
        return {
          text: [
            "**OpenGuardrails Core Portal**",
            "",
            "Manage your account, view usage, and upgrade your plan:",
            "",
            `  ${config.coreUrl}/login`,
            "",
            "Enter your email to receive a magic login link.",
          ].join("\n"),
        };
      },
    });

    api.registerCommand({
      name: "og_dashboard",
      description: "Start local Dashboard and get access URLs",
      requireAuth: true,
      handler: async () => {
        if (!globalCoreCredentials) {
          return {
            text: "MoltGuard not registered yet. It will auto-register on first use.",
          };
        }

        // Import dashboard launcher (dynamic to avoid circular deps)
        const { startLocalDashboard, DevModeError } = await import("./dashboard-launcher.js");

        try {
          const result = await startLocalDashboard({
            apiKey: globalCoreCredentials.apiKey,
            agentId: globalCoreCredentials.agentId,
            coreUrl: config.coreUrl,
          });

          return {
            text: [
              "**Dashboard URL**",
              "",
              result.localUrl,
            ].join("\n"),
          };
        } catch (err) {
          // Development mode: show instructions for manual startup
          if (err instanceof DevModeError) {
            return { text: err.getInstructions() };
          }
          return {
            text: [
              "**Dashboard Startup Failed**",
              "",
              `Error: ${err}`,
              "",
              "Try running the Dashboard manually:",
              "  cd dashboard && pnpm dev",
            ].join("\n"),
          };
        }
      },
    });

    api.registerCommand({
      name: "og_claim",
      description: "Display agent ID and API key for claiming on Core",
      requireAuth: true,
      handler: async () => {
        if (!globalCoreCredentials) {
          return {
            text: "MoltGuard not registered yet. It will auto-register on first use.",
          };
        }

        // Get current status to check if already claimed
        const status = await getAccountStatus(globalCoreCredentials.apiKey, config.coreUrl);

        if (status.email) {
          return {
            text: [
              "**Agent Already Claimed**",
              "",
              `This agent is already linked to: ${status.email}`,
              "",
              `Agent ID: ${globalCoreCredentials.agentId}`,
              `Plan: ${status.plan}`,
              `Quota: ${status.quotaUsed}/${status.quotaTotal}`,
              "",
              `Manage at: ${config.coreUrl}/login`,
            ].join("\n"),
          };
        }

        return {
          text: [
            "**Claim Your Agent**",
            "",
            "Copy and paste these credentials to claim this agent on the Core platform:",
            "",
            "```",
            `Agent ID: ${globalCoreCredentials.agentId}`,
            `API Key: ${globalCoreCredentials.apiKey}`,
            "```",
            "",
            "Steps:",
            `1. Go to ${config.coreUrl}/login and enter your email`,
            "2. Click the magic link in your email to log in",
            `3. Go to ${config.coreUrl}/claim-agent`,
            "4. Paste the Agent ID and API Key above",
            "",
            "After claiming, all your agents share the same quota.",
          ].join("\n"),
        };
      },
    });

    api.registerCommand({
      name: "og_sanitize",
      description: "Enable/disable AI Security Gateway for data sanitization",
      requireAuth: true,
      acceptsArgs: true,
      handler: async (ctx) => {
        const command = ctx.args?.trim().toLowerCase();

        if (command === "on") {
          // Enable gateway (only modifies agent configs, gateway is always running)
          try {
            const result = await enableGateway();
            return {
              text: [
                "**AI Security Gateway Enabled**",
                "",
                "All LLM requests will now be sanitized before being sent to providers.",
                "Sensitive data (API keys, PII, credentials) will be automatically detected and replaced with placeholders.",
                "",
                `- Gateway URL: http://127.0.0.1:53669`,
                `- Providers protected: ${result.providers.join(", ")}`,
                "",
                result.warnings.length > 0 ? "**Warnings:**" : "",
                ...result.warnings.map(w => `  ${w}`),
                result.warnings.length > 0 ? "" : "",
                "**IMPORTANT:** Do not add/modify providers in openclaw.json while Gateway is enabled.",
                "To add/modify providers:",
                "  1. Run `/og_sanitize off`",
                "  2. Modify openclaw.json",
                "  3. Run `/og_sanitize on`",
                "",
                "Configuration modified: ~/.openclaw/openclaw.json",
                "To disable, run: `/og_sanitize off`",
              ].filter(Boolean).join("\n"),
            };
          } catch (err) {
            return {
              text: [
                "**Failed to Enable Gateway**",
                "",
                `Error: ${err instanceof Error ? err.message : String(err)}`,
                "",
                "The AI Security Gateway is bundled with MoltGuard.",
                "If you see this error, please report it as a bug.",
              ].join("\n"),
            };
          }
        } else if (command === "off") {
          // Disable gateway (only restores agent configs, gateway keeps running)
          try {
            const status = getGatewayStatus();
            if (!status.enabled) {
              return {
                text: "AI Security Gateway is not currently enabled.",
              };
            }

            const result = disableGateway();
            return {
              text: [
                "**AI Security Gateway Disabled**",
                "",
                "LLM requests will now go directly to providers (no sanitization).",
                "",
                `- Providers restored: ${result.providers.join(", ")}`,
                "",
                result.warnings.length > 0 ? "**Warnings:**" : "",
                ...result.warnings.map(w => `  ${w}`),
                result.warnings.length > 0 ? "" : "",
                "Configuration restored: ~/.openclaw/openclaw.json",
                "Note: Gateway server continues running in the plugin process.",
              ].filter(Boolean).join("\n"),
            };
          } catch (err) {
            return {
              text: [
                "**Failed to Disable Gateway**",
                "",
                `Error: ${err instanceof Error ? err.message : String(err)}`,
              ].join("\n"),
            };
          }
        } else {
          // Show status
          const status = getGatewayStatus();
          return {
            text: [
              "**AI Security Gateway Status**",
              "",
              `- Enabled: ${status.enabled ? "Yes" : "No"}`,
              `- Running: ${status.running ? "Yes" : "No"}`,
              `- URL: ${status.url}`,
              "",
              status.enabled && status.providers.length > 0
                ? `Protected providers: ${status.providers.join(", ")}`
                : "",
              "",
              "Usage:",
              "  /og_sanitize on  — Enable data sanitization",
              "  /og_sanitize off — Disable data sanitization",
              "",
              "The AI Security Gateway protects sensitive data before sending to LLMs:",
              "- API keys → <SECRET_TOKEN>",
              "- Email addresses → <EMAIL>",
              "- SSH keys → <SSH_PRIVATE_KEY>",
              "- Credit cards → <CREDIT_CARD>",
              "- And more...",
            ].filter(Boolean).join("\n"),
          };
        }
      },
    });

    api.registerCommand({
      name: "og_scan",
      description: "Scan workspace files for security risks (skills, plugins, memories, workspace md files)",
      requireAuth: true,
      acceptsArgs: true,
      handler: async (ctx) => {
        if (!globalCoreCredentials) {
          return {
            text: "MoltGuard not registered yet. It will auto-register on first use.",
          };
        }

        const scanType = ctx.args?.trim().toLowerCase() || "all";

        // Import workspace scanner
        const { scanWorkspaceMdFiles, scanFilesByType, getWorkspaceSummary } = await import("./agent/workspace-scanner.js");

        try {
          let filesToScan: Array<{ path: string; content: string; type: string; sizeBytes: number }> = [];

          if (scanType === "summary" || scanType === "info") {
            // Show summary only
            const summary = await getWorkspaceSummary();
            return {
              text: [
                "**Workspace File Summary**",
                "",
                `Total files: ${summary.totalFiles}`,
                `Total size: ${(summary.totalSizeBytes / 1024).toFixed(1)} KB`,
                "",
                "Files by type:",
                `- Soul: ${summary.byType.soul}`,
                `- Agent: ${summary.byType.agent}`,
                `- Memory: ${summary.byType.memory}`,
                `- Task: ${summary.byType.task}`,
                `- Skill: ${summary.byType.skill}`,
                `- Plugin: ${summary.byType.plugin}`,
                `- Other: ${summary.byType.other}`,
                "",
                "Run `/og_scan all` to scan all files for security risks.",
              ].join("\n"),
            };
          }

          // Determine what to scan
          if (scanType === "all") {
            filesToScan = await scanWorkspaceMdFiles();
          } else if (scanType === "memories" || scanType === "memory") {
            filesToScan = await scanFilesByType(["memory"]);
          } else if (scanType === "skills" || scanType === "skill") {
            filesToScan = await scanFilesByType(["skill"]);
          } else if (scanType === "plugins" || scanType === "plugin") {
            filesToScan = await scanFilesByType(["plugin"]);
          } else if (scanType === "workspace") {
            filesToScan = await scanFilesByType(["soul", "agent", "task", "other"]);
          } else {
            return {
              text: [
                "**Usage: /og_scan [type]**",
                "",
                "Types:",
                "- `all` — Scan all workspace files (default)",
                "- `memories` — Scan memory files only",
                "- `skills` — Scan skill files only",
                "- `plugins` — Scan plugin files only",
                "- `workspace` — Scan workspace md files (soul.md, agent.md, heartbeat.md, etc.)",
                "- `summary` — Show file count summary without scanning",
                "",
                "Examples:",
                "  /og_scan all",
                "  /og_scan memories",
                "  /og_scan workspace",
              ].join("\n"),
            };
          }

          if (filesToScan.length === 0) {
            return {
              text: [
                "**No Files Found**",
                "",
                `No ${scanType === "all" ? "workspace" : scanType} files found to scan.`,
              ].join("\n"),
            };
          }

          // Ensure dashboard client is initialized for reporting
          if (!globalDashboardClient) {
            try {
              const fs = await import("node:fs");
              const path = await import("node:path");
              const os = await import("node:os");
              const tokenFile = path.join(os.homedir(), ".openclaw", "credentials", "moltguard", "dashboard-session-token");
              if (fs.existsSync(tokenFile)) {
                const tokenData = loadJsonSync<{ token?: string; port?: number }>(tokenFile);
                if (tokenData.token) {
                  const port = tokenData.port || 53667;
                  initDashboardClient(tokenData.token, `http://localhost:${port}`);
                  log.info("Dashboard client initialized from session token");
                }
              }
            } catch (err) {
              log.warn(`Could not initialize dashboard client: ${err}`);
            }
          }

          // Split files into batches of 50 (Core API limit)
          const BATCH_SIZE = 50;
          const batches: typeof filesToScan[] = [];
          for (let i = 0; i < filesToScan.length; i += BATCH_SIZE) {
            batches.push(filesToScan.slice(i, i + BATCH_SIZE));
          }

          // Scan each batch
          const allResults: any[] = [];
          let totalFilesScanned = 0;
          let totalRiskFiles = 0;

          for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
            const batch = batches[batchIdx];

            // Call Core API for static scanning
            const res = await fetch(`${config.coreUrl}/api/v1/static/scan`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${globalCoreCredentials.apiKey}`,
              },
              body: JSON.stringify({
                agentId: globalCoreCredentials.agentId,
                files: batch,
                meta: {
                  pluginVersion: PLUGIN_VERSION,
                  clientTimestamp: new Date().toISOString(),
                  batch: `${batchIdx + 1}/${batches.length}`,
                },
              }),
            });

            if (!res.ok) {
              const error = await res.text();
              return {
                text: [
                  "**Static Scan Failed**",
                  "",
                  `Error in batch ${batchIdx + 1}/${batches.length}: ${error}`,
                ].join("\n"),
              };
            }

            const data = await res.json() as any;

            if (!data.success) {
              if (data.data?.quotaExceeded) {
                return {
                  text: [
                    "**Quota Exceeded**",
                    "",
                    data.data.message || "Your detection quota has been exceeded.",
                    "",
                    `Quota: ${data.data.quotaUsed}/${data.data.quotaTotal}`,
                    "",
                    `Scanned ${totalFilesScanned} files before quota limit.`,
                    "",
                    `To continue scanning, upgrade your plan at: ${config.coreUrl}/login`,
                  ].join("\n"),
                };
              }
              return {
                text: [
                  "**Static Scan Failed**",
                  "",
                  `Error in batch ${batchIdx + 1}/${batches.length}: ${data.error || "Unknown error"}`,
                ].join("\n"),
              };
            }

            const batchResult = data.data as any;
            allResults.push(...batchResult.results);
            totalFilesScanned += batchResult.filesScanned;
            totalRiskFiles += batchResult.riskFiles;

            // Report batch results to dashboard immediately (non-blocking)
            if (globalDashboardClient && batchResult.results) {
              for (const fileResult of batchResult.results) {
                if (fileResult.riskLevel !== "safe") {
                  globalDashboardClient
                    .reportDetection({
                      agentId: globalCoreCredentials.agentId,
                      safe: fileResult.riskLevel === "safe",
                      categories: fileResult.findings.map((f: any) => f.scanner),
                      findings: fileResult.findings,
                      sensitivityScore: fileResult.riskLevel === "critical" ? 1.0 :
                                        fileResult.riskLevel === "high" ? 0.8 :
                                        fileResult.riskLevel === "medium" ? 0.6 :
                                        fileResult.riskLevel === "low" ? 0.4 : 0.0,
                      latencyMs: 0,
                      scanType: "static",
                      filePath: fileResult.path,
                      fileType: batch.find((f: any) => f.path === fileResult.path)?.type as any,
                    })
                    .catch((err) => {
                      log.warn(`Failed to report detection to dashboard: ${err}`);
                    });
                }
              }
            } else if (!globalDashboardClient) {
              log.warn("Dashboard client not initialized - scan results not reported to dashboard");
            }

            // Report static scan results to business reporter
            if (globalBusinessReporter && batchResult.results) {
              for (const fileResult of batchResult.results) {
                const categories = fileResult.findings?.map((f: any) => f.scanner) ?? [];
                globalBusinessReporter.recordScanResult(
                  "static",
                  categories,
                  fileResult.riskLevel !== "safe",
                );
              }
            }
          }

          // Combine results from all batches
          const result = {
            filesScanned: totalFilesScanned,
            riskFiles: totalRiskFiles,
            results: allResults,
          };

          // Format results
          const criticalFiles = result.results.filter((r: any) => r.riskLevel === "critical");
          const highFiles = result.results.filter((r: any) => r.riskLevel === "high");
          const mediumFiles = result.results.filter((r: any) => r.riskLevel === "medium");
          const lowFiles = result.results.filter((r: any) => r.riskLevel === "low");
          const safeFiles = result.results.filter((r: any) => r.riskLevel === "safe");

          const lines = [
            "**Static Security Scan Results**",
            "",
            `Files scanned: ${result.filesScanned}`,
            `Files with risks: ${result.riskFiles}`,
            "",
            "Risk breakdown:",
            `- Critical: ${criticalFiles.length}`,
            `- High: ${highFiles.length}`,
            `- Medium: ${mediumFiles.length}`,
            `- Low: ${lowFiles.length}`,
            `- Safe: ${safeFiles.length}`,
          ];

          // Show critical and high risk files with details
          if (criticalFiles.length > 0) {
            lines.push("", "**Critical Risks:**");
            for (const file of criticalFiles.slice(0, 5)) {
              lines.push(`\n- **${file.path}**`);
              for (const finding of file.findings.slice(0, 3)) {
                lines.push(`  - [${finding.scanner}] ${finding.message}`);
              }
            }
            if (criticalFiles.length > 5) {
              lines.push(`\n...and ${criticalFiles.length - 5} more critical files`);
            }
          }

          if (highFiles.length > 0) {
            lines.push("", "**High Risks:**");
            for (const file of highFiles.slice(0, 3)) {
              lines.push(`\n- **${file.path}**`);
              for (const finding of file.findings.slice(0, 2)) {
                lines.push(`  - [${finding.scanner}] ${finding.message}`);
              }
            }
            if (highFiles.length > 3) {
              lines.push(`\n...and ${highFiles.length - 3} more high-risk files`);
            }
          }

          // Show summary for medium/low
          if (mediumFiles.length > 0) {
            lines.push("", `**Medium Risks:** ${mediumFiles.map((f: any) => f.path).slice(0, 5).join(", ")}`);
            if (mediumFiles.length > 5) {
              lines.push(`...and ${mediumFiles.length - 5} more`);
            }
          }

          if (lowFiles.length > 0) {
            lines.push("", `**Low Risks:** ${lowFiles.length} files (view in dashboard for details)`);
          }

          lines.push("", `Full details available in dashboard: /og_dashboard`);

          return { text: lines.join("\n") };
        } catch (err) {
          return {
            text: [
              "**Static Scan Error**",
              "",
              `Error: ${err instanceof Error ? err.message : String(err)}`,
            ].join("\n"),
          };
        }
      },
    });

    api.registerCommand({
      name: "og_autoscan",
      description: "Enable/disable automatic file scanning on workspace changes",
      requireAuth: true,
      acceptsArgs: true,
      handler: async (ctx) => {
        const command = ctx.args?.trim().toLowerCase();

        if (command === "on") {
          if (autoScanEnabled && globalFileWatcher?.running) {
            return {
              text: "Auto-scan is already enabled.",
            };
          }

          if (!globalCoreCredentials) {
            return {
              text: "Cannot enable auto-scan: MoltGuard not registered yet.",
            };
          }

          // Create file watcher
          globalFileWatcher = new FileWatcher({
            onFilesChanged: async (changedFiles) => {
              if (!globalCoreCredentials) return;

              // Import workspace scanner
              const { scanWorkspaceMdFiles } = await import("./agent/workspace-scanner.js");

              // Get file details for changed files
              const allFiles = await scanWorkspaceMdFiles();
              const filesToScan = allFiles.filter(f =>
                changedFiles.some(cf => cf.endsWith(f.path))
              );

              if (filesToScan.length === 0) return;

              log.debug?.(`Auto-scanning ${filesToScan.length} changed file(s)...`);

              // Call Core API for scanning
              try {
                const res = await fetch(`${config.coreUrl}/api/v1/static/scan`, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${globalCoreCredentials.apiKey}`,
                  },
                  body: JSON.stringify({
                    agentId: globalCoreCredentials.agentId,
                    files: filesToScan,
                    meta: {
                      pluginVersion: PLUGIN_VERSION,
                      clientTimestamp: new Date().toISOString(),
                    },
                  }),
                });

                if (!res.ok) return;

                const data = await res.json() as any;
                if (!data.success || !data.data) return;

                const result = data.data as any;

                // Report to dashboard
                if (globalDashboardClient && result.results) {
                  for (const fileResult of result.results) {
                    if (fileResult.riskLevel !== "safe") {
                      globalDashboardClient
                        .reportDetection({
                          agentId: globalCoreCredentials.agentId,
                          safe: fileResult.riskLevel === "safe",
                          categories: fileResult.findings.map((f: any) => f.scanner),
                          findings: fileResult.findings,
                          sensitivityScore: fileResult.riskLevel === "critical" ? 1.0 :
                                            fileResult.riskLevel === "high" ? 0.8 :
                                            fileResult.riskLevel === "medium" ? 0.6 :
                                            fileResult.riskLevel === "low" ? 0.4 : 0.0,
                          latencyMs: 0,
                          scanType: "static",
                          filePath: fileResult.path,
                          fileType: filesToScan.find((f: any) => f.path === fileResult.path)?.type,
                        })
                        .catch(() => {});
                    }
                  }

                  // Log summary
                  const riskCount = result.results.filter((r: any) => r.riskLevel !== "safe").length;
                  if (riskCount > 0) {
                    log.info(`Auto-scan found ${riskCount} file(s) with security risks`);
                  }
                }

                // Report auto-scan results to business reporter
                if (globalBusinessReporter && result.results) {
                  for (const fileResult of result.results) {
                    const categories = fileResult.findings?.map((f: any) => f.scanner) ?? [];
                    globalBusinessReporter.recordScanResult(
                      "static",
                      categories,
                      fileResult.riskLevel !== "safe",
                    );
                  }
                }
              } catch (err) {
                log.debug?.(`Auto-scan failed: ${err}`);
              }
            },
            logger: log,
          });

          globalFileWatcher.start();
          autoScanEnabled = true;

          return {
            text: [
              "**Auto-Scan Enabled**",
              "",
              "Workspace files are now being monitored for changes.",
              "When a .md file is modified, it will be automatically scanned for security risks.",
              "",
              `Watching ${globalFileWatcher.watchCount} directories`,
              "",
              "View scan results in Dashboard: `/og_dashboard`",
              "",
              "To disable: `/og_autoscan off`",
            ].join("\n"),
          };
        } else if (command === "off") {
          if (!autoScanEnabled || !globalFileWatcher?.running) {
            return {
              text: "Auto-scan is not currently enabled.",
            };
          }

          globalFileWatcher.stop();
          autoScanEnabled = false;

          return {
            text: [
              "**Auto-Scan Disabled**",
              "",
              "File monitoring stopped. Changes will not trigger automatic scans.",
              "",
              "To re-enable: `/og_autoscan on`",
            ].join("\n"),
          };
        } else {
          // Show status
          return {
            text: [
              "**Auto-Scan Status**",
              "",
              `Enabled: ${autoScanEnabled ? "Yes" : "No"}`,
              globalFileWatcher?.running ? `Watching: ${globalFileWatcher.watchCount} directories` : "",
              "",
              "Usage:",
              "  /og_autoscan on  — Enable automatic scanning",
              "  /og_autoscan off — Disable automatic scanning",
              "",
              "Auto-scan monitors workspace .md files and automatically scans them",
              "when changes are detected. Results are reported to the dashboard.",
            ].filter(Boolean).join("\n"),
          };
        }
      },
    });

    api.registerCommand({
      name: "og_reset",
      description: "Reset MoltGuard and re-register with Core (gets new API key)",
      requireAuth: true,
      handler: async () => {
        const hadCredentials = globalCoreCredentials !== null;
        const oldAgentId = globalCoreCredentials?.agentId;

        // Delete credentials file
        const deleted = deleteCoreCredentials();

        // Clear in-memory credentials
        globalCoreCredentials = null;
        globalBehaviorDetector = null;

        if (!deleted && !hadCredentials) {
          return {
            text: [
              "**MoltGuard Reset**",
              "",
              "No credentials to reset. MoltGuard will auto-register on next use.",
            ].join("\n"),
          };
        }

        // Re-register immediately
        try {
          const result = await registerWithCore(
            config.agentName,
            "OpenClaw AI Agent secured by OpenGuardrails",
            config.coreUrl,
          );
          globalCoreCredentials = result.credentials;
          globalBehaviorDetector = new BehaviorDetector(
            {
              coreUrl: config.coreUrl,
              assessTimeoutMs: Math.min(config.timeoutMs, 3000),
              blockOnRisk: config.blockOnRisk,
              pluginVersion: PLUGIN_VERSION,
            },
            log,
          );
          globalBehaviorDetector.setCredentials(result.credentials);

          return {
            text: [
              "**MoltGuard Reset Complete**",
              "",
              oldAgentId ? `- Old Agent ID: ${oldAgentId}` : "",
              `- New Agent ID: ${result.credentials.agentId}`,
              `- New API Key: ${maskApiKey(result.credentials.apiKey)}`,
              "",
              "You now have a fresh agent with a new API key.",
              "Run `/og_status` to check your quota.",
            ].filter(Boolean).join("\n"),
          };
        } catch (err) {
          return {
            text: [
              "**MoltGuard Reset**",
              "",
              "Credentials cleared. Auto-registration failed:",
              `${err}`,
              "",
              "MoltGuard will try to register again on next use.",
            ].join("\n"),
          };
        }
      },
    });
  },

  async unregister() {
    if (dashboardHeartbeatTimer) {
      clearInterval(dashboardHeartbeatTimer);
      dashboardHeartbeatTimer = null;
    }
    if (profileDebounceTimer) {
      clearTimeout(profileDebounceTimer);
      profileDebounceTimer = null;
    }
    for (const w of profileWatchers) {
      try { w.close(); } catch { /* ignore */ }
    }
    profileWatchers = [];

    // Stop file watcher
    if (globalFileWatcher) {
      globalFileWatcher.stop();
      globalFileWatcher = null;
    }

    // Stop event reporter (flush remaining events)
    if (globalEventReporter) {
      await globalEventReporter.stop();
      globalEventReporter = null;
    }

    // Stop business reporter (flush remaining telemetry)
    if (globalBusinessReporter) {
      await globalBusinessReporter.stop();
      globalBusinessReporter = null;
    }

    // Stop config sync
    if (globalConfigSync) {
      globalConfigSync.stop();
      globalConfigSync = null;
    }

    // Stop dashboard client (flush agentic hours)
    if (globalDashboardClient) {
      await globalDashboardClient.stop();
    }

    // Stop gateway server
    try {
      await stopGateway();
    } catch { /* ignore */ }

    // Stop personal dashboard process
    if (personalDashboardStarted) {
      try {
        const { stopLocalDashboard } = await import("./dashboard-launcher.js");
        await stopLocalDashboard();
      } catch { /* ignore */ }
      personalDashboardStarted = false;
    }

    globalCoreCredentials = null;
    globalBehaviorDetector = null;
    globalDashboardClient = null;
    quotaExceededNotified = false;
    currentAccountPlan = "free";
  },
};

// Export with definePluginEntry wrapper if available (new SDK), otherwise direct export (old SDK)
export default definePluginEntry ? definePluginEntry(openClawGuardPlugin) : openClawGuardPlugin;
