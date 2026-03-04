/**
 * AI Security Gateway Manager
 *
 * Manages the lifecycle and configuration of the AI Security Gateway:
 * - Starts/stops the gateway process
 * - Configures gateway to use current LLM providers' API keys
 * - Modifies all agents' models.json to route through gateway
 * - Restores original configuration when disabled
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

// =============================================================================
// Constants
// =============================================================================

const OPENCLAW_DIR = path.join(os.homedir(), ".openclaw");
const AGENTS_DIR = path.join(OPENCLAW_DIR, "agents");
const OG_DIR = path.join(os.homedir(), ".openguardrails");
const GATEWAY_CONFIG = path.join(OG_DIR, "gateway.json");
const GATEWAY_BACKUP = path.join(OPENCLAW_DIR, "credentials/moltguard/gateway-backup.json");
const GATEWAY_PID_FILE = path.join(OG_DIR, "gateway.pid");
const DEFAULT_GATEWAY_PORT = 8900;
const GATEWAY_URL = `http://127.0.0.1:${DEFAULT_GATEWAY_PORT}`;

// =============================================================================
// Types
// =============================================================================

type ProviderConfig = {
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  models?: unknown[];
  [key: string]: unknown;
};

type ModelsConfig = {
  providers: Record<string, ProviderConfig>;
};

type BackupEntry = {
  agentName: string;
  modelsFile: string;
  providers: Record<string, { originalBaseUrl: string }>;
};

type GatewayBackup = {
  timestamp: string;
  entries: BackupEntry[];
};

type GatewayStatus = {
  enabled: boolean;
  running: boolean;
  pid?: number;
  port: number;
  url: string;
  providers: string[];
  agents: string[];
};

// =============================================================================
// Gateway Process Management
// =============================================================================

let gatewayProcess: ChildProcess | null = null;

/**
 * Start the gateway process
 */
export async function startGateway(): Promise<void> {
  // Check if already running
  if (isGatewayRunning()) {
    throw new Error("Gateway is already running");
  }

  // Find the gateway executable
  const gatewayPath = findGatewayExecutable();
  if (!gatewayPath) {
    throw new Error("Gateway executable not found. Please install @openguardrails/gateway");
  }

  // Start the gateway process
  gatewayProcess = spawn("node", [gatewayPath], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      GATEWAY_PORT: String(DEFAULT_GATEWAY_PORT),
    },
  });

  gatewayProcess.unref();

  // Save PID
  if (gatewayProcess.pid) {
    fs.mkdirSync(OG_DIR, { recursive: true });
    fs.writeFileSync(GATEWAY_PID_FILE, String(gatewayProcess.pid), "utf-8");
  }

  // Wait a bit to ensure it started
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Verify it's running
  if (!isGatewayRunning()) {
    throw new Error("Gateway failed to start");
  }
}

/**
 * Stop the gateway process
 */
export function stopGateway(): void {
  // Try to kill via PID file
  if (fs.existsSync(GATEWAY_PID_FILE)) {
    try {
      const pid = parseInt(fs.readFileSync(GATEWAY_PID_FILE, "utf-8").trim(), 10);
      process.kill(pid, "SIGTERM");
      fs.unlinkSync(GATEWAY_PID_FILE);
    } catch {
      // PID file exists but process may already be dead
    }
  }

  // Also try to kill via process reference
  if (gatewayProcess) {
    try {
      gatewayProcess.kill("SIGTERM");
    } catch {
      // Ignore errors
    }
    gatewayProcess = null;
  }
}

/**
 * Check if gateway is running
 */
export function isGatewayRunning(): boolean {
  // Check PID file
  if (!fs.existsSync(GATEWAY_PID_FILE)) {
    return false;
  }

  try {
    const pid = parseInt(fs.readFileSync(GATEWAY_PID_FILE, "utf-8").trim(), 10);
    // Check if process exists (signal 0 doesn't kill, just checks)
    process.kill(pid, 0);
    return true;
  } catch {
    // Process doesn't exist, clean up PID file
    try {
      fs.unlinkSync(GATEWAY_PID_FILE);
    } catch {
      // Ignore
    }
    return false;
  }
}

/**
 * Find the gateway executable
 */
function findGatewayExecutable(): string | null {
  // Try local installation first (for development)
  const localPath = path.join(process.cwd(), "../gateway/dist/index.js");
  if (fs.existsSync(localPath)) {
    return localPath;
  }

  // Try moltguard's node_modules
  const pluginPath = path.join(process.cwd(), "node_modules/@openguardrails/gateway/dist/index.js");
  if (fs.existsSync(pluginPath)) {
    return pluginPath;
  }

  // Try global installation
  try {
    const { execSync } = require("node:child_process");
    const globalPath = execSync("which og-gateway", { encoding: "utf-8" }).trim();
    if (globalPath && fs.existsSync(globalPath)) {
      return globalPath;
    }
  } catch {
    // Not found globally
  }

  return null;
}

// =============================================================================
// Configuration Management
// =============================================================================

/**
 * Find all agent directories
 */
function findAgentDirs(): string[] {
  if (!fs.existsSync(AGENTS_DIR)) {
    return [];
  }

  const agents: string[] = [];
  const entries = fs.readdirSync(AGENTS_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const agentDir = path.join(AGENTS_DIR, entry.name);
      const modelsFile = path.join(agentDir, "agent/models.json");
      if (fs.existsSync(modelsFile)) {
        agents.push(entry.name);
      }
    }
  }

  return agents;
}

/**
 * Read models.json for an agent
 */
function readModelsConfig(agentName: string): ModelsConfig | null {
  const modelsFile = path.join(AGENTS_DIR, agentName, "agent/models.json");
  if (!fs.existsSync(modelsFile)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(modelsFile, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Write models.json for an agent
 */
function writeModelsConfig(agentName: string, config: ModelsConfig): void {
  const modelsFile = path.join(AGENTS_DIR, agentName, "agent/models.json");
  fs.writeFileSync(modelsFile, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

/**
 * Collect all providers from all agents
 */
function collectAllProviders(): Record<string, { baseUrl: string; apiKey: string; api?: string }> {
  const allProviders: Record<string, { baseUrl: string; apiKey: string; api?: string }> = {};
  const agentNames = findAgentDirs();

  for (const agentName of agentNames) {
    const config = readModelsConfig(agentName);
    if (!config?.providers) continue;

    for (const [providerName, providerConfig] of Object.entries(config.providers)) {
      if (!providerConfig.baseUrl || !providerConfig.apiKey) continue;

      // Use first occurrence of each provider
      if (!allProviders[providerName]) {
        allProviders[providerName] = {
          baseUrl: providerConfig.baseUrl,
          apiKey: providerConfig.apiKey,
          api: providerConfig.api,
        };
      }
    }
  }

  return allProviders;
}

/**
 * Determine backend type from provider name or API
 */
function getBackendType(providerName: string, api?: string): string {
  if (api === "anthropic" || providerName.includes("anthropic")) {
    return "anthropic";
  }
  if (api === "gemini" || providerName.includes("gemini") || providerName.includes("google")) {
    return "gemini";
  }
  if (providerName.includes("openrouter")) {
    return "openrouter";
  }
  // Default to OpenAI-compatible
  return "openai";
}

/**
 * Configure gateway with all providers
 */
function configureGateway(providers: Record<string, { baseUrl: string; apiKey: string; api?: string }>): void {
  const backends: Record<string, { baseUrl: string; apiKey: string }> = {};

  // Group providers by backend type
  for (const [providerName, providerConfig] of Object.entries(providers)) {
    const backendType = getBackendType(providerName, providerConfig.api);

    // Use first provider of each backend type
    if (!backends[backendType]) {
      backends[backendType] = {
        baseUrl: providerConfig.baseUrl,
        apiKey: providerConfig.apiKey,
      };
    }
  }

  // Create gateway config
  const gatewayConfig = {
    port: DEFAULT_GATEWAY_PORT,
    backends,
  };

  // Write gateway config
  fs.mkdirSync(OG_DIR, { recursive: true });
  fs.writeFileSync(GATEWAY_CONFIG, JSON.stringify(gatewayConfig, null, 2) + "\n", "utf-8");
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Enable AI Security Gateway
 */
export async function enableGateway(): Promise<{ agents: string[]; providers: string[] }> {
  // Check if already enabled
  if (fs.existsSync(GATEWAY_BACKUP)) {
    throw new Error("Gateway is already enabled. Disable it first with '/og_sanitize off'");
  }

  const agentNames = findAgentDirs();
  if (agentNames.length === 0) {
    throw new Error("No agents found");
  }

  // Collect all providers BEFORE modifying configs
  const originalProviders = collectAllProviders();

  // Configure gateway with original providers
  configureGateway(originalProviders);

  // Start gateway if not running
  if (!isGatewayRunning()) {
    await startGateway();
  }

  // Now modify configs and create backup
  const backup: GatewayBackup = {
    timestamp: new Date().toISOString(),
    entries: [],
  };

  const allProviders: string[] = [];

  for (const agentName of agentNames) {
    const config = readModelsConfig(agentName);
    if (!config?.providers) continue;

    const backupEntry: BackupEntry = {
      agentName,
      modelsFile: path.join(AGENTS_DIR, agentName, "agent/models.json"),
      providers: {},
    };

    // Backup and modify each provider
    for (const [providerName, providerConfig] of Object.entries(config.providers)) {
      if (!providerConfig.baseUrl) continue;

      // Save original baseUrl
      backupEntry.providers[providerName] = {
        originalBaseUrl: providerConfig.baseUrl,
      };

      // Update to gateway URL
      providerConfig.baseUrl = GATEWAY_URL;

      if (!allProviders.includes(providerName)) {
        allProviders.push(providerName);
      }
    }

    // Write modified config
    writeModelsConfig(agentName, config);
    backup.entries.push(backupEntry);
  }

  // Save backup
  const backupDir = path.dirname(GATEWAY_BACKUP);
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(GATEWAY_BACKUP, JSON.stringify(backup, null, 2) + "\n", "utf-8");

  return {
    agents: agentNames,
    providers: allProviders,
  };
}

/**
 * Disable AI Security Gateway
 */
export function disableGateway(stopProcess = false): { agents: string[]; providers: string[] } {
  if (!fs.existsSync(GATEWAY_BACKUP)) {
    throw new Error("Gateway not enabled (no backup found)");
  }

  const backup: GatewayBackup = JSON.parse(fs.readFileSync(GATEWAY_BACKUP, "utf-8"));
  const allProviders: string[] = [];

  // Restore original baseUrls
  for (const entry of backup.entries) {
    const config = readModelsConfig(entry.agentName);
    if (!config?.providers) continue;

    for (const [providerName, backupData] of Object.entries(entry.providers)) {
      if (config.providers[providerName]) {
        config.providers[providerName].baseUrl = backupData.originalBaseUrl;
        if (!allProviders.includes(providerName)) {
          allProviders.push(providerName);
        }
      }
    }

    writeModelsConfig(entry.agentName, config);
  }

  // Delete backup
  fs.unlinkSync(GATEWAY_BACKUP);

  // Optionally stop the gateway process
  if (stopProcess && isGatewayRunning()) {
    stopGateway();
  }

  return {
    agents: backup.entries.map(e => e.agentName),
    providers: allProviders,
  };
}

/**
 * Get gateway status
 */
export function getGatewayStatus(): GatewayStatus {
  const enabled = fs.existsSync(GATEWAY_BACKUP);
  const running = isGatewayRunning();

  const status: GatewayStatus = {
    enabled,
    running,
    port: DEFAULT_GATEWAY_PORT,
    url: GATEWAY_URL,
    providers: [],
    agents: [],
  };

  if (enabled && fs.existsSync(GATEWAY_BACKUP)) {
    const backup: GatewayBackup = JSON.parse(fs.readFileSync(GATEWAY_BACKUP, "utf-8"));
    status.agents = backup.entries.map(e => e.agentName);

    const providerSet = new Set<string>();
    for (const entry of backup.entries) {
      for (const providerName of Object.keys(entry.providers)) {
        providerSet.add(providerName);
      }
    }
    status.providers = Array.from(providerSet);
  }

  if (running && fs.existsSync(GATEWAY_PID_FILE)) {
    const pid = parseInt(fs.readFileSync(GATEWAY_PID_FILE, "utf-8").trim(), 10);
    status.pid = pid;
  }

  return status;
}
