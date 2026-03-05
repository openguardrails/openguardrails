import { config } from "dotenv";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { existsSync, mkdirSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

config({ path: resolve(__dirname, "../../../.env") });

// Database path configuration:
// - DASHBOARD_DATA_DIR: directory for data files (default: dashboard/data)
// - DATABASE_URL: full path to SQLite file (overrides DASHBOARD_DATA_DIR for SQLite)
function getDefaultDbPath(): string {
  const dataDir = process.env.DASHBOARD_DATA_DIR || resolve(__dirname, "../../../data");
  return join(dataDir, "dashboard.db");
}

/**
 * Run database migrations
 * @param migrationsFolder Optional path to migrations folder (auto-detected if not provided)
 */
export async function runMigrations(migrationsFolder?: string) {
  const { getDialect } = await import("./dialect.js");
  const dialect = getDialect();

  console.log(`Running migrations for dialect: ${dialect}`);

  // Auto-detect migrations folder if not provided
  if (!migrationsFolder) {
    // Try bundled location first (sibling to this file)
    const bundledPath = resolve(__dirname, "drizzle", dialect);
    // Fall back to dev location
    const devPath = resolve(__dirname, "../drizzle", dialect);
    migrationsFolder = existsSync(bundledPath) ? bundledPath : devPath;
  }

  if (!existsSync(migrationsFolder)) {
    throw new Error(`Migrations folder not found: ${migrationsFolder}`);
  }

  if (dialect === "sqlite") {
    const { createClient } = await import("@libsql/client");
    const { drizzle } = await import("drizzle-orm/libsql");
    const { migrate } = await import("drizzle-orm/libsql/migrator");

    // Always use getDefaultDbPath() which respects DASHBOARD_DATA_DIR env var
    // This ensures migrations run on the same database that client.ts connects to
    const rawUrl = process.env.DATABASE_URL || getDefaultDbPath();
    const dbPath = rawUrl.replace(/^file:/, "");

    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const client = createClient({ url: `file:${dbPath}` });
    await client.execute("PRAGMA journal_mode = WAL");
    const db = drizzle(client);

    await migrate(db, { migrationsFolder });
    console.log(`SQLite migrations complete (${dbPath})`);
    client.close();
  } else if (dialect === "mysql") {
    const mysql2 = await import("mysql2/promise");
    const { drizzle } = await import("drizzle-orm/mysql2");
    const { migrate } = await import("drizzle-orm/mysql2/migrator");

    const pool = mysql2.createPool(process.env.DATABASE_URL!);
    const db = drizzle(pool);

    await migrate(db, { migrationsFolder });
    console.log("MySQL migrations complete.");
    await pool.end();
  } else {
    const pg = await import("postgres");
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");

    const queryClient = pg.default(process.env.DATABASE_URL!, { max: 1 });
    const db = drizzle(queryClient);

    await migrate(db, { migrationsFolder });
    console.log("PostgreSQL migrations complete.");
    await queryClient.end();
  }
}

// When run directly as a script (only in dev mode with tsx)
// In bundled mode, this code is not executed as the file structure is different
const isMainModule = process.argv[1] && (
  process.argv[1].endsWith('/migrate.ts') ||
  process.argv[1].endsWith('/migrate.js')
);

if (isMainModule) {
  runMigrations().then(() => {
    process.exit(0);
  }).catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
}
