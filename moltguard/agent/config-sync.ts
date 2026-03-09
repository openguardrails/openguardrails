/**
 * ConfigSync - Periodically pulls team-level configuration from Core.
 *
 * Only active when the agent's account is on the "business" plan.
 * Pulls policies and gateway config every 5 minutes from
 * GET /api/v1/business/config and applies them locally.
 */

import type { CoreCredentials } from "./config.js";
import type { Logger } from "./types.js";

// =============================================================================
// Constants
// =============================================================================

/** Poll interval in ms (5 minutes) */
const POLL_INTERVAL_MS = 5 * 60_000;

/** Timeout for Core API calls */
const API_TIMEOUT_MS = 5_000;

// =============================================================================
// Types
// =============================================================================

export type TeamPolicy = {
  id: string;
  name: string;
  description: string | null;
  scannerIds: string | null; // JSON string
  action: string; // block | alert | log
  sensitivityThreshold: number;
  targetAgentIds: string | null; // JSON string
  targetOwners: string | null; // JSON string
  isEnabled: number;
};

export type TeamGatewayConfig = {
  sanitizeEmail: number;
  sanitizeApiKeys: number;
  sanitizePii: number;
  sanitizeSshKeys: number;
  sanitizeEnvVars: number;
  sanitizeConfidential: number;
  customPatterns: string | null; // JSON string
  targetAgentIds: string | null; // JSON string
  targetOwners: string | null; // JSON string
};

export type BusinessConfig = {
  policies: TeamPolicy[];
  gatewayConfig: TeamGatewayConfig | null;
};

/** Callback for when config changes */
export type OnConfigUpdate = (config: BusinessConfig) => void;

export type ConfigSyncOptions = {
  coreUrl: string;
  /** Callback invoked when remote config changes */
  onUpdate?: OnConfigUpdate;
};

// =============================================================================
// ConfigSync Class
// =============================================================================

export class ConfigSync {
  private enabled = false;
  private options: ConfigSyncOptions;
  private log: Logger;
  private credentials: CoreCredentials | null = null;
  private pollInterval: NodeJS.Timeout | null = null;

  /** Last fetched config (for change detection) */
  private lastConfigHash = "";

  /** Last successfully fetched config */
  private currentConfig: BusinessConfig | null = null;

  constructor(options: ConfigSyncOptions, log: Logger) {
    this.options = options;
    this.log = log;
  }

  // ─── Lifecycle ───────────────────────────────────────────────────

  /**
   * Initialize config sync. Only enables if plan is "business".
   */
  async initialize(plan: string): Promise<void> {
    if (plan !== "business") {
      this.log.debug?.(`ConfigSync: plan is "${plan}", not enabling`);
      return;
    }

    this.enabled = true;

    // Pull immediately on startup
    await this.pull();

    // Start periodic polling
    this.startPolling();
    this.log.info("ConfigSync: enabled, polling every 5 minutes");
  }

  /** Set Core credentials */
  setCredentials(credentials: CoreCredentials | null): void {
    this.credentials = credentials;
  }

  /** Get current config (may be null if not yet fetched) */
  getConfig(): BusinessConfig | null {
    return this.currentConfig;
  }

  /** Whether sync is active */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** Stop polling */
  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.enabled = false;
  }

  // ─── Polling ───────────────────────────────────────────────────

  private startPolling(): void {
    if (this.pollInterval) return;
    this.pollInterval = setInterval(() => {
      this.pull().catch((err) => {
        this.log.debug?.(`ConfigSync: poll error: ${err}`);
      });
    }, POLL_INTERVAL_MS);
    this.pollInterval.unref();
  }

  /** Pull config from Core */
  async pull(): Promise<BusinessConfig | null> {
    if (!this.enabled || !this.credentials) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

    try {
      const response = await fetch(`${this.options.coreUrl}/api/v1/business/config`, {
        headers: {
          Authorization: `Bearer ${this.credentials.apiKey}`,
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        this.log.debug?.(`ConfigSync: pull failed with ${response.status}`);
        return null;
      }

      const json = (await response.json()) as {
        success: boolean;
        data?: BusinessConfig;
      };

      if (!json.success || !json.data) {
        return null;
      }

      const config = json.data;

      // Check if config changed (simple JSON hash)
      const hash = JSON.stringify(config);
      if (hash !== this.lastConfigHash) {
        this.lastConfigHash = hash;
        this.currentConfig = config;

        // Notify callback
        if (this.options.onUpdate) {
          try {
            this.options.onUpdate(config);
          } catch (err) {
            this.log.error(`ConfigSync: onUpdate callback error: ${err}`);
          }
        }

        this.log.debug?.(`ConfigSync: config updated (${config.policies.length} policies)`);
      }

      return config;
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        this.log.debug?.(`ConfigSync: pull error: ${err}`);
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
