import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";

// ─── Registered Agents ───────────────────────────────────────────
// One row per OpenClaw agent that registered via POST /api/v1/agents/register

export const registeredAgents = sqliteTable(
  "registered_agents",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull(),
    description: text("description"),
    apiKey: text("api_key").notNull().unique(),      // sk-og-<32hex>
    claimToken: text("claim_token").notNull().unique(), // openguardrails_claim_xxx
    verificationCode: text("verification_code").notNull(), // reef-X4B2
    // Set after user completes email verification
    email: text("email"),
    emailToken: text("email_token"),  // one-time token sent in verification email
    // pending_claim → active (after email verified) → suspended
    status: text("status").notNull().default("pending_claim"),
    // quota
    quotaTotal: integer("quota_total").notNull().default(100000), // free tier
    quotaUsed: integer("quota_used").notNull().default(0),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => ({
    apiKeyIdx: index("idx_reg_agents_api_key").on(t.apiKey),
    claimTokenIdx: index("idx_reg_agents_claim_token").on(t.claimToken),
    statusIdx: index("idx_reg_agents_status").on(t.status),
    emailIdx: index("idx_reg_agents_email").on(t.email),
  }),
);

// ─── Behavior Events ─────────────────────────────────────────────
// One row per POST /api/v1/behavior/assess call

export const behaviorEvents = sqliteTable(
  "behavior_events",
  {
    id: text("id").primaryKey(),                    // beh-<24hex>
    agentId: text("agent_id").notNull(),            // registered_agents.id
    runId: text("run_id").notNull(),                // plugin's per-run UUID
    sessionKey: text("session_key").notNull(),
    userIntent: text("user_intent"),
    toolChainJson: text("tool_chain_json", { mode: "json" }),
    localSignalsJson: text("local_signals_json", { mode: "json" }),
    riskLevel: text("risk_level").notNull(),        // no_risk|low|medium|high|critical
    anomalyTypes: text("anomaly_types", { mode: "json" }).notNull().default([]),
    action: text("action").notNull(),               // allow|alert|block
    confidence: real("confidence").notNull().default(0),
    explanation: text("explanation"),
    affectedTools: text("affected_tools", { mode: "json" }).notNull().default([]),
    // Client-supplied and server-captured metadata for dashboard correlation
    sourceIp: text("source_ip"),          // captured from HTTP request (req.ip / X-Forwarded-For)
    pluginVersion: text("plugin_version"), // from request meta.pluginVersion
    clientTimestamp: text("client_timestamp"), // ISO 8601 from request meta.clientTimestamp
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => ({
    agentIdIdx: index("idx_beh_events_agent_id").on(t.agentId),
    runIdIdx: index("idx_beh_events_run_id").on(t.runId),
    sessionKeyIdx: index("idx_beh_events_session_key").on(t.sessionKey),
    riskLevelIdx: index("idx_beh_events_risk_level").on(t.riskLevel),
    createdAtIdx: index("idx_beh_events_created_at").on(t.createdAt),
  }),
);

// ─── Usage Logs ──────────────────────────────────────────────────
// Tracks every billed API call (assess + detect)

export const usageLogs = sqliteTable(
  "usage_logs",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    agentId: text("agent_id").notNull(),
    endpoint: text("endpoint").notNull(),   // "assess" | "detect"
    latencyMs: integer("latency_ms").notNull(),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (t) => ({
    agentIdIdx: index("idx_usage_agent_id").on(t.agentId),
    createdAtIdx: index("idx_usage_created_at").on(t.createdAt),
  }),
);
