import { Command } from "commander";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { paths } from "../lib/paths.js";
import { loadConfig, saveConfig } from "../lib/config.js";
import { startProcess, stopProcess, isRunning } from "../lib/process-manager.js";

const SESSION_TOKEN_PREFIX = "og-session-";

export function registerDashboardCommands(program: Command): void {
  const dashboard = program
    .command("dashboard")
    .description("Manage the OpenGuardrails dashboard");

  dashboard
    .command("init")
    .description("Initialize the dashboard (create DB, seed scanners, generate token)")
    .option("--core-url <url>", "Core API URL")
    .option("--core-key <key>", "Core API key")
    .action(initCommand);

  dashboard
    .command("start")
    .description("Start the dashboard")
    .option("-p, --port <port>", "API port (default: 53667)")
    .option("-w, --web-port <port>", "Web UI port (default: 53668)")
    .action(startCommand);

  dashboard
    .command("stop")
    .description("Stop the dashboard")
    .action(stopCommand);

  dashboard
    .command("status")
    .description("Show dashboard status")
    .action(statusCommand);

  dashboard
    .command("token")
    .description("Show or reset session token")
    .option("--reset", "Generate a new session token")
    .action(tokenCommand);
}

async function initCommand(options: { coreUrl?: string; coreKey?: string }) {
  console.log("Initializing OpenGuardrails Dashboard...\n");

  // Check Node.js version
  const nodeVersion = parseInt(process.versions.node.split(".")[0]!, 10);
  if (nodeVersion < 22) {
    console.error(`Error: Node.js >= 22 required (current: ${process.versions.node})`);
    process.exit(1);
  }

  // Create directories
  for (const dir of [paths.base, paths.data, paths.log]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`Created ${dir}`);
    }
  }

  // Run migrations using better-sqlite3 directly
  console.log("\nSetting up database...");
  try {
    const Database = (await import("better-sqlite3")).default;
    const { drizzle } = await import("drizzle-orm/better-sqlite3");
    const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");

    const sqlite = new Database(paths.db);
    sqlite.pragma("journal_mode = WAL");
    const db = drizzle(sqlite);

    if (fs.existsSync(paths.dashboardMigrations)) {
      migrate(db, { migrationsFolder: paths.dashboardMigrations });
      console.log("Migrations complete.");
    } else {
      console.log("Migration files not found. Skipping (will run on first start).");
    }

    // Seed default scanners
    const scanners = [
      { scannerId: "S01", name: "Prompt Injection", description: "Detect and block attempts to override system instructions" },
      { scannerId: "S02", name: "System Override", description: "Prevent manipulation of safety boundaries" },
      { scannerId: "S03", name: "Web Attacks", description: "Guard against XSS, CSRF, and web exploits" },
      { scannerId: "S04", name: "MCP Tool Poisoning", description: "Detect malicious tool definitions in MCP integrations" },
      { scannerId: "S05", name: "Malicious Code Execution", description: "Block harmful code execution attempts" },
      { scannerId: "S06", name: "NSFW Content", description: "Filter unsafe or inappropriate content" },
      { scannerId: "S07", name: "PII Exposure", description: "Identify and redact personally identifiable information" },
      { scannerId: "S08", name: "Credential Leakage", description: "Detect API keys, tokens, and passwords" },
      { scannerId: "S09", name: "Confidential Data", description: "Prevent sensitive business data leakage" },
      { scannerId: "S10", name: "Off-Topic Drift", description: "Keep agents focused on intended purpose" },
    ];

    for (const s of scanners) {
      sqlite.prepare(
        `INSERT OR IGNORE INTO scanner_definitions (scanner_id, name, description, is_enabled, tenant_id)
         VALUES (?, ?, ?, 1, 'default')`
      ).run(s.scannerId, s.name, s.description);
    }
    console.log("Default scanners seeded.");

    sqlite.close();
  } catch (err) {
    console.log("Database setup skipped:", (err as Error).message);
  }

  // Generate session token
  const sessionToken = SESSION_TOKEN_PREFIX + randomBytes(32).toString("hex");

  // Save config
  saveConfig({
    sessionToken,
    ...(options.coreUrl && { ogCoreUrl: options.coreUrl }),
    ...(options.coreKey && { ogCoreKey: options.coreKey }),
  });

  console.log("\n-------------------------------------------");
  console.log("OpenGuardrails Dashboard initialized!");
  console.log("-------------------------------------------");
  console.log(`Session Token: ${sessionToken}`);
  console.log(`Database:      ${paths.db}`);
  console.log(`Config:        ${paths.config}`);
  console.log("\nRun 'openguardrails dashboard start' to launch.");
}

async function startCommand(options: { port?: string; webPort?: string }) {
  const config = loadConfig();

  if (!fs.existsSync(paths.data)) {
    console.error("Error: Not initialized. Run 'openguardrails dashboard init' first.");
    process.exit(1);
  }

  const { running } = isRunning(paths.dashboardPid);
  if (running) {
    console.error("Dashboard is already running. Use 'openguardrails dashboard stop' first.");
    process.exit(1);
  }

  const apiPort = options.port ? parseInt(options.port, 10) : config.dashboardPort;
  const webPort = options.webPort ? parseInt(options.webPort, 10) : config.webPort;

  console.log("Starting OpenGuardrails Dashboard...");
  console.log(`  API: http://localhost:${apiPort}`);
  console.log(`  Web: http://localhost:${webPort}`);

  const env: Record<string, string> = {
    PORT: String(apiPort),
    WEB_ORIGIN: `http://localhost:${webPort}`,
    DB_DIALECT: "sqlite",
    SQLITE_PATH: paths.db,
    DASHBOARD_MODE: "standalone",
    OG_DASHBOARD_WEB_DIR: paths.dashboardWeb,
  };

  if (config.ogCoreUrl) env.OG_CORE_URL = config.ogCoreUrl;
  if (config.ogCoreKey) env.OG_CORE_KEY = config.ogCoreKey;
  if (config.sessionToken) env.SESSION_TOKEN = config.sessionToken;

  const child = startProcess({
    entry: paths.dashboardApi,
    pidFile: paths.dashboardPid,
    env,
    label: "Dashboard API",
  });

  const cleanup = () => {
    child.kill("SIGTERM");
    try { fs.unlinkSync(paths.dashboardPid); } catch {}
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  console.log(`\nSession Token: ${config.sessionToken}`);
  console.log("Press Ctrl+C to stop.\n");
}

async function stopCommand() {
  stopProcess(paths.dashboardPid, "Dashboard");
}

async function statusCommand() {
  const config = loadConfig();

  console.log("OpenGuardrails Dashboard Status\n");

  const { running, pid } = isRunning(paths.dashboardPid);
  if (running) {
    console.log(`  Status:   Running (PID: ${pid})`);
  } else {
    console.log("  Status:   Stopped");
  }

  console.log(`  API Port: ${config.dashboardPort}`);
  console.log(`  Web Port: ${config.webPort}`);
  console.log(`  Database: ${paths.db}`);
  console.log(`  DB exists: ${fs.existsSync(paths.db) ? "Yes" : "No"}`);
  console.log(`  Core URL: ${config.ogCoreUrl || "Not configured"}`);

  if (running) {
    console.log(`\n  Dashboard: http://localhost:${config.webPort}`);
    console.log(`  API:       http://localhost:${config.dashboardPort}`);
  }
}

async function tokenCommand(options: { reset?: boolean }) {
  const config = loadConfig();

  if (options.reset) {
    const newToken = SESSION_TOKEN_PREFIX + randomBytes(32).toString("hex");
    saveConfig({ sessionToken: newToken });

    // Update DB if possible
    try {
      const Database = (await import("better-sqlite3")).default;
      if (fs.existsSync(paths.db)) {
        const sqlite = new Database(paths.db);
        sqlite.prepare(
          "INSERT OR REPLACE INTO settings (key, value, tenant_id) VALUES ('session_token', ?, 'default')"
        ).run(newToken);
        sqlite.close();
      }
    } catch {}

    console.log(`Session token reset: ${newToken}`);
    console.log("\nRestart the dashboard for the new token to take effect.");
  } else {
    if (config.sessionToken) {
      console.log(config.sessionToken);
    } else {
      console.log("No session token. Run 'openguardrails dashboard init' first.");
    }
  }
}
