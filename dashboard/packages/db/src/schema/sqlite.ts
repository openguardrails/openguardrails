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
  })
);

// ─── Scanner Definitions ────────────────────────────────────────
export const scannerDefinitions = sqliteTable(
  "scanner_definitions",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    scannerId: text("scanner_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    config: text("config", { mode: "json" }).notNull().default({}),
    isEnabled: integer("is_enabled", { mode: "boolean" }).notNull().default(true),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  },
  (table) => ({
    scannerIdIdx: index("idx_scanner_defs_scanner_id").on(table.scannerId),
  })
);

// ─── Policies ───────────────────────────────────────────────────
export const policies = sqliteTable("policies", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  description: text("description"),
  scannerIds: text("scanner_ids", { mode: "json" }).notNull().default([]),
  action: text("action").notNull().default("log"),
  sensitivityThreshold: real("sensitivity_threshold").notNull().default(0.5),
  isEnabled: integer("is_enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// ─── Usage Logs ─────────────────────────────────────────────────
export const usageLogs = sqliteTable(
  "usage_logs",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
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
  })
);

// ─── Detection Results ──────────────────────────────────────────
export const detectionResults = sqliteTable(
  "detection_results",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
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
  })
);
