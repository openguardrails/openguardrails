import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  integer,
  real,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

// ─── Settings ─────────────────────────────────────────────────
export const settings = pgTable("settings", {
  key: varchar("key", { length: 255 }).primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Agents ─────────────────────────────────────────────────────
export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: varchar("tenant_id", { length: 64 }).notNull().default("default"),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    provider: varchar("provider", { length: 50 }).notNull().default("custom"),
    status: varchar("status", { length: 50 }).notNull().default("inactive"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    statusIdx: index("idx_agents_status").on(table.status),
    tenantIdIdx: index("idx_agents_tenant_id").on(table.tenantId),
  })
);

// ─── Scanner Definitions ────────────────────────────────────────
export const scannerDefinitions = pgTable(
  "scanner_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: varchar("tenant_id", { length: 64 }).notNull().default("default"),
    scannerId: varchar("scanner_id", { length: 10 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description").notNull(),
    config: jsonb("config").notNull().default({}),
    isEnabled: boolean("is_enabled").notNull().default(true),
    isDefault: boolean("is_default").notNull().default(false),
  },
  (table) => ({
    scannerIdIdx: index("idx_scanner_defs_scanner_id").on(table.scannerId),
    tenantIdIdx: index("idx_scanner_defs_tenant_id").on(table.tenantId),
  })
);

// ─── Policies ───────────────────────────────────────────────────
export const policies = pgTable(
  "policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: varchar("tenant_id", { length: 64 }).notNull().default("default"),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    scannerIds: jsonb("scanner_ids").notNull().default([]),
    action: varchar("action", { length: 50 }).notNull().default("log"),
    sensitivityThreshold: real("sensitivity_threshold").notNull().default(0.5),
    isEnabled: boolean("is_enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tenantIdIdx: index("idx_policies_tenant_id").on(table.tenantId),
  })
);

// ─── Usage Logs ─────────────────────────────────────────────────
export const usageLogs = pgTable(
  "usage_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: varchar("tenant_id", { length: 64 }).notNull().default("default"),
    agentId: uuid("agent_id"),
    endpoint: varchar("endpoint", { length: 255 }).notNull(),
    statusCode: integer("status_code").notNull(),
    responseSafe: boolean("response_safe"),
    categories: jsonb("categories").notNull().default([]),
    latencyMs: integer("latency_ms").notNull(),
    requestId: varchar("request_id", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentIdIdx: index("idx_usage_logs_agent_id").on(table.agentId),
    createdAtIdx: index("idx_usage_logs_created_at").on(table.createdAt),
    tenantIdIdx: index("idx_usage_logs_tenant_id").on(table.tenantId),
  })
);

// ─── Detection Results ──────────────────────────────────────────
export const detectionResults = pgTable(
  "detection_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: varchar("tenant_id", { length: 64 }).notNull().default("default"),
    agentId: uuid("agent_id"),
    safe: boolean("safe").notNull(),
    categories: jsonb("categories").notNull().default([]),
    sensitivityScore: real("sensitivity_score").notNull().default(0),
    findings: jsonb("findings").notNull().default([]),
    latencyMs: integer("latency_ms").notNull(),
    requestId: varchar("request_id", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentIdIdx: index("idx_detection_results_agent_id").on(table.agentId),
    createdAtIdx: index("idx_detection_results_created_at").on(table.createdAt),
    tenantIdIdx: index("idx_detection_results_tenant_id").on(table.tenantId),
  })
);

// ─── Tool Call Observations ─────────────────────────────────────
export const toolCallObservations = pgTable(
  "tool_call_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: varchar("tenant_id", { length: 64 }).notNull().default("default"),
    agentId: uuid("agent_id").notNull(),
    sessionKey: varchar("session_key", { length: 255 }),
    toolName: varchar("tool_name", { length: 255 }).notNull(),
    category: varchar("category", { length: 64 }),
    accessPattern: varchar("access_pattern", { length: 32 }),
    paramsJson: jsonb("params_json"),
    phase: varchar("phase", { length: 16 }).notNull(),
    resultJson: jsonb("result_json"),
    error: text("error"),
    durationMs: integer("duration_ms"),
    blocked: boolean("blocked").notNull().default(false),
    blockReason: text("block_reason"),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentIdIdx: index("idx_tool_obs_agent_id").on(table.agentId),
    toolNameIdx: index("idx_tool_obs_tool_name").on(table.toolName),
    timestampIdx: index("idx_tool_obs_timestamp").on(table.timestamp),
    tenantIdIdx: index("idx_tool_obs_tenant_id").on(table.tenantId),
  })
);

// ─── Agent Permissions ────────────────────────────────────────
export const agentPermissions = pgTable(
  "agent_permissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: varchar("tenant_id", { length: 64 }).notNull().default("default"),
    agentId: uuid("agent_id").notNull(),
    toolName: varchar("tool_name", { length: 255 }).notNull(),
    category: varchar("category", { length: 64 }),
    accessPattern: varchar("access_pattern", { length: 32 }),
    targetsJson: jsonb("targets_json").notNull().default([]),
    callCount: integer("call_count").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
    firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().defaultNow(),
    lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentIdIdx: index("idx_agent_perms_agent_id").on(table.agentId),
    toolNameIdx: index("idx_agent_perms_tool_name").on(table.toolName),
    tenantIdIdx: index("idx_agent_perms_tenant_id").on(table.tenantId),
    uniqueAgentTool: index("idx_agent_perms_unique").on(table.tenantId, table.agentId, table.toolName),
  })
);

// ─── Magic Links ─────────────────────────────────────────────
export const magicLinks = pgTable(
  "magic_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: varchar("email", { length: 255 }).notNull(),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tokenIdx: index("idx_magic_links_token").on(table.token),
    emailIdx: index("idx_magic_links_email").on(table.email),
  })
);

// ─── User Sessions ────────────────────────────────────────────
export const userSessions = pgTable(
  "user_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: varchar("email", { length: 255 }).notNull(),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tokenIdx: index("idx_user_sessions_token").on(table.token),
    emailIdx: index("idx_user_sessions_email").on(table.email),
  })
);
