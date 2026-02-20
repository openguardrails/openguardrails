import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = process.env.CORE_DB_PATH || "./data/openguardrails.db";
mkdirSync(dirname(DB_PATH), { recursive: true });

const sqlite = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

// Run migrations inline (no migration files needed for initial schema)
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS registered_agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    api_key TEXT NOT NULL UNIQUE,
    claim_token TEXT NOT NULL UNIQUE,
    verification_code TEXT NOT NULL,
    email TEXT,
    email_token TEXT,
    status TEXT NOT NULL DEFAULT 'pending_claim',
    quota_total INTEGER NOT NULL DEFAULT 100000,
    quota_used INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_reg_agents_api_key ON registered_agents(api_key);
  CREATE INDEX IF NOT EXISTS idx_reg_agents_claim_token ON registered_agents(claim_token);
  CREATE INDEX IF NOT EXISTS idx_reg_agents_status ON registered_agents(status);

  CREATE TABLE IF NOT EXISTS behavior_events (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    session_key TEXT NOT NULL,
    user_intent TEXT,
    tool_chain_json TEXT,
    local_signals_json TEXT,
    risk_level TEXT NOT NULL,
    anomaly_types TEXT NOT NULL DEFAULT '[]',
    action TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0,
    explanation TEXT,
    affected_tools TEXT NOT NULL DEFAULT '[]',
    source_ip TEXT,
    plugin_version TEXT,
    client_timestamp TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_beh_events_agent_id ON behavior_events(agent_id);
  CREATE INDEX IF NOT EXISTS idx_beh_events_run_id ON behavior_events(run_id);
  CREATE INDEX IF NOT EXISTS idx_beh_events_session_key ON behavior_events(session_key);
  CREATE INDEX IF NOT EXISTS idx_beh_events_risk_level ON behavior_events(risk_level);
  CREATE INDEX IF NOT EXISTS idx_beh_events_created_at ON behavior_events(created_at);

  CREATE TABLE IF NOT EXISTS usage_logs (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    latency_ms INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_usage_agent_id ON usage_logs(agent_id);
  CREATE INDEX IF NOT EXISTS idx_usage_created_at ON usage_logs(created_at);
`);

// ── Additive migrations (idempotent ALTER TABLE) ─────────────────────────────
// SQLite does not support IF NOT EXISTS on ALTER TABLE ADD COLUMN,
// so we check the column list first.
const behaviorCols = sqlite
  .prepare("PRAGMA table_info(behavior_events)")
  .all() as Array<{ name: string }>;
const behaviorColNames = new Set(behaviorCols.map((c) => c.name));

if (!behaviorColNames.has("source_ip")) {
  sqlite.exec("ALTER TABLE behavior_events ADD COLUMN source_ip TEXT");
}
if (!behaviorColNames.has("plugin_version")) {
  sqlite.exec("ALTER TABLE behavior_events ADD COLUMN plugin_version TEXT");
}
if (!behaviorColNames.has("client_timestamp")) {
  sqlite.exec("ALTER TABLE behavior_events ADD COLUMN client_timestamp TEXT");
}

// Add session_key index if missing (was added in this migration)
sqlite.exec(
  "CREATE INDEX IF NOT EXISTS idx_beh_events_session_key ON behavior_events(session_key)",
);

console.log("✅ Core database migrated:", DB_PATH);
sqlite.close();
