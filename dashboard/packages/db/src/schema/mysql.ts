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
  })
);

// ─── Scanner Definitions ────────────────────────────────────────
export const scannerDefinitions = mysqlTable(
  "scanner_definitions",
  {
    id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
    scannerId: varchar("scanner_id", { length: 10 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description").notNull(),
    config: json("config").notNull().default({}),
    isEnabled: boolean("is_enabled").notNull().default(true),
    isDefault: boolean("is_default").notNull().default(false),
  },
  (table) => ({
    scannerIdIdx: index("idx_scanner_defs_scanner_id").on(table.scannerId),
  })
);

// ─── Policies ───────────────────────────────────────────────────
export const policies = mysqlTable("policies", {
  id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  scannerIds: json("scanner_ids").notNull().default([]),
  action: varchar("action", { length: 50 }).notNull().default("log"),
  sensitivityThreshold: float("sensitivity_threshold").notNull().default(0.5),
  isEnabled: boolean("is_enabled").notNull().default(true),
  createdAt: datetime("created_at").notNull().$defaultFn(() => new Date()),
  updatedAt: datetime("updated_at").notNull().$defaultFn(() => new Date()),
});

// ─── Usage Logs ─────────────────────────────────────────────────
export const usageLogs = mysqlTable(
  "usage_logs",
  {
    id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
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
  })
);

// ─── Detection Results ──────────────────────────────────────────
export const detectionResults = mysqlTable(
  "detection_results",
  {
    id: varchar("id", { length: 36 }).primaryKey().$defaultFn(() => crypto.randomUUID()),
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
  })
);
