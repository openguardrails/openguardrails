/**
 * Dashboard Launcher for MoltGuard
 *
 * Starts the local Dashboard for monitoring agent activity.
 */

import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

// Dashboard process and state
let dashboardProcess: ChildProcess | null = null;
let currentToken: string | null = null;
let currentLocalUrl: string | null = null;

export const DASHBOARD_PORT = 53667;
const WEB_PORT = 53668;
const TOKEN_FILE = path.join(os.homedir(), ".openclaw", "credentials", "moltguard", "dashboard-session-token");

/**
 * Get the package root directory
 * Works for both source (.ts) and compiled (.js) files
 */
function getPackageRoot(): string {
  // Try to get current file path using import.meta.url (ES modules)
  if (typeof import.meta !== 'undefined' && import.meta.url) {
    const currentFile = fileURLToPath(import.meta.url);
    const currentDir = path.dirname(currentFile);
    // If we're in dist/, go up one level
    if (currentDir.endsWith('dist')) {
      return path.dirname(currentDir);
    }
    return currentDir;
  }

  // Fallback to __dirname (CommonJS or TypeScript direct execution)
  // If __dirname ends with 'dist', go up one level
  if (__dirname.endsWith('dist')) {
    return path.dirname(__dirname);
  }
  return __dirname;
}

/**
 * Get the plugin's data directory for storing dashboard database
 * Data stored here is deleted when the plugin is uninstalled
 */
export function getPluginDataDir(): string {
  const openclawHome = process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");
  return path.join(openclawHome, "extensions", "moltguard", "data");
}

interface LaunchOptions {
  apiKey: string;
  agentId: string;
  coreUrl: string;
  dataDir?: string;      // Custom data directory for database
  autoStart?: boolean;   // Auto-start mode (silent failures for dev mode)
}

interface LaunchResult {
  localUrl: string;
  token: string;
}

/**
 * Check if a port is responding (for detecting dev vs embedded mode)
 */
async function isPortResponding(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/`, {
      signal: AbortSignal.timeout(1000),
    });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

/**
 * Check if dashboard is already running and get its token
 */
async function checkRunningDashboard(): Promise<{ running: boolean; token?: string; port?: number }> {
  // First check if dashboard is responding
  try {
    const res = await fetch(`http://localhost:${DASHBOARD_PORT}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      // Dashboard is running, try to read token from file
      if (fs.existsSync(TOKEN_FILE)) {
        try {
          const data = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8"));
          if (data.token) {
            return { running: true, token: data.token, port: data.port || DASHBOARD_PORT };
          }
        } catch {
          // Ignore parse errors
        }
      }
      // Dashboard running but no token file - still return running
      return { running: true };
    }
  } catch {
    // Not running
  }
  return { running: false };
}

/**
 * Start the local Dashboard
 */
export async function startLocalDashboard(options: LaunchOptions): Promise<LaunchResult> {
  // Check if dashboard is already running (e.g., user started pnpm dev or embedded mode)
  const existing = await checkRunningDashboard();
  if (existing.running && existing.token) {
    currentToken = existing.token;
    // Determine correct port: check if Web server (53668) is running (dev mode)
    // or use API port (53667) for embedded mode where API serves static files
    const isDevMode = await isPortResponding(WEB_PORT);
    const webPort = isDevMode ? WEB_PORT : DASHBOARD_PORT;
    currentLocalUrl = `http://localhost:${webPort}/dashboard/?token=${existing.token}`;

    return {
      localUrl: currentLocalUrl,
      token: existing.token,
    };
  }

  // If Dashboard is already running via this launcher, reuse it
  if (dashboardProcess && !dashboardProcess.killed) {
    const token = currentToken || crypto.randomBytes(16).toString("hex");
    // Reuse existing URL if set, otherwise use DASHBOARD_PORT (bundled mode)
    if (!currentLocalUrl) {
      currentLocalUrl = `http://localhost:${DASHBOARD_PORT}/dashboard/?token=${token}`;
    }
    return {
      localUrl: currentLocalUrl,
      token,
    };
  }

  // Find the dashboard directory
  const dashboard = findDashboardDir();
  if (!dashboard) {
    throw new Error("Dashboard directory not found. Please install openguardrails package.");
  }

  // Generate a new session token
  const token = crypto.randomBytes(16).toString("hex");
  currentToken = token;

  // Start the Dashboard process
  if (dashboard.bundled) {
    await startBundledDashboard(dashboard.dir, token, options.coreUrl, options.dataDir);
  } else {
    await startDashboardProcess(dashboard.dir, token, options.coreUrl, options);
  }

  // Wait for Dashboard to be ready
  await waitForDashboard(DASHBOARD_PORT);

  // In bundled mode, API serves static files, so use DASHBOARD_PORT (not WEB_PORT)
  currentLocalUrl = `http://localhost:${DASHBOARD_PORT}/dashboard/?token=${token}`;

  return {
    localUrl: currentLocalUrl,
    token,
  };
}

/**
 * Find the Dashboard directory
 */
function findDashboardDir(): { dir: string; bundled: boolean } | null {
  const packageRoot = getPackageRoot();

  // Check common locations
  const candidates = [
    // 1. Bundled in moltguard package (production)
    { dir: path.join(packageRoot, "dashboard-dist"), bundled: true },
    // 2. Relative to moltguard (monorepo development)
    { dir: path.join(packageRoot, "..", "dashboard"), bundled: false },
    // 3. Installed globally
    { dir: path.join(os.homedir(), ".openclaw", "plugins", "moltguard", "dashboard"), bundled: false },
  ];

  for (const candidate of candidates) {
    // For bundled: check for api/package.json
    // For source: check for package.json
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
 * Start bundled Dashboard (pre-built, production mode)
 */
async function startBundledDashboard(
  dashboardDir: string,
  token: string,
  coreUrl: string,
  dataDir?: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const apiDir = path.join(dashboardDir, "api");
    const webDir = path.join(dashboardDir, "web");

    // Determine data directory for database storage
    const effectiveDataDir = dataDir || getPluginDataDir();

    // Ensure data directory exists
    if (!fs.existsSync(effectiveDataDir)) {
      fs.mkdirSync(effectiveDataDir, { recursive: true });
    }

    // Save token to file BEFORE starting Dashboard
    // This ensures checkRunningDashboard() can read the correct token
    const tokenDir = path.dirname(TOKEN_FILE);
    if (!fs.existsSync(tokenDir)) {
      fs.mkdirSync(tokenDir, { recursive: true });
    }
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token, port: DASHBOARD_PORT }));

    // Track if we've resolved (to stop logging after startup)
    let resolved = false;

    // Start the API server with node
    dashboardProcess = spawn("node", ["index.js"], {
      cwd: apiDir,
      env: {
        ...process.env,
        LOCAL_MODE: "true",
        LOCAL_SESSION_TOKEN: token,
        OG_CORE_URL: coreUrl,
        PORT: String(DASHBOARD_PORT),
        DASHBOARD_MODE: "embedded",
        // Serve static web from bundled web directory
        WEB_OUT_DIR: webDir,
        // Store database in plugin's data directory
        DASHBOARD_DATA_DIR: effectiveDataDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    // Only log during startup, stop after Dashboard is ready
    dashboardProcess.stdout?.on("data", (data) => {
      if (resolved) return; // Stop logging after startup
      const line = data.toString().trim();
      console.log(`[dashboard] ${line}`);
      if (line.includes("running on port") || line.includes("Local URL:")) {
        resolved = true;
        resolve();
      }
    });

    dashboardProcess.stderr?.on("data", (data) => {
      if (resolved) return; // Stop logging after startup
      console.error(`[dashboard] ${data.toString().trim()}`);
    });

    dashboardProcess.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        reject(new Error(`Failed to start Dashboard: ${err.message}`));
      }
    });

    dashboardProcess.on("exit", (code) => {
      if (!resolved && code !== 0 && code !== null) {
        resolved = true;
        reject(new Error(`Dashboard exited with code ${code}`));
      }
      dashboardProcess = null;
    });

    // Timeout if Dashboard doesn't start
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve(); // Resolve anyway, we'll check with waitForDashboard
      }
    }, 10000);
  });
}

/**
 * Error indicating development mode requires manual startup
 */
export class DevModeError extends Error {
  constructor(
    public dashboardDir: string,
  ) {
    super("Development mode requires manual startup");
    this.name = "DevModeError";
  }

  getInstructions(): string {
    return [
      "**Dashboard Not Running**",
      "",
      "Start the Dashboard in a separate terminal:",
      "",
      "```bash",
      `cd ${this.dashboardDir}`,
      `pnpm dev`,
      "```",
      "",
      "Then run `/og_dashboard` again to get the URL.",
    ].join("\n");
  }
}

/**
 * Start the Dashboard process (development mode with source)
 *
 * In development mode, we don't auto-start pnpm dev because:
 * 1. pnpm may not be in PATH when spawned from the plugin
 * 2. Development mode typically wants interactive terminal access
 *
 * Instead, throw DevModeError with instructions for manual startup.
 * In autoStart mode, silently skip without throwing.
 */
async function startDashboardProcess(
  dashboardDir: string,
  _token: string,
  _coreUrl: string,
  options?: { autoStart?: boolean }
): Promise<void> {
  // In auto-start mode during development, silently skip
  if (options?.autoStart) {
    console.log("[dashboard-launcher] Dev mode: Dashboard not auto-started. Run 'pnpm dev' manually in dashboard/");
    return;
  }
  // Interactive mode - prompt manual startup
  throw new DevModeError(dashboardDir);
}

/**
 * Wait for Dashboard to be ready
 */
async function waitForDashboard(port: number, timeoutMs: number = 30000): Promise<void> {
  const startTime = Date.now();
  const checkInterval = 500;

  while (Date.now() - startTime < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) {
        return;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, checkInterval));
  }

  throw new Error(`Dashboard did not start within ${timeoutMs}ms`);
}

/**
 * Stop the Dashboard process
 */
export function stopDashboard(): void {
  if (dashboardProcess) {
    dashboardProcess.kill();
    dashboardProcess = null;
  }
  currentToken = null;
  currentLocalUrl = null;
}

/**
 * Check if Dashboard is running
 */
export function isDashboardRunning(): boolean {
  return dashboardProcess !== null && !dashboardProcess.killed;
}

/**
 * Get current Dashboard URL
 */
export function getDashboardUrl(): string | null {
  return currentLocalUrl;
}
