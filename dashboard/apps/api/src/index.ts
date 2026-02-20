import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
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

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: DASHBOARD_MODE === "embedded" ? true : (process.env.WEB_ORIGIN || "http://localhost:3000"),
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
