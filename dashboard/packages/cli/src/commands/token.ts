import { loadConfig, saveConfig } from "../lib/config.js";

export async function tokenCommand(options: { reset?: boolean }) {
  const config = loadConfig();

  if (options.reset) {
    const { generateSessionToken } = await import("@og/shared");
    const newToken = generateSessionToken();
    saveConfig({ sessionToken: newToken });

    // Also update DB
    try {
      process.env.DB_DIALECT = "sqlite";
      process.env.SQLITE_PATH = (await import("../lib/paths.js")).paths.db;
      const { db, settingsQueries } = await import("@og/db");
      const settings = settingsQueries(db);
      await settings.set("session_token", newToken);
    } catch {
      // DB might not be available
    }

    console.log(`Session token reset: ${newToken}`);
    console.log("\nRestart the dashboard for the new token to take effect.");
  } else {
    if (config.sessionToken) {
      console.log(config.sessionToken);
    } else {
      console.log("No session token set. Run 'openguardrails init' first.");
    }
  }
}
