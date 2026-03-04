import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import crypto from "node:crypto";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { sessionAuth, setLocalSessionToken, LOCAL_SESSION_TOKEN } from "./middleware/session-auth.js";
import { authRouter } from "./routes/auth.js";
import { settingsRouter } from "./routes/settings.js";
import { agentsRouter } from "./routes/agents.js";
import { scannersRouter } from "./routes/scanners.js";
import { policiesRouter } from "./routes/policies.js";
import { detectionRouter } from "./routes/detection.js";
import { usageRouter } from "./routes/usage.js";
import { resultsRouter } from "./routes/results.js";
import { discoveryRouter } from "./routes/discovery.js";
import { observationsRouter } from "./routes/observations.js";
import { detectionsRouter } from "./routes/detections.js";
import { errorHandler } from "./middleware/error-handler.js";
import { autoMigrate } from "./auto-migrate.js";

import type { DashboardMode } from "@og/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = parseInt(process.env.PORT || process.env.API_PORT || "53667", 10);
const DASHBOARD_MODE = (process.env.DASHBOARD_MODE || "selfhosted") as DashboardMode;
const LOCAL_MODE = process.env.LOCAL_MODE === "true";

// Generate or reuse local session token for local mode (no auth required, single-user)
if (LOCAL_MODE && !LOCAL_SESSION_TOKEN) {
  const tokenDir = join(homedir(), ".openclaw", "credentials", "moltguard");
  const tokenFile = join(tokenDir, "dashboard-session-token");

  let localToken: string | null = null;

  // Try to reuse existing token (important for dev mode: tsx watch restarts)
  if (existsSync(tokenFile)) {
    try {
      const data = JSON.parse(readFileSync(tokenFile, "utf-8"));
      if (data.token && typeof data.token === "string") {
        localToken = data.token;
        console.log(`[dashboard] Local mode: reusing existing token`);
      }
    } catch {
      // Ignore parse errors, will generate new token
    }
  }

  // Generate new token if none exists
  if (!localToken) {
    localToken = crypto.randomBytes(16).toString("hex");
    console.log(`[dashboard] Local mode: generated new token`);
  }

  setLocalSessionToken(localToken);

  // Save token to file for /og_dashboard to read
  try {
    mkdirSync(tokenDir, { recursive: true });
    writeFileSync(tokenFile, JSON.stringify({ token: localToken, port: PORT }));
  } catch {
    // Ignore file errors
  }
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: DASHBOARD_MODE === "embedded" ? true : (process.env.WEB_ORIGIN || "http://localhost:53668"),
  credentials: true,
}));
app.use(morgan("short"));
app.use(express.json());

// Public routes
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "openguardrails-api", timestamp: new Date().toISOString() });
});
app.use("/api/auth", authRouter); // /request, /verify/:token, /me, /logout

// Serve static web app in embedded mode (before auth middleware)
if (DASHBOARD_MODE === "embedded") {
  // Check WEB_OUT_DIR env var first (for bundled mode), then relative paths
  const webOutPaths = [
    process.env.WEB_OUT_DIR,  // Bundled mode: set by dashboard-launcher.ts
    join(__dirname, "..", "..", "web", "out"),  // Dev mode: relative path
  ].filter(Boolean) as string[];
  // Resolve to absolute path (required for sendFile)
  const webOutDir = webOutPaths.map((p) => resolve(p)).find((p) => existsSync(p));
  if (webOutDir) {
    // Serve static files at both root and /dashboard paths
    app.use(express.static(webOutDir, { extensions: ["html"] }));
    app.use("/dashboard", express.static(webOutDir, { extensions: ["html"] }));
    // SPA fallback: serve index.html for non-API, non-static routes
    app.use((req, res, next) => {
      // Skip API routes
      if (req.path.startsWith("/api/")) return next();
      // Skip static assets (let express.static handle them or 404)
      if (/\.(js|css|svg|png|jpg|jpeg|gif|ico|woff|woff2|ttf|eot|map)$/i.test(req.path)) {
        return next();
      }
      const indexPath = join(webOutDir, "index.html");
      if (existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        next();
      }
    });
  }
}

// Session-protected routes
app.use(sessionAuth);
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

app.use(errorHandler);

// Auto-migrate database before starting server
await autoMigrate();

app.listen(PORT, () => {
  console.log(`OpenGuardrails API running on port ${PORT}`);
  console.log(`DashboardMode: ${DASHBOARD_MODE}`);
  if (LOCAL_MODE && LOCAL_SESSION_TOKEN) {
    console.log(`Local URL: http://localhost:${PORT}?token=${LOCAL_SESSION_TOKEN}`);
  } else {
    console.log(`Auth: POST /api/auth/request — send magic link`);
  }
});
