import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { sessionAuth, ensureSessionToken } from "./middleware/session-auth.js";
import { sessionRouter } from "./routes/session.js";
import { settingsRouter } from "./routes/settings.js";
import { agentsRouter } from "./routes/agents.js";
import { scannersRouter } from "./routes/scanners.js";
import { policiesRouter } from "./routes/policies.js";
import { detectionRouter } from "./routes/detection.js";
import { usageRouter } from "./routes/usage.js";
import { resultsRouter } from "./routes/results.js";
import { errorHandler } from "./middleware/error-handler.js";

const app = express();
const PORT = parseInt(process.env.PORT || process.env.API_PORT || "3001", 10);

app.use(helmet());
app.use(cors({
  origin: process.env.WEB_ORIGIN || "http://localhost:3000",
  credentials: true,
}));
app.use(morgan("short"));
app.use(express.json());

// Public routes
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "openguardrails-api", timestamp: new Date().toISOString() });
});
app.use("/api/session", sessionRouter);

// Session-protected routes
app.use(sessionAuth);
app.use("/api/settings", settingsRouter);
app.use("/api/agents", agentsRouter);
app.use("/api/scanners", scannersRouter);
app.use("/api/policies", policiesRouter);
app.use("/api/detect", detectionRouter);
app.use("/api/usage", usageRouter);
app.use("/api/results", resultsRouter);

app.use(errorHandler);

// Ensure session token exists on startup
ensureSessionToken().then((token) => {
  app.listen(PORT, () => {
    console.log(`OpenGuardrails API running on port ${PORT}`);
    console.log(`Session token: ${token}`);
  });
});
