import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";

import { healthRouter } from "./routes/health.js";
import { registerRouter } from "./routes/register.js";
import { claimRouter } from "./routes/claim.js";
import { verifyEmailRouter } from "./routes/verify-email.js";
import { assessRouter } from "./routes/assess.js";
import { accountRouter } from "./routes/account.js";
import { accountsRouter } from "./routes/accounts.js";
import { portalRouter } from "./routes/portal.js";
import { apiKeyAuth } from "./middleware/api-key-auth.js";

const app = express();
const PORT = parseInt(process.env.PORT || "3002", 10);

// ─── Middleware ──────────────────────────────────────────────────

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: process.env.CORS_ORIGIN || "*",
  credentials: true,
}));
app.use(morgan("short"));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true })); // for claim form POST

// ─── Public routes (no auth) ─────────────────────────────────────

app.get("/", (_req, res) => {
  res.redirect(302, "/login");
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "openguardrails-core", timestamp: new Date().toISOString() });
});
app.use("/health", healthRouter);

// Agent registration — no auth, anyone can call
app.use("/api/v1/agents/register", registerRouter);

// Email verification — link clicked from email
app.use("/api/v1/agents/verify-email", verifyEmailRouter);

// Claim page — HTML UI served to humans
app.use("/claim", claimRouter);

// Portal — login + account pages for humans
app.use(portalRouter);

// ─── Authenticated routes ────────────────────────────────────────

app.use(apiKeyAuth);

// Account info — dashboard uses this to validate API keys
app.use("/api/v1/account", accountRouter);

// All agents by email — multi-agent dashboard view
app.use("/api/v1/accounts", accountsRouter);

// Behavioral anomaly detection
app.use("/api/v1/behavior/assess", assessRouter);

// ─── Error handler ───────────────────────────────────────────────

app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error("[core] Error:", err.message);
    res.status(500).json({ success: false, error: "Internal server error" });
  },
);

// ─── Start ───────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`OpenGuardrails Core running on port ${PORT}`);
  console.log(`  POST /api/v1/agents/register  — agent registration`);
  console.log(`  GET  /claim/:token            — user claim page`);
  console.log(`  GET  /api/v1/agents/verify-email/:token — email verification`);
  console.log(`  GET  /api/v1/account          — account info (auth required)`);
  console.log(`  GET  /api/v1/accounts         — all agents by email (auth required)`);
  console.log(`  POST /api/v1/behavior/assess  — behavioral detection (auth required)`);
  console.log(`  GET  /health                  — health check`);
});
