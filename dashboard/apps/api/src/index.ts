import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sessionAuth } from "./middleware/session-auth.js";
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
import { errorHandler } from "./middleware/error-handler.js";

import type { DashboardMode } from "@og/shared";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = parseInt(process.env.PORT || process.env.API_PORT || "3001", 10);
const DASHBOARD_MODE = (process.env.DASHBOARD_MODE || "selfhosted") as DashboardMode;

// In embedded mode the API is accessed via same-origin requests from the bundled web app.
// Allow localhost origins only; never open with origin:true (which bypasses CORS entirely).
const corsOrigin =
  DASHBOARD_MODE === "embedded"
    ? /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/
    : (process.env.WEB_ORIGIN || "http://localhost:3000");

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: corsOrigin,
  credentials: true,
}));
app.use(morgan("short"));
// Limit request body size to 1 MB to prevent memory-exhaustion attacks
app.use(express.json({ limit: "1mb" }));

// Rate limiter for authentication endpoints — 20 requests per 15 min per IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

// General API rate limiter — 300 requests per minute per IP
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

// Public routes
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "openguardrails-api", timestamp: new Date().toISOString() });
});
app.use("/api/auth", authLimiter, authRouter); // /request, /verify/:token, /me, /logout

// Serve static web app in embedded mode (before auth middleware)
if (DASHBOARD_MODE === "embedded") {
  // __dirname is either apps/api/dist or apps/api/src — both 2 levels up from apps/
  const webOutPaths = [
    join(__dirname, "..", "..", "web", "out"),
  ];
  const webOutDir = webOutPaths.find((p) => existsSync(p));
  if (webOutDir) {
    app.use(express.static(webOutDir, { extensions: ["html"] }));
    // SPA fallback: serve index.html for non-API routes
    app.use((req, res, next) => {
      if (req.path.startsWith("/api/")) return next();
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
app.use(apiLimiter);
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

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`OpenGuardrails API running on port ${PORT}`);
  console.log(`DashboardMode: ${DASHBOARD_MODE}`);
  console.log(`Auth: POST /api/auth/request — send magic link`);
});
