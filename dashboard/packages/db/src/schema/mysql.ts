import {
  mysqlTable,
  varchar,
  text,
  boolean,
  int,
  float,
  datetime,
  json,
  index,
} from "drizzle-orm/mysql-core";

// ─── Settings ─────────────────────────────────────────────────
export const settings = mysqlTable("settings", {
  key: varchar("key", { length: 255 }).primaryKey(),
  value: text("value").notNull(),
  updatedAt: datetime("updated_at").notNull().$defaultFn(() => new Date()),
});

// ─── Agents ─────────────────────────────────────────────────────
export const agents = mysqlTable(
  "agents",
  {
    id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: varchar("tenant_id", { length: 64 }).notNull().default("default"),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    provider: varchar("provider", { length: 50 }).notNull().default("custom"),
    status: varchar("status", { length: 50 }).notNull().default("inactive"),
    lastSeenAt: datetime("last_seen_at"),
    metadata: json("metadata").notNull().default({}),
    createdAt: datetime("created_at").notNull().$defaultFn(() => new Date()),
    updatedAt: datetime("updated_at").notNull().$defaultFn(() => new Date()),
  },
  (table) => ({
    statusIdx: index("idx_agents_status").on(table.status),
    tenantIdIdx: index("idx_agents_tenant_id").on(table.tenantId),
  })
);

// ─── Scanner Definitions ────────────────────────────────────────
export const scannerDefinitions = mysqlTable(
  "scanner_definitions",
  {
    id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: varchar("tenant_id", { length: 64 }).notNull().default("default"),
    scannerId: varchar("scanner_id", { length: 10 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description").notNull(),
    config: json("config").notNull().default({}),
    isEnabled: boolean("is_enabled").notNull().default(true),
    isDefault: boolean("is_default").notNull().default(false),
  },
  (table) => ({
    scannerIdIdx: index("idx_scanner_defs_scanner_id").on(table.scannerId),
    tenantIdIdx: index("idx_scanner_defs_tenant_id").on(table.tenantId),
  })
);

// ─── Policies ───────────────────────────────────────────────────
export const policies = mysqlTable(
  "policies",
  {
    id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: varchar("tenant_id", { length: 64 }).notNull().default("default"),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    scannerIds: json("scanner_ids").notNull().default([]),
    action: varchar("action", { length: 50 }).notNull().default("log"),
    sensitivityThreshold: float("sensitivity_threshold").notNull().default(0.5),
    isEnabled: boolean("is_enabled").notNull().default(true),
    createdAt: datetime("created_at").notNull().$defaultFn(() => new Date()),
    updatedAt: datetime("updated_at").notNull().$defaultFn(() => new Date()),
  },
  (table) => ({
    tenantIdIdx: index("idx_policies_tenant_id").on(table.tenantId),
  })
);

// ─── Usage Logs ─────────────────────────────────────────────────
export const usageLogs = mysqlTable(
  "usage_logs",
  {
    id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: varchar("tenant_id", { length: 64 }).notNull().default("default"),
    agentId: varchar("agent_id", { length: 36 }),
    endpoint: varchar("endpoint", { length: 255 }).notNull(),
    statusCode: int("status_code").notNull(),
    responseSafe: boolean("response_safe"),
    categories: json("categories").notNull().default([]),
    latencyMs: int("latency_ms").notNull(),
    requestId: varchar("request_id", { length: 64 }).notNull(),
    createdAt: datetime("created_at").notNull().$defaultFn(() => new Date()),
  },
  (table) => ({
    agentIdIdx: index("idx_usage_logs_agent_id").on(table.agentId),
    createdAtIdx: index("idx_usage_logs_created_at").on(table.createdAt),
    tenantIdIdx: index("idx_usage_logs_tenant_id").on(table.tenantId),
  })
);

// ─── Detection Results ──────────────────────────────────────────
export const detectionResults = mysqlTable(
  "detection_results",
  {
    id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: varchar("tenant_id", { length: 64 }).notNull().default("default"),
    agentId: varchar("agent_id", { length: 36 }),
    safe: boolean("safe").notNull(),
    categories: json("categories").notNull().default([]),
    sensitivityScore: float("sensitivity_score").notNull().default(0),
    findings: json("findings").notNull().default([]),
    latencyMs: int("latency_ms").notNull(),
    requestId: varchar("request_id", { length: 64 }).notNull(),
    createdAt: datetime("created_at").notNull().$defaultFn(() => new Date()),
  },
  (table) => ({
    agentIdIdx: index("idx_detection_results_agent_id").on(table.agentId),
    createdAtIdx: index("idx_detection_results_created_at").on(table.createdAt),
    tenantIdIdx: index("idx_detection_results_tenant_id").on(table.tenantId),
  })
);

// ─── Tool Call Observations ─────────────────────────────────────
export const toolCallObservations = mysqlTable(
  "tool_call_observations",
  {
    id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: varchar("tenant_id", { length: 64 }).notNull().default("default"),
    agentId: varchar("agent_id", { length: 36 }).notNull(),
    sessionKey: varchar("session_key", { length: 255 }),
    toolName: varchar("tool_name", { length: 255 }).notNull(),
    category: varchar("category", { length: 64 }),
    accessPattern: varchar("access_pattern", { length: 32 }),
    paramsJson: json("params_json"),
    phase: varchar("phase", { length: 16 }).notNull(),
    resultJson: json("result_json"),
    error: text("error"),
    durationMs: int("duration_ms"),
    blocked: boolean("blocked").notNull().default(false),
    blockReason: text("block_reason"),
    timestamp: datetime("timestamp").notNull().$defaultFn(() => new Date()),
  },
  (table) => ({
    agentIdIdx: index("idx_tool_obs_agent_id").on(table.agentId),
    toolNameIdx: index("idx_tool_obs_tool_name").on(table.toolName),
    timestampIdx: index("idx_tool_obs_timestamp").on(table.timestamp),
    tenantIdIdx: index("idx_tool_obs_tenant_id").on(table.tenantId),
  })
);

// ─── Agent Capabilities ────────────────────────────────────────
export const agentCapabilities = mysqlTable(
  "agent_capabilities",
  {
    id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: varchar("tenant_id", { length: 64 }).notNull().default("default"),
    agentId: varchar("agent_id", { length: 36 }).notNull(),
    toolName: varchar("tool_name", { length: 255 }).notNull(),
    category: varchar("category", { length: 64 }),
    accessPattern: varchar("access_pattern", { length: 32 }),
    targetsJson: json("targets_json").notNull().default([]),
    callCount: int("call_count").notNull().default(0),
    errorCount: int("error_count").notNull().default(0),
    firstSeen: datetime("first_seen").notNull().$defaultFn(() => new Date()),
    lastSeen: datetime("last_seen").notNull().$defaultFn(() => new Date()),
  },
  (table) => ({
    agentIdIdx: index("idx_agent_caps_agent_id").on(table.agentId),
    toolNameIdx: index("idx_agent_caps_tool_name").on(table.toolName),
    tenantIdIdx: index("idx_agent_caps_tenant_id").on(table.tenantId),
    uniqueAgentTool: index("idx_agent_caps_unique").on(table.tenantId, table.agentId, table.toolName),
  })
);
