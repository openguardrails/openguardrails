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

const dialect = getDialect();

// Database path configuration:
// - DASHBOARD_DATA_DIR: directory for data files (default: dashboard/data)
// - DATABASE_URL: full path to SQLite file (overrides DASHBOARD_DATA_DIR for SQLite)
function getDefaultDbPath(): string {
  const dataDir = process.env.DASHBOARD_DATA_DIR || resolve(__dirname, "../../../data");
  return join(dataDir, "dashboard.db");
}

async function createDb() {
  if (dialect === "sqlite") {
    const { default: Database } = await import("better-sqlite3");
    const { drizzle } = await import("drizzle-orm/better-sqlite3");
    const schema = await import("./schema/sqlite.js");

    const rawUrl = process.env.DATABASE_URL || getDefaultDbPath();
    const dbPath = rawUrl.replace(/^file:/, "");

    // Ensure directory exists
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");

    return drizzle(sqlite, { schema });
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

export const db: any = await createDb();
export type Database = any;
