import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import crypto from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createServer, type Server } from "node:http";
import { sessionAuth, setLocalSessionToken, LOCAL_SESSION_TOKEN } from "./middleware/session-auth.js";
import { authRouter } from "./routes/auth.js";
import { errorHandler } from "./middleware/error-handler.js";
import { autoMigrate } from "./auto-migrate.js";
import { getDb } from "@og/db";

const __dirname = dirname(fileURLToPath(import.meta.url));

// =============================================================================
// Types
// =============================================================================

export interface DashboardOptions {
  port?: number;
  localMode?: boolean;
  localToken?: string;
  webOutDir?: string;
  dataDir?: string;
  coreUrl?: string;
}

// =============================================================================
// Dashboard App Factory
// =============================================================================

/**
 * Create and configure the Dashboard Express app
 * Routes are loaded dynamically after database is initialized
 */
export async function createDashboardApp(options: DashboardOptions = {}): Promise<Express> {
  const {
    localMode = false,
    localToken,
    webOutDir,
  } = options;

  const app = express();

  // Set up local session token if provided
  if (localMode && localToken) {
    setLocalSessionToken(localToken);
  }

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json());

  // Rewrite /dashboard/api/* to /api/*
  app.use((req, _res, next) => {
    if (req.path.startsWith("/dashboard/api/")) {
      req.url = req.url.replace("/dashboard/api/", "/api/");
    }
    next();
  });

  // Public routes
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "openguardrails-api", timestamp: new Date().toISOString() });
  });
  app.use("/api/auth", authRouter);

  // Serve static web app (before auth middleware)
  if (webOutDir) {
    const resolvedWebDir = resolve(webOutDir);
    console.log(`[dashboard] Serving static files from: ${resolvedWebDir}`);
    if (existsSync(resolvedWebDir)) {
      app.use(express.static(resolvedWebDir, { extensions: ["html"], index: ["index.html"] }));
      app.use("/dashboard", express.static(resolvedWebDir, { extensions: ["html"], index: ["index.html"] }));
      // SPA fallback
      app.use((req, res, next) => {
        if (req.path.startsWith("/api/")) return next();
        if (/\.(js|css|svg|png|jpg|jpeg|gif|ico|woff|woff2|ttf|eot|map)$/i.test(req.path)) {
          return next();
        }
        const indexPath = join(resolvedWebDir, "index.html");
        if (existsSync(indexPath)) {
          res.sendFile(indexPath);
        } else {
          next();
        }
      });
    }
  }

  // Session-protected routes - loaded dynamically after db is initialized
  app.use(sessionAuth);

  // Dynamic imports to ensure db is initialized before routes load
  const { settingsRouter } = await import("./routes/settings.js");
  const { agentsRouter } = await import("./routes/agents.js");
  const { scannersRouter } = await import("./routes/scanners.js");
  const { policiesRouter } = await import("./routes/policies.js");
  const { detectionRouter } = await import("./routes/detection.js");
  const { usageRouter } = await import("./routes/usage.js");
  const { resultsRouter } = await import("./routes/results.js");
  const { discoveryRouter } = await import("./routes/discovery.js");
  const { observationsRouter } = await import("./routes/observations.js");
  const { detectionsRouter } = await import("./routes/detections.js");
  const { gatewayRouter } = await import("./routes/gateway.js");
  const { agenticHoursRouter } = await import("./routes/agentic-hours.js");

  app.use("/api/settings", settingsRouter);
  app.use("/api/agents", agentsRouter);
  app.use("/api/scanners", scannersRouter);
  app.use("/api/policies", policiesRouter);
  app.use("/api/detect", detectionRouter);
  app.use("/api/usage", usageRouter);
  app.use("/api/results", resultsRouter);
  app.use("/api/discovery", discoveryRouter);
  app.use("/api/observations", observationsRouter);
  app.use("/api/detections", detectionsRouter);
  app.use("/api/gateway", gatewayRouter);
  app.use("/api/agentic-hours", agenticHoursRouter);

  app.use(errorHandler);

  return app;
}

// =============================================================================
// Dashboard Startup
// =============================================================================

let dashboardRunning = false;
let dashboardPort: number | null = null;
let dashboardServer: Server | null = null;

export interface DashboardInstance {
  port: number;
  token: string;
  close: () => Promise<void>;
}

/**
 * Start the Dashboard server (in-process)
 */
export async function startDashboard(options: DashboardOptions = {}): Promise<DashboardInstance> {
  const { getEnv, setEnv } = await import("./services/runtime-config.js");
  const port = options.port || parseInt(getEnv("PORT") || getEnv("API_PORT") || "53667", 10);
  const localMode = options.localMode ?? (getEnv("LOCAL_MODE") === "true");
  const dataDir = options.dataDir || getEnv("DASHBOARD_DATA_DIR");

  // Set environment variables for database and other modules
  if (dataDir) {
    setEnv("DASHBOARD_DATA_DIR", dataDir);
  }
  if (options.coreUrl) {
    setEnv("OG_CORE_URL", options.coreUrl);
  }

  // Generate or reuse token
  let token = options.localToken || "";
  if (localMode && !token) {
    const tokenDir = join(homedir(), ".openclaw", "credentials", "moltguard");
    const tokenFile = join(tokenDir, "dashboard-session-token");

    // Try to reuse existing token
    if (existsSync(tokenFile)) {
      try {
        const data = JSON.parse(readFileSync(tokenFile, "utf-8"));
        if (data.token && typeof data.token === "string") {
          token = data.token;
        }
      } catch {
        // Generate new
      }
    }

    if (!token) {
      token = crypto.randomBytes(16).toString("hex");
    }

    // Save token to file
    try {
      mkdirSync(tokenDir, { recursive: true });
      writeFileSync(tokenFile, JSON.stringify({ token, port }));
    } catch {
      // Ignore
    }
  }

  // Determine webOutDir
  let webOutDir = options.webOutDir || getEnv("WEB_OUT_DIR");
  if (!webOutDir) {
    // Try relative paths
    const candidates = [
      join(__dirname, "..", "..", "web", "out"),
    ];
    webOutDir = candidates.find((p) => existsSync(p));
  }

  // Auto-migrate database (this also initializes the db connection)
  await autoMigrate();

  // Initialize db for routes that use it
  await getDb();

  // Create and start app (routes loaded dynamically inside)
  const app = await createDashboardApp({
    port,
    localMode,
    localToken: token,
    webOutDir,
    dataDir,
    coreUrl: options.coreUrl,
  });

  // Create server and attach error handler BEFORE calling listen
  // This ensures we catch EADDRINUSE errors properly
  dashboardServer = createServer(app);

  return new Promise((resolve, reject) => {
    // Attach error handler FIRST
    dashboardServer!.on("error", (err) => {
      dashboardServer = null;
      reject(err);
    });

    // Now start listening
    dashboardServer!.listen(port, () => {
      // In local/embedded mode, allow the host process to exit naturally
      // (the gateway daemon keeps the process alive via its own mechanisms)
      if (localMode) {
        dashboardServer!.unref();
      }
      dashboardRunning = true;
      dashboardPort = port;
      console.log(`[dashboard] Running on port ${port}`);
      resolve({
        port,
        token,
        close: async () => {
          return new Promise((resolveClose) => {
            if (dashboardServer) {
              dashboardServer.close(() => {
                dashboardRunning = false;
                dashboardPort = null;
                dashboardServer = null;
                console.log("[dashboard] Server closed");
                resolveClose();
              });
            } else {
              resolveClose();
            }
          });
        },
      });
    });
  });
}

/**
 * Stop the Dashboard server
 */
export async function stopDashboard(): Promise<void> {
  return new Promise((resolve) => {
    if (dashboardServer) {
      dashboardServer.close(() => {
        dashboardRunning = false;
        dashboardPort = null;
        dashboardServer = null;
        console.log("[dashboard] Server closed");
        resolve();
      });
    } else {
      resolve();
    }
  });
}

/**
 * Check if Dashboard is running
 */
export function isDashboardRunning(): boolean {
  return dashboardRunning;
}

/**
 * Get Dashboard port
 */
export function getDashboardPort(): number | null {
  return dashboardPort;
}
