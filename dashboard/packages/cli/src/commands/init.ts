import fs from "node:fs";
import { paths } from "../lib/paths.js";
import { saveConfig } from "../lib/config.js";

export async function initCommand(options: { ogCoreKey?: string }) {
  console.log("Initializing OpenGuardrails Dashboard...\n");

  // 1. Check Node.js version
  const nodeVersion = parseInt(process.versions.node.split(".")[0]!, 10);
  if (nodeVersion < 22) {
    console.error(`Error: Node.js >= 22 is required (current: ${process.versions.node})`);
    process.exit(1);
  }

  // 2. Create directories
  for (const dir of [paths.base, paths.data, paths.log]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`Created ${dir}`);
    }
  }

  // 3. Set up environment for DB
  process.env.DB_DIALECT = "sqlite";
  process.env.SQLITE_PATH = paths.db;

  // 4. Run migrations + seed
  console.log("\nSetting up database...");
  try {
    const { runMigrations } = await import("@og/db");
    await runMigrations();
    console.log("Migrations complete.");
  } catch (err) {
    console.log("Migrations skipped (will run on first start).");
  }

  try {
    const { seed } = await import("@og/db");
    await seed();
    console.log("Default scanners seeded.");
  } catch (err) {
    console.log("Seed skipped (will run on first start).");
  }

  // 5. Generate session token
  const { generateSessionToken } = await import("@og/shared");
  const sessionToken = generateSessionToken();

  // 6. Save config
  const config: Record<string, string> = {
    sessionToken,
  };

  if (options.ogCoreKey) {
    config.ogCoreKey = options.ogCoreKey;
  }

  saveConfig(config);

  // 7. Store session token in DB settings
  try {
    const { db, settingsQueries } = await import("@og/db");
    const settings = settingsQueries(db);
    await settings.set("session_token", sessionToken);

    if (options.ogCoreKey) {
      await settings.set("og_core_key", options.ogCoreKey);
      await settings.set("og_core_url", "https://api.openguardrails.com");
    }
  } catch {
    // DB might not be ready yet
  }

  console.log("\n-------------------------------------------");
  console.log("OpenGuardrails Dashboard initialized!");
  console.log("-------------------------------------------");
  console.log(`Session Token: ${sessionToken}`);
  console.log(`Database:      ${paths.db}`);
  console.log(`Config:        ${paths.config}`);
  if (options.ogCoreKey) {
    console.log(`core Key:   ${options.ogCoreKey.slice(0, 12)}...`);
  }
  console.log("\nRun 'openguardrails start' to launch the dashboard.");
}
