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
  })
);

// ─── Scanner Definitions ────────────────────────────────────────
export const scannerDefinitions = pgTable(
  "scanner_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scannerId: varchar("scanner_id", { length: 10 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description").notNull(),
    config: jsonb("config").notNull().default({}),
    isEnabled: boolean("is_enabled").notNull().default(true),
    isDefault: boolean("is_default").notNull().default(false),
  },
  (table) => ({
    scannerIdIdx: index("idx_scanner_defs_scanner_id").on(table.scannerId),
  })
);

// ─── Policies ───────────────────────────────────────────────────
export const policies = pgTable("policies", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  scannerIds: jsonb("scanner_ids").notNull().default([]),
  action: varchar("action", { length: 50 }).notNull().default("log"),
  sensitivityThreshold: real("sensitivity_threshold").notNull().default(0.5),
  isEnabled: boolean("is_enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Usage Logs ─────────────────────────────────────────────────
export const usageLogs = pgTable(
  "usage_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
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
  })
);

// ─── Detection Results ──────────────────────────────────────────
export const detectionResults = pgTable(
  "detection_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
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
  })
);
