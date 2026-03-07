import { config } from "dotenv";
import { resolve, dirname, join } from "path";
import { mkdirSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { getDialect } from "./dialect.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from project root if DATABASE_URL is not already set
if (!process.env.DATABASE_URL && !process.env.DB_DIALECT) {
  config({ path: resolve(__dirname, "../../../.env") });
}

// Database path configuration:
// - DASHBOARD_DATA_DIR: directory for data files (default: dashboard/data)
// - DATABASE_URL: full path to SQLite file (overrides DASHBOARD_DATA_DIR for SQLite)
function getDefaultDbPath(): string {
  const dataDir = process.env.DASHBOARD_DATA_DIR || resolve(__dirname, "../../../data");
  return join(dataDir, "dashboard.db");
}

// Lazy-initialized database instance
let _db: any = null;
let _dbInitPromise: Promise<any> | null = null;

async function createDb() {
  const dialect = getDialect();

  if (dialect === "sqlite") {
    const { createClient } = await import("@libsql/client");
    const { drizzle } = await import("drizzle-orm/libsql");
    const schema = await import("./schema/sqlite.js");

    const rawUrl = process.env.DATABASE_URL || getDefaultDbPath();
    const dbPath = rawUrl.replace(/^file:/, "");

    // Ensure directory exists
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const client = createClient({ url: `file:${dbPath}` });
    // Enable WAL mode and foreign keys via PRAGMA
    await client.execute("PRAGMA journal_mode = WAL");
    await client.execute("PRAGMA foreign_keys = ON");

    return drizzle(client, { schema });
  }

  if (dialect === "mysql") {
    const mysql2 = await import("mysql2/promise");
    const { drizzle } = await import("drizzle-orm/mysql2");
    const schema = await import("./schema/mysql.js");

    const pool = mysql2.createPool(process.env.DATABASE_URL!);
    return drizzle(pool, { schema, mode: "default" });
  }

  // postgresql (default)
  const pg = await import("postgres");
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const schema = await import("./schema/pg.js");

  const queryClient = pg.default(process.env.DATABASE_URL!);
  return drizzle(queryClient, { schema });
}

/**
 * Get database instance (lazy initialization)
 * This ensures DASHBOARD_DATA_DIR is read at runtime, not at import time
 */
export async function getDb(): Promise<any> {
  if (_db) return _db;

  if (!_dbInitPromise) {
    _dbInitPromise = createDb().then((instance) => {
      _db = instance;
      // Also set the exported db variable for backwards compatibility
      db = instance;
      return _db;
    });
  }

  return _dbInitPromise;
}

/**
 * Synchronous db access (legacy compatibility)
 * Returns the cached instance or throws if not initialized
 */
export function getDbSync(): any {
  if (!_db) {
    throw new Error("Database not initialized. Call getDb() first.");
  }
  return _db;
}

export type Database = any;

// Legacy export: will be initialized on first getDb() call
// Routes that use `db` directly will work after autoMigrate() calls getDb()
export let db: any = null;
