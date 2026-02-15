import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

config({ path: resolve(__dirname, "../../../.env") });

async function runMigrations() {
  const { getDialect } = await import("./dialect.js");
  const dialect = getDialect();

  console.log(`Running migrations for dialect: ${dialect}`);

  if (dialect === "sqlite") {
    const { default: Database } = await import("better-sqlite3");
    const { drizzle } = await import("drizzle-orm/better-sqlite3");
    const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
    const { mkdirSync, existsSync } = await import("fs");
    const { dirname } = await import("path");

    const defaultPath = resolve(__dirname, "../../../data/openguardrails.db");
    const rawUrl = process.env.DATABASE_URL || defaultPath;
    const dbPath = rawUrl.replace(/^file:/, "");

    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL");
    const db = drizzle(sqlite);

    migrate(db, { migrationsFolder: resolve(__dirname, "../drizzle/sqlite") });
    console.log("SQLite migrations complete.");
    sqlite.close();
  } else if (dialect === "mysql") {
    const mysql2 = await import("mysql2/promise");
    const { drizzle } = await import("drizzle-orm/mysql2");
    const { migrate } = await import("drizzle-orm/mysql2/migrator");

    const pool = mysql2.createPool(process.env.DATABASE_URL!);
    const db = drizzle(pool);

    await migrate(db, { migrationsFolder: resolve(__dirname, "../drizzle/mysql") });
    console.log("MySQL migrations complete.");
    await pool.end();
  } else {
    const pg = await import("postgres");
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");

    const queryClient = pg.default(process.env.DATABASE_URL!, { max: 1 });
    const db = drizzle(queryClient);

    await migrate(db, { migrationsFolder: resolve(__dirname, "../drizzle/postgresql") });
    console.log("PostgreSQL migrations complete.");
    await queryClient.end();
  }

  process.exit(0);
}

runMigrations().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
