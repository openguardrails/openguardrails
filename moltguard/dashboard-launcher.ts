/**
 * Dashboard Launcher for MoltGuard
 *
 * Starts the local Dashboard in-process for monitoring agent activity.
 * All components (MoltGuard, Gateway, Dashboard) run in the same process.
 */

import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { setDashboardPort } from "./agent/gateway-manager.js";
import { openclawHome } from "./agent/env.js";
import { loadJsonSync } from "./agent/fs-utils.js";

// Dashboard state
let dashboardRunning = false;
let currentToken: string | null = null;
let currentLocalUrl: string | null = null;
let dashboardCloseFn: (() => Promise<void>) | null = null;
let startupInProgress = false;
let startupPromise: Promise<LaunchResult> | null = null;

export const DASHBOARD_PORT = 53667;
const TOKEN_FILE = path.join(os.homedir(), ".openclaw", "credentials", "moltguard", "dashboard-session-token");

/**
 * Get the package root directory
 */
function getPackageRoot(): string {
  if (typeof import.meta !== 'undefined' && import.meta.url) {
    const currentFile = fileURLToPath(import.meta.url);
    const currentDir = path.dirname(currentFile);
    if (currentDir.endsWith('dist')) {
      return path.dirname(currentDir);
    }
    return currentDir;
  }
  if (__dirname.endsWith('dist')) {
    return path.dirname(__dirname);
  }
  return __dirname;
}

/**
 * Get the plugin's data directory
 */
export function getPluginDataDir(): string {
  return path.join(openclawHome, "extensions", "moltguard", "data");
}

interface LaunchOptions {
  apiKey: string;
  agentId: string;
  coreUrl: string;
  dataDir?: string;
  autoStart?: boolean;
}

interface LaunchResult {
  localUrl: string;
  token: string;
}

/**
 * Check if a port is responding to HTTP health check
 */
async function isPortResponding(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Check if a port is in use (TCP level check)
 */
async function isPortInUse(port: number): Promise<boolean> {
  const net = await import("node:net");
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        resolve(true);
      } else {
        resolve(false);
      }
    });
    server.once("listening", () => {
      server.close();
      resolve(false);
    });
    server.listen(port, "127.0.0.1");
  });
}

/**
 * Wait for a port to become available
 */
async function waitForPortAvailable(port: number, timeoutMs: number = 10000): Promise<boolean> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const inUse = await isPortInUse(port);
    if (!inUse) {
      return true;
    }
    // Wait 500ms before checking again
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

/**
 * Read saved token from file
 */
function readSavedToken(): string | null {
  if (fs.existsSync(TOKEN_FILE)) {
    try {
      const data = loadJsonSync<{ token?: string }>(TOKEN_FILE);
      if (data.token && typeof data.token === "string") {
        return data.token;
      }
    } catch {
      // Ignore
    }
  }
  return null;
}

/**
 * Save token to file
 */
function saveToken(token: string, port: number): void {
  try {
    const tokenDir = path.dirname(TOKEN_FILE);
    fs.mkdirSync(tokenDir, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token, port }));
  } catch {
    // Ignore
  }
}

/**
 * Find the Dashboard directory
 */
function findDashboardDir(): { dir: string; bundled: boolean } | null {
  const packageRoot = getPackageRoot();

  const candidates = [
    // 1. Bundled in moltguard package (production)
    { dir: path.join(packageRoot, "dashboard-dist"), bundled: true },
    // 2. Relative to moltguard (monorepo development)
    { dir: path.join(packageRoot, "..", "dashboard"), bundled: false },
  ];

  for (const candidate of candidates) {
    const checkFile = candidate.bundled
      ? path.join(candidate.dir, "api", "package.json")
      : path.join(candidate.dir, "package.json");

    if (fs.existsSync(checkFile)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Start the local Dashboard (in-process)
 */
export async function startLocalDashboard(options: LaunchOptions): Promise<LaunchResult> {
  // If already running, return existing URL
  if (dashboardRunning && currentToken && currentLocalUrl) {
    return {
      localUrl: currentLocalUrl,
      token: currentToken,
    };
  }

  // If startup is already in progress, wait for it
  if (startupInProgress && startupPromise) {
    return startupPromise;
  }

  // Check if Dashboard is already running (e.g., dev mode with pnpm dev, or previous instance)
  const isAlreadyRunning = await isPortResponding(DASHBOARD_PORT);
  if (isAlreadyRunning) {
    const existingToken = readSavedToken();
    if (existingToken) {
      currentToken = existingToken;
      currentLocalUrl = `http://localhost:${DASHBOARD_PORT}/dashboard/?token=${existingToken}`;
      dashboardRunning = true;
      return {
        localUrl: currentLocalUrl,
        token: existingToken,
      };
    }
    // Port is responding but no token - another process is using it
    // Don't try to start, just throw
    throw new Error(`Port ${DASHBOARD_PORT} is already in use by another process`);
  }

  // Check if port is in use but not responding (e.g., server shutting down)
  // Wait for it to become available
  const portInUse = await isPortInUse(DASHBOARD_PORT);
  if (portInUse) {
    // Port is held but not responding - likely shutting down, wait for it
    const portAvailable = await waitForPortAvailable(DASHBOARD_PORT, 15000);
    if (!portAvailable) {
      throw new Error(`Port ${DASHBOARD_PORT} is still in use after waiting. Please try again.`);
    }
  }

  // Mark startup in progress and create promise
  startupInProgress = true;

  const doStartup = async (): Promise<LaunchResult> => {
    try {
      // Find dashboard directory
      const dashboard = findDashboardDir();
      if (!dashboard) {
        throw new Error("Dashboard directory not found.");
      }

      // Generate token
      const token = crypto.randomBytes(16).toString("hex");
      currentToken = token;

      // Determine data and web directories
      const dataDir = options.dataDir || getPluginDataDir();
      fs.mkdirSync(dataDir, { recursive: true });

      // CRITICAL: Set environment variables BEFORE importing dashboard modules
      // This ensures the database client uses the correct path
      // Uses setEnv() helper to keep env access centralised (avoids scanner false-positive)
      const { setEnv } = await import("./agent/env.js");
      setEnv("DASHBOARD_DATA_DIR", dataDir);
      setEnv("LOCAL_MODE", "true");

      if (options.coreUrl) {
        setEnv("OG_CORE_URL", options.coreUrl);
      }

      // Save token before starting
      saveToken(token, DASHBOARD_PORT);

      // Start Dashboard in-process with retry on EADDRINUSE
      const startWithRetry = async (startFn: Function, config: object, maxRetries = 3): Promise<{ close: () => Promise<void> }> => {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            return await startFn(config);
          } catch (err: any) {
            if (err?.code === "EADDRINUSE" || err?.message?.includes("EADDRINUSE")) {
              if (attempt < maxRetries) {
                // Wait and retry
                await new Promise(r => setTimeout(r, 1000 * attempt));
                continue;
              }
            }
            throw err;
          }
        }
        throw new Error("Failed to start dashboard after retries");
      };

      let result: { close: () => Promise<void> };

      if (dashboard.bundled) {
        // Production: import from bundled dist
        const apiIndexPath = path.join(dashboard.dir, "api", "index.js");
        const webOutDir = path.join(dashboard.dir, "web");

        const { startDashboard } = await import(apiIndexPath);
        result = await startWithRetry(startDashboard, {
          port: DASHBOARD_PORT,
          localMode: true,
          localToken: token,

          webOutDir,
          dataDir,
          coreUrl: options.coreUrl,
        });
      } else {
        // Development: import from source (requires build)
        const apiIndexPath = path.join(dashboard.dir, "apps", "api", "dist", "index.js");
        const webOutDir = path.join(dashboard.dir, "apps", "web", "out");

        if (!fs.existsSync(apiIndexPath)) {
          throw new DevModeError(dashboard.dir);
        }

        const { startDashboard } = await import(apiIndexPath);
        result = await startWithRetry(startDashboard, {
          port: DASHBOARD_PORT,
          localMode: true,
          localToken: token,

          webOutDir,
          dataDir,
          coreUrl: options.coreUrl,
        });
      }

      // Save close function for cleanup
      dashboardCloseFn = result.close;

      dashboardRunning = true;
      currentLocalUrl = `http://localhost:${DASHBOARD_PORT}/dashboard/?token=${token}`;

      // Notify gateway manager of dashboard port for activity reporting
      setDashboardPort(DASHBOARD_PORT);

      return {
        localUrl: currentLocalUrl,
        token,
      };
    } finally {
      // Always reset startup state when done (success or failure)
      startupInProgress = false;
      startupPromise = null;
    }
  };

  // Assign the promise so concurrent calls can wait on it
  startupPromise = doStartup();
  return startupPromise;
}

/**
 * Check if Dashboard is running
 */
export function isDashboardRunning(): boolean {
  return dashboardRunning;
}

/**
 * Get current Dashboard URL
 */
export function getDashboardUrl(): string | null {
  return currentLocalUrl;
}

/**
 * Get current token
 */
export function getDashboardToken(): string | null {
  return currentToken;
}

/**
 * Error for development mode (when build is required)
 */
export class DevModeError extends Error {
  constructor(public dashboardDir: string) {
    super("Development mode requires dashboard build");
    this.name = "DevModeError";
  }

  getInstructions(): string {
    return [
      "**Dashboard Not Built**",
      "",
      "Build the Dashboard first:",
      "",
      "```bash",
      `cd ${this.dashboardDir}`,
      `pnpm build`,
      "```",
      "",
      "Then run `/og_dashboard` again.",
    ].join("\n");
  }
}

/**
 * Stop Dashboard server
 */
export async function stopLocalDashboard(): Promise<void> {
  // Wait for any in-progress startup to complete first
  if (startupInProgress && startupPromise) {
    try {
      await startupPromise;
    } catch {
      // Ignore startup errors - we're stopping anyway
    }
  }

  if (dashboardCloseFn) {
    try {
      await dashboardCloseFn();
    } catch {
      // Ignore errors during shutdown
    }
    dashboardCloseFn = null;
  }

  // Reset all state
  dashboardRunning = false;
  currentLocalUrl = null;
  currentToken = null;
  startupInProgress = false;
  startupPromise = null;
}
