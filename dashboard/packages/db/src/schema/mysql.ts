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
    // Static scan fields
    scanType: varchar("scan_type", { length: 16 }).notNull().default("dynamic"), // "static" or "dynamic"
    filePath: text("file_path"), // Relative path from workspace for static scans
    fileType: varchar("file_type", { length: 16 }), // "soul", "agent", "memory", "task", "skill", "plugin", "other"
    createdAt: datetime("created_at").notNull().$defaultFn(() => new Date()),
  },
  (table) => ({
    agentIdIdx: index("idx_detection_results_agent_id").on(table.agentId),
    createdAtIdx: index("idx_detection_results_created_at").on(table.createdAt),
    tenantIdIdx: index("idx_detection_results_tenant_id").on(table.tenantId),
    scanTypeIdx: index("idx_detection_results_scan_type").on(table.scanType),
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

// ─── Gateway Activity ─────────────────────────────────────────
// Records of gateway sanitization and restoration events
export const gatewayActivity = mysqlTable(
  "gateway_activity",
  {
    id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: varchar("tenant_id", { length: 64 }).notNull().default("default"),
    eventId: varchar("event_id", { length: 128 }).notNull(), // From gateway: gw-timestamp-counter-type
    requestId: varchar("request_id", { length: 64 }).notNull(), // gw-timestamp-counter
    timestamp: datetime("timestamp").notNull(),
    type: varchar("type", { length: 16 }).notNull(), // "sanitize" or "restore"
    direction: varchar("direction", { length: 16 }).notNull(), // "request" or "response"
    backend: varchar("backend", { length: 32 }).notNull(), // "openai", "anthropic", "gemini"
    endpoint: varchar("endpoint", { length: 255 }).notNull(), // e.g., "/v1/chat/completions"
    model: varchar("model", { length: 128 }),
    redactionCount: int("redaction_count").notNull().default(0),
    categories: json("categories").notNull().default({}), // { email: 2, secret: 1 }
    durationMs: int("duration_ms"),
    createdAt: datetime("created_at").notNull().$defaultFn(() => new Date()),
  },
  (table) => ({
    requestIdIdx: index("idx_gateway_activity_request_id").on(table.requestId),
    timestampIdx: index("idx_gateway_activity_timestamp").on(table.timestamp),
    typeIdx: index("idx_gateway_activity_type").on(table.type),
    tenantIdIdx: index("idx_gateway_activity_tenant_id").on(table.tenantId),
  })
);

// ─── Agent Permissions ────────────────────────────────────────
export const agentPermissions = mysqlTable(
  "agent_permissions",
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
    agentIdIdx: index("idx_agent_perms_agent_id").on(table.agentId),
    toolNameIdx: index("idx_agent_perms_tool_name").on(table.toolName),
    tenantIdIdx: index("idx_agent_perms_tenant_id").on(table.tenantId),
    uniqueAgentTool: index("idx_agent_perms_unique").on(table.tenantId, table.agentId, table.toolName),
  })
);

// ─── Magic Links ─────────────────────────────────────────────
export const magicLinks = mysqlTable(
  "magic_links",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    email: varchar("email", { length: 255 }).notNull(),
    token: text("token").notNull(),
    expiresAt: varchar("expires_at", { length: 32 }).notNull(),
    usedAt: varchar("used_at", { length: 32 }),
    createdAt: varchar("created_at", { length: 32 }).notNull(),
  },
  (table) => ({
    tokenIdx: index("idx_magic_links_token").on(table.token),
    emailIdx: index("idx_magic_links_email").on(table.email),
  })
);

// ─── User Sessions ────────────────────────────────────────────
export const userSessions = mysqlTable(
  "user_sessions",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    email: varchar("email", { length: 255 }).notNull(),
    token: text("token").notNull(),
    expiresAt: varchar("expires_at", { length: 32 }).notNull(),
    createdAt: varchar("created_at", { length: 32 }).notNull(),
  },
  (table) => ({
    tokenIdx: index("idx_user_sessions_token").on(table.token),
    emailIdx: index("idx_user_sessions_email").on(table.email),
  })
);

// ─── Agentic Hours ──────────────────────────────────────────────
// Daily aggregated duration metrics per agent
export const agenticHoursLocal = mysqlTable(
  "agentic_hours_local",
  {
    id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: varchar("tenant_id", { length: 64 }).notNull().default("default"),
    agentId: varchar("agent_id", { length: 36 }).notNull(),
    date: varchar("date", { length: 10 }).notNull(), // YYYY-MM-DD
    toolCallDurationMs: int("tool_call_duration_ms").notNull().default(0),
    llmDurationMs: int("llm_duration_ms").notNull().default(0),
    totalDurationMs: int("total_duration_ms").notNull().default(0),
    toolCallCount: int("tool_call_count").notNull().default(0),
    llmCallCount: int("llm_call_count").notNull().default(0),
    sessionCount: int("session_count").notNull().default(0),
    blockCount: int("block_count").notNull().default(0),
    riskEventCount: int("risk_event_count").notNull().default(0),
    createdAt: datetime("created_at").notNull().$defaultFn(() => new Date()),
    updatedAt: datetime("updated_at").notNull().$defaultFn(() => new Date()),
  },
  (table) => ({
    agentDateIdx: index("idx_agentic_hours_agent_date").on(table.tenantId, table.agentId, table.date),
    tenantDateIdx: index("idx_agentic_hours_tenant_date").on(table.tenantId, table.date),
  })
);
