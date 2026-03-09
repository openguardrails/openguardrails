/**
 * BusinessReporter - Reports telemetry data to Core's Business Dashboard.
 *
 * Only active when the agent's account is on the "business" plan.
 * Accumulates events and agentic hours locally, then flushes to Core
 * every 60 seconds via POST /api/v1/business/telemetry.
 */

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { networkInterfaces } from "node:os";
import type { CoreCredentials } from "./config.js";
import type { Logger } from "./types.js";
import { openclawHome } from "./env.js";

function debugLog(msg: string): void {
  try {
    const logPath = path.join(openclawHome, "logs", "moltguard-debug.log");
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] [BusinessReporter] ${msg}\n`);
  } catch { /* ignore */ }
}

// =============================================================================
// Constants
// =============================================================================

/** Flush interval in ms (60 seconds) */
const FLUSH_INTERVAL_MS = 60_000;

/** Maximum events to buffer before forced flush */
const MAX_BUFFERED_EVENTS = 500;

/** Timeout for Core API calls */
const API_TIMEOUT_MS = 5_000;

// =============================================================================
// Types
// =============================================================================

export type BusinessEvent = {
  type: string; // tool_call | detection | block | session_start | session_end
  toolName?: string;
  category?: string;
  riskLevel?: string;
  blocked?: boolean;
  durationMs?: number;
  summary?: string;
  metadata?: Record<string, unknown>;
};

export type AgenticHoursAccum = {
  toolCallDurationMs: number;
  llmDurationMs: number;
  totalDurationMs: number;
  toolCallCount: number;
  llmCallCount: number;
  sessionCount: number;
  blockCount: number;
  riskEventCount: number;
};

export type ScanSummaryAccum = {
  scanType: string; // static | dynamic
  totalScans: number;
  riskyScans: number;
  categoryCounts: Record<string, number>; // {"S01": 3, "S07": 1}
};

export type GatewaySummaryAccum = {
  totalRequests: number;
  totalRedactions: number;
  typeCounts: Record<string, number>; // {"email": 5, "api_key": 12}
};

export type SecretSummaryAccum = {
  totalDetections: number;
  typeCounts: Record<string, number>; // {"api_key": 5, "ssh_key": 2}
};

export type BusinessReporterConfig = {
  coreUrl: string;
  pluginVersion: string;
};

// =============================================================================
// BusinessReporter Class
// =============================================================================

export class BusinessReporter {
  private enabled = false;
  private config: BusinessReporterConfig;
  private log: Logger;
  private credentials: CoreCredentials | null = null;
  private ownerName = "";
  private machineName: string;
  private machineId: string;
  private agentName = "";
  private provider = "";
  private model = "";

  /** Buffered events waiting to be flushed */
  private pendingEvents: BusinessEvent[] = [];

  /** Accumulated agentic hours since last flush */
  private hoursAccum: AgenticHoursAccum = this.emptyAccum();

  /** Accumulated scan summaries since last flush */
  private scanAccum: ScanSummaryAccum[] = [];

  /** Accumulated gateway activity since last flush */
  private gatewayAccum: GatewaySummaryAccum = this.emptyGatewayAccum();

  /** Accumulated secret detections since last flush */
  private secretAccum: SecretSummaryAccum = this.emptySecretAccum();

  /** Periodic flush timer */
  private flushInterval: NodeJS.Timeout | null = null;

  /** Whether we're currently flushing */
  private flushing = false;

  constructor(config: BusinessReporterConfig, log: Logger) {
    this.config = config;
    this.log = log;
    this.machineName = os.hostname();
    this.machineId = generateMachineId();
  }

  // ─── Lifecycle ───────────────────────────────────────────────────

  /**
   * Initialize the reporter. Only enables if the account plan is "business".
   * Call this after fetching the account info from Core.
   */
  initialize(plan: string): void {
    if (plan !== "business") {
      this.log.debug?.(`BusinessReporter: plan is "${plan}", not enabling`);
      return;
    }

    this.enabled = true;
    this.startPeriodicFlush();
    this.log.info(`BusinessReporter: enabled for business plan (machine: ${this.machineName})`);
  }

  /** Set Core credentials */
  setCredentials(credentials: CoreCredentials | null): void {
    this.credentials = credentials;
  }

  /** Update agent profile info (called when profile changes) */
  setProfile(profile: {
    ownerName?: string;
    agentName?: string;
    provider?: string;
    model?: string;
  }): void {
    if (profile.ownerName !== undefined) this.ownerName = profile.ownerName;
    if (profile.agentName !== undefined) this.agentName = profile.agentName;
    if (profile.provider !== undefined) this.provider = profile.provider;
    if (profile.model !== undefined) this.model = profile.model;
  }

  /** Whether the reporter is active */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** Stop the reporter and flush remaining data */
  async stop(): Promise<void> {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    if (this.enabled) {
      await this.flush();
    }
    this.enabled = false;
  }

  // ─── Event Recording ─────────────────────────────────────────────

  /** Record a tool call */
  recordToolCall(toolName: string, category: string, durationMs: number, blocked: boolean): void {
    if (!this.enabled) return;

    this.pendingEvents.push({
      type: blocked ? "block" : "tool_call",
      toolName,
      category,
      durationMs,
      blocked,
    });

    this.hoursAccum.toolCallDurationMs += durationMs;
    this.hoursAccum.toolCallCount += 1;
    this.hoursAccum.totalDurationMs += durationMs;
    if (blocked) this.hoursAccum.blockCount += 1;

    this.maybeFlush();
  }

  /** Record an LLM call */
  recordLlmCall(durationMs: number, model?: string): void {
    if (!this.enabled) return;

    if (model) this.model = model;

    this.hoursAccum.llmDurationMs += durationMs;
    this.hoursAccum.llmCallCount += 1;
    this.hoursAccum.totalDurationMs += durationMs;
  }

  /** Record a detection event */
  recordDetection(riskLevel: string, blocked: boolean, summary?: string): void {
    if (!this.enabled) return;

    this.pendingEvents.push({
      type: "detection",
      riskLevel,
      blocked,
      summary,
    });

    if (riskLevel !== "no_risk" && riskLevel !== "low") {
      this.hoursAccum.riskEventCount += 1;
    }
    if (blocked) this.hoursAccum.blockCount += 1;

    this.maybeFlush();
  }

  /** Record a session start/end */
  recordSession(type: "start" | "end", durationMs?: number): void {
    if (!this.enabled) return;

    this.pendingEvents.push({
      type: type === "start" ? "session_start" : "session_end",
      durationMs,
    });

    if (type === "start") {
      this.hoursAccum.sessionCount += 1;
    }
    if (durationMs) {
      this.hoursAccum.totalDurationMs += durationMs;
    }
  }

  /** Record a scan result (static or dynamic) */
  recordScanResult(scanType: "static" | "dynamic", categories: string[], risky: boolean): void {
    if (!this.enabled) return;

    // Find or create accum for this scan type
    let accum = this.scanAccum.find((s) => s.scanType === scanType);
    if (!accum) {
      accum = { scanType, totalScans: 0, riskyScans: 0, categoryCounts: {} };
      this.scanAccum.push(accum);
    }
    accum.totalScans += 1;
    if (risky) accum.riskyScans += 1;
    for (const cat of categories) {
      accum.categoryCounts[cat] = (accum.categoryCounts[cat] ?? 0) + 1;
    }
  }

  /** Record gateway sanitization activity */
  recordGatewayActivity(redactionCount: number, typeCounts: Record<string, number>): void {
    if (!this.enabled) return;

    this.gatewayAccum.totalRequests += 1;
    this.gatewayAccum.totalRedactions += redactionCount;
    for (const [k, v] of Object.entries(typeCounts)) {
      this.gatewayAccum.typeCounts[k] = (this.gatewayAccum.typeCounts[k] ?? 0) + v;
    }
  }

  /** Record secret detection */
  recordSecretDetection(typeCounts: Record<string, number>): void {
    if (!this.enabled) return;

    const total = Object.values(typeCounts).reduce((a, b) => a + b, 0);
    this.secretAccum.totalDetections += total;
    for (const [k, v] of Object.entries(typeCounts)) {
      this.secretAccum.typeCounts[k] = (this.secretAccum.typeCounts[k] ?? 0) + v;
    }
  }

  // ─── Flush ─────────────────────────────────────────────────────

  private startPeriodicFlush(): void {
    if (this.flushInterval) return;
    this.flushInterval = setInterval(() => {
      this.flush().catch((err) => {
        this.log.debug?.(`BusinessReporter: flush error: ${err}`);
      });
    }, FLUSH_INTERVAL_MS);
    // Don't prevent process exit
    this.flushInterval.unref();
  }

  private maybeFlush(): void {
    if (this.pendingEvents.length >= MAX_BUFFERED_EVENTS) {
      this.flush().catch((err) => {
        this.log.debug?.(`BusinessReporter: forced flush error: ${err}`);
      });
    }
  }

  async flush(): Promise<void> {
    if (this.flushing || !this.enabled || !this.credentials) return;

    // Check if there's anything to flush
    const hasEvents = this.pendingEvents.length > 0;
    const hasHours = this.hoursAccum.totalDurationMs > 0 ||
      this.hoursAccum.toolCallCount > 0 ||
      this.hoursAccum.llmCallCount > 0 ||
      this.hoursAccum.sessionCount > 0;
    const hasScans = this.scanAccum.length > 0;
    const hasGateway = this.gatewayAccum.totalRequests > 0;
    const hasSecrets = this.secretAccum.totalDetections > 0;

    if (!hasEvents && !hasHours && !hasScans && !hasGateway && !hasSecrets) return;

    this.flushing = true;

    // Take current state
    const events = this.pendingEvents.splice(0);
    const hours = { ...this.hoursAccum };
    this.hoursAccum = this.emptyAccum();
    const scans = this.scanAccum.splice(0);
    const gateway = { ...this.gatewayAccum };
    this.gatewayAccum = this.emptyGatewayAccum();
    const secrets = { ...this.secretAccum };
    this.secretAccum = this.emptySecretAccum();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

    try {
      const body = {
        agentId: this.credentials.agentId,
        ownerName: this.ownerName || undefined,
        machineName: this.machineName,
        machineId: this.machineId,
        agentName: this.agentName || undefined,
        provider: this.provider || undefined,
        model: this.model || undefined,
        events: events.length > 0 ? events : undefined,
        agenticHours: hasHours ? hours : undefined,
        heartbeat: true,
        scanSummary: scans.length > 0 ? scans : undefined,
        gatewaySummary: hasGateway ? gateway : undefined,
        secretSummary: hasSecrets ? secrets : undefined,
      };

      debugLog(`flush: POSTing to ${this.config.coreUrl}/api/v1/business/telemetry events=${events.length} hours=${JSON.stringify(hours)}`);
      const response = await fetch(`${this.config.coreUrl}/api/v1/business/telemetry`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.credentials.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        debugLog(`flush: POST failed with ${response.status}`);
        this.log.debug?.(`BusinessReporter: telemetry request failed with ${response.status}`);
        // Put events back on failure (hours are lost to avoid double-counting)
        this.pendingEvents.unshift(...events);
        if (this.pendingEvents.length > MAX_BUFFERED_EVENTS) {
          this.pendingEvents.length = MAX_BUFFERED_EVENTS; // Trim oldest
        }
      } else {
        debugLog(`flush: POST success`);
        this.log.debug?.(`BusinessReporter: flushed ${events.length} events`);
      }
    } catch (err) {
      debugLog(`flush: POST error: ${err}`);
      if ((err as Error).name !== "AbortError") {
        this.log.debug?.(`BusinessReporter: telemetry error: ${err}`);
      }
      // Put events back on failure
      this.pendingEvents.unshift(...events);
      if (this.pendingEvents.length > MAX_BUFFERED_EVENTS) {
        this.pendingEvents.length = MAX_BUFFERED_EVENTS;
      }
    } finally {
      clearTimeout(timer);
      this.flushing = false;
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────

  private emptyAccum(): AgenticHoursAccum {
    return {
      toolCallDurationMs: 0,
      llmDurationMs: 0,
      totalDurationMs: 0,
      toolCallCount: 0,
      llmCallCount: 0,
      sessionCount: 0,
      blockCount: 0,
      riskEventCount: 0,
    };
  }

  private emptyGatewayAccum(): GatewaySummaryAccum {
    return { totalRequests: 0, totalRedactions: 0, typeCounts: {} };
  }

  private emptySecretAccum(): SecretSummaryAccum {
    return { totalDetections: 0, typeCounts: {} };
  }
}

// =============================================================================
// Machine ID Generation
// =============================================================================

/**
 * Generate a stable machine ID from hostname + first MAC address.
 * This identifies a specific machine across restarts.
 */
function generateMachineId(): string {
  const hostname = os.hostname();
  const interfaces = networkInterfaces();
  let mac = "";

  for (const iface of Object.values(interfaces)) {
    if (!iface) continue;
    for (const info of iface) {
      if (!info.internal && info.mac && info.mac !== "00:00:00:00:00:00") {
        mac = info.mac;
        break;
      }
    }
    if (mac) break;
  }

  const input = `${hostname}:${mac || "unknown"}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}
