import { runMigrations } from "@og/db";

/**
 * Auto-migrate database on startup
 */
export async function autoMigrate(): Promise<void> {
  try {
    console.log("[dashboard] Auto-migrating database...");
    await runMigrations();
  } catch (error) {
    console.error("[dashboard] Migration failed:", error);
    throw error;
  }
}
