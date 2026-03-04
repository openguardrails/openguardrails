/**
 * Dashboard Launcher for MoltGuard
 *
 * Starts the local Dashboard and optionally connects to the tunnel
 * service for public URL access.
 */

import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

// Dashboard process and state
let dashboardProcess: ChildProcess | null = null;
let currentToken: string | null = null;
let currentLocalUrl: string | null = null;
let currentPublicUrl: string | null = null;
// Keep WebSocket connection alive (prevent garbage collection)
let tunnelConnection: import("ws").WebSocket | null = null;

export const DASHBOARD_PORT = 53667;
const WEB_PORT = 53668;
const TOKEN_FILE = path.join(os.homedir(), ".openclaw", "credentials", "moltguard", "dashboard-session-token");

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
  publicUrl: string | null;
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
 * Start the local Dashboard and tunnel
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

    // Connect to tunnel for public URL (best effort)
    // Skip tunnel in dev mode - Vite's ES modules don't work well through tunnel proxy
    if (isDevMode) {
      currentPublicUrl = null;
    } else {
      try {
        currentPublicUrl = await connectTunnel(existing.token, options.coreUrl, false);
      } catch {
        currentPublicUrl = null;
      }
    }

    return {
      localUrl: currentLocalUrl,
      publicUrl: currentPublicUrl,
      token: existing.token,
    };
  }

  // If Dashboard is already running via this launcher, reuse it
  if (dashboardProcess && !dashboardProcess.killed) {
    const token = currentToken || crypto.randomBytes(16).toString("hex");
    currentLocalUrl = `http://localhost:${WEB_PORT}/dashboard/?token=${token}`;
    return {
      localUrl: currentLocalUrl,
      publicUrl: currentPublicUrl,
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

  currentLocalUrl = `http://localhost:${WEB_PORT}/dashboard/?token=${token}`;

  // Connect to tunnel for public URL (best effort, don't fail if tunnel unavailable)
  // Bundled mode: API serves static files, so isDevMode = false
  try {
    currentPublicUrl = await connectTunnel(token, options.coreUrl, false);
  } catch (err) {
    console.warn(`[dashboard-launcher] Tunnel connection failed: ${err}`);
    currentPublicUrl = null;
  }

  return {
    localUrl: currentLocalUrl,
    publicUrl: currentPublicUrl,
    token,
  };
}

/**
 * Find the Dashboard directory
 */
function findDashboardDir(): { dir: string; bundled: boolean } | null {
  // Check common locations
  const candidates = [
    // 1. Bundled in moltguard package (production)
    { dir: path.join(__dirname, "dashboard-dist"), bundled: true },
    // 2. Relative to moltguard (monorepo development)
    { dir: path.join(__dirname, "..", "dashboard"), bundled: false },
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

    dashboardProcess.stdout?.on("data", (data) => {
      const line = data.toString().trim();
      console.log(`[dashboard] ${line}`);
      if (line.includes("running on port") || line.includes("Local URL:")) {
        resolve();
      }
    });

    dashboardProcess.stderr?.on("data", (data) => {
      console.error(`[dashboard] ${data.toString().trim()}`);
    });

    dashboardProcess.on("error", (err) => {
      reject(new Error(`Failed to start Dashboard: ${err.message}`));
    });

    dashboardProcess.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`Dashboard exited with code ${code}`));
      }
      dashboardProcess = null;
    });

    // Timeout if Dashboard doesn't start
    setTimeout(() => {
      resolve(); // Resolve anyway, we'll check with waitForDashboard
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
 * Connect to the tunnel service for public URL
 * @param isDevMode - If true, forward non-API requests to WEB_PORT (53668), otherwise to DASHBOARD_PORT (53667)
 */
async function connectTunnel(token: string, coreUrl: string, isDevMode: boolean): Promise<string> {
  // Close existing connection if any
  if (tunnelConnection) {
    try {
      tunnelConnection.close();
    } catch {
      // Ignore close errors
    }
    tunnelConnection = null;
  }

  // Dynamically import ws to avoid bundling issues
  const { default: WebSocket } = await import("ws");

  // Convert core URL to WebSocket URL
  const wsUrl = coreUrl
    .replace("https://", "wss://")
    .replace("http://", "ws://")
    + "/tunnel/ws";

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Tunnel connection timeout"));
    }, 10000);

    ws.on("open", () => {
      // Register with our token
      ws.send(JSON.stringify({
        type: "register",
        token,
      }));
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "registered" && msg.publicUrl) {
          clearTimeout(timeout);
          // Store connection to prevent garbage collection
          tunnelConnection = ws;
          resolve(msg.publicUrl);
          // Keep connection open for proxying requests
          setupTunnelProxy(ws, token, msg.publicUrl, isDevMode);
        } else if (msg.type === "error") {
          clearTimeout(timeout);
          ws.close();
          reject(new Error(msg.error || "Tunnel registration failed"));
        }
      } catch {
        // Ignore parse errors
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      tunnelConnection = null;
      reject(err);
    });

    ws.on("close", () => {
      clearTimeout(timeout);
      tunnelConnection = null;
      console.log("[dashboard-launcher] Tunnel connection closed");
    });

    // Keep-alive ping every 30 seconds
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      } else {
        clearInterval(pingInterval);
      }
    }, 30_000);

    ws.on("close", () => {
      clearInterval(pingInterval);
    });
  });
}

/**
 * Set up tunnel proxy to forward requests to local Dashboard
 * @param isDevMode - If true, forward non-API requests to WEB_PORT, otherwise all to DASHBOARD_PORT
 */
function setupTunnelProxy(ws: import("ws").WebSocket, token: string, publicUrl: string, isDevMode: boolean): void {
  const http = require("http") as typeof import("http");

  // Extract base path for <base> tag injection (e.g., /core/tunnel/{token})
  let tunnelBasePath = "/";
  try {
    const url = new URL(publicUrl);
    tunnelBasePath = url.pathname;
  } catch {
    // Ignore URL parse errors
  }

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type !== "request" || !msg.requestId) return;

      // Redirect root path to /dashboard/
      const pathWithoutQuery = msg.path.split("?")[0];
      if (pathWithoutQuery === "/" || pathWithoutQuery === "") {
        ws.send(JSON.stringify({
          type: "response",
          requestId: msg.requestId,
          statusCode: 302,
          headers: { location: `/dashboard/?token=${token}` },
          body: "",
        }));
        return;
      }

      // Forward request to local Dashboard
      // In dev mode: API requests go to 53667, web requests go to 53668
      // In embedded mode: all requests go to 53667 (API serves static files)
      const isApiRequest = msg.path.startsWith("/api/");
      const targetPort = isApiRequest ? DASHBOARD_PORT : (isDevMode ? WEB_PORT : DASHBOARD_PORT);

      const options = {
        hostname: "localhost",
        port: targetPort,
        path: msg.path + (msg.path.includes("?") ? "&" : "?") + `token=${token}`,
        method: msg.method,
        headers: {
          ...msg.headers,
          host: `localhost:${targetPort}`,
        },
      };

      const req = http.request(options, (res: import("http").IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          let body = Buffer.concat(chunks);
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(res.headers)) {
            if (typeof value === "string") {
              headers[key] = value;
            } else if (Array.isArray(value)) {
              headers[key] = value.join(", ");
            }
          }

          // Inject <base> tag into HTML responses for tunnel access
          const contentType = headers["content-type"] || "";
          if (contentType.includes("text/html")) {
            let html = body.toString("utf-8");
            // Inject <base> tag to make relative URLs work through tunnel
            const baseTag = `<base href="${tunnelBasePath}/">`;
            // Try multiple injection points
            if (/<head[^>]*>/i.test(html)) {
              html = html.replace(/<head[^>]*>/i, `$&${baseTag}`);
            } else if (/<html[^>]*>/i.test(html)) {
              html = html.replace(/<html[^>]*>/i, `$&<head>${baseTag}</head>`);
            } else if (/<!DOCTYPE[^>]*>/i.test(html)) {
              html = html.replace(/<!DOCTYPE[^>]*>/i, `$&<head>${baseTag}</head>`);
            } else {
              // Prepend if no standard tags found
              html = `<head>${baseTag}</head>${html}`;
            }
            body = Buffer.from(html, "utf-8");
            headers["content-length"] = String(body.length);
          }

          ws.send(JSON.stringify({
            type: "response",
            requestId: msg.requestId,
            statusCode: res.statusCode,
            headers,
            body: body.toString("base64"),
          }));
        });
      });

      req.on("error", () => {
        ws.send(JSON.stringify({
          type: "response",
          requestId: msg.requestId,
          statusCode: 502,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify({ error: "Local dashboard error" })).toString("base64"),
        }));
      });

      if (msg.body) {
        req.write(Buffer.from(msg.body, "base64"));
      }
      req.end();
    } catch {
      // Ignore errors
    }
  });
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
  currentPublicUrl = null;
}

/**
 * Check if Dashboard is running
 */
export function isDashboardRunning(): boolean {
  return dashboardProcess !== null && !dashboardProcess.killed;
}

/**
 * Get current Dashboard URLs
 */
export function getDashboardUrls(): { localUrl: string | null; publicUrl: string | null } {
  return {
    localUrl: currentLocalUrl,
    publicUrl: currentPublicUrl,
  };
}
