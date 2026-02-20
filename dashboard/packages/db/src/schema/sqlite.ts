import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";

// ─── Settings ─────────────────────────────────────────────────
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// ─── Agents ─────────────────────────────────────────────────────
export const agents = sqliteTable(
  "agents",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id").notNull().default("default"),
    name: text("name").notNull(),
    description: text("description"),
    provider: text("provider").notNull().default("custom"),
    status: text("status").notNull().default("inactive"),
    lastSeenAt: text("last_seen_at"),
    metadata: text("metadata", { mode: "json" }).notNull().default({}),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    statusIdx: index("idx_agents_status").on(table.status),
    tenantIdIdx: index("idx_agents_tenant_id").on(table.tenantId),
  })
);

// ─── Scanner Definitions ────────────────────────────────────────
export const scannerDefinitions = sqliteTable(
  "scanner_definitions",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id").notNull().default("default"),
    scannerId: text("scanner_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    config: text("config", { mode: "json" }).notNull().default({}),
    isEnabled: integer("is_enabled", { mode: "boolean" }).notNull().default(true),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  },
  (table) => ({
    scannerIdIdx: index("idx_scanner_defs_scanner_id").on(table.scannerId),
    tenantIdIdx: index("idx_scanner_defs_tenant_id").on(table.tenantId),
  })
);

// ─── Policies ───────────────────────────────────────────────────
export const policies = sqliteTable(
  "policies",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id").notNull().default("default"),
    name: text("name").notNull(),
    description: text("description"),
    scannerIds: text("scanner_ids", { mode: "json" }).notNull().default([]),
    action: text("action").notNull().default("log"),
    sensitivityThreshold: real("sensitivity_threshold").notNull().default(0.5),
    isEnabled: integer("is_enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
    updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    tenantIdIdx: index("idx_policies_tenant_id").on(table.tenantId),
  })
);

// ─── Usage Logs ─────────────────────────────────────────────────
export const usageLogs = sqliteTable(
  "usage_logs",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id").notNull().default("default"),
    agentId: text("agent_id"),
    endpoint: text("endpoint").notNull(),
    statusCode: integer("status_code").notNull(),
    responseSafe: integer("response_safe", { mode: "boolean" }),
    categories: text("categories", { mode: "json" }).notNull().default([]),
    latencyMs: integer("latency_ms").notNull(),
    requestId: text("request_id").notNull(),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    agentIdIdx: index("idx_usage_logs_agent_id").on(table.agentId),
    createdAtIdx: index("idx_usage_logs_created_at").on(table.createdAt),
    tenantIdIdx: index("idx_usage_logs_tenant_id").on(table.tenantId),
  })
);

// ─── Detection Results ──────────────────────────────────────────
export const detectionResults = sqliteTable(
  "detection_results",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id").notNull().default("default"),
    agentId: text("agent_id"),
    safe: integer("safe", { mode: "boolean" }).notNull(),
    categories: text("categories", { mode: "json" }).notNull().default([]),
    sensitivityScore: real("sensitivity_score").notNull().default(0),
    findings: text("findings", { mode: "json" }).notNull().default([]),
    latencyMs: integer("latency_ms").notNull(),
    requestId: text("request_id").notNull(),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    agentIdIdx: index("idx_detection_results_agent_id").on(table.agentId),
    createdAtIdx: index("idx_detection_results_created_at").on(table.createdAt),
    tenantIdIdx: index("idx_detection_results_tenant_id").on(table.tenantId),
  })
);

// ─── Tool Call Observations ─────────────────────────────────────
export const toolCallObservations = sqliteTable(
  "tool_call_observations",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id").notNull().default("default"),
    agentId: text("agent_id").notNull(),
    sessionKey: text("session_key"),
    toolName: text("tool_name").notNull(),
    category: text("category"),
    accessPattern: text("access_pattern"),
    paramsJson: text("params_json", { mode: "json" }),
    phase: text("phase").notNull(),
    resultJson: text("result_json", { mode: "json" }),
    error: text("error"),
    durationMs: integer("duration_ms"),
    blocked: integer("blocked", { mode: "boolean" }).notNull().default(false),
    blockReason: text("block_reason"),
    timestamp: text("timestamp").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    agentIdIdx: index("idx_tool_obs_agent_id").on(table.agentId),
    toolNameIdx: index("idx_tool_obs_tool_name").on(table.toolName),
    timestampIdx: index("idx_tool_obs_timestamp").on(table.timestamp),
    tenantIdIdx: index("idx_tool_obs_tenant_id").on(table.tenantId),
  })
);

// ─── Magic Links ─────────────────────────────────────────────
// One-time login tokens sent via email (15-min TTL)
export const magicLinks = sqliteTable(
  "magic_links",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    email: text("email").notNull(),
    token: text("token").notNull().unique(),
    expiresAt: text("expires_at").notNull(),
    usedAt: text("used_at"),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    tokenIdx: index("idx_magic_links_token").on(table.token),
    emailIdx: index("idx_magic_links_email").on(table.email),
  })
);

// ─── User Sessions ────────────────────────────────────────────
// Persistent sessions created after magic link verification (30-day TTL)
export const userSessions = sqliteTable(
  "user_sessions",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    email: text("email").notNull(),
    token: text("token").notNull().unique(),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    tokenIdx: index("idx_user_sessions_token").on(table.token),
    emailIdx: index("idx_user_sessions_email").on(table.email),
  })
);

// ─── Agent Permissions ────────────────────────────────────────
export const agentPermissions = sqliteTable(
  "agent_permissions",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id").notNull().default("default"),
    agentId: text("agent_id").notNull(),
    toolName: text("tool_name").notNull(),
    category: text("category"),
    accessPattern: text("access_pattern"),
    targetsJson: text("targets_json", { mode: "json" }).notNull().default([]),
    callCount: integer("call_count").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
    firstSeen: text("first_seen").notNull().$defaultFn(() => new Date().toISOString()),
    lastSeen: text("last_seen").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    agentIdIdx: index("idx_agent_perms_agent_id").on(table.agentId),
    toolNameIdx: index("idx_agent_perms_tool_name").on(table.toolName),
    tenantIdIdx: index("idx_agent_perms_tenant_id").on(table.tenantId),
    uniqueAgentTool: index("idx_agent_perms_unique").on(table.tenantId, table.agentId, table.toolName),
  })
);
