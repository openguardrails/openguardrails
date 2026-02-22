import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** ~/.openguardrails/ — user data directory */
const base = path.join(os.homedir(), ".openguardrails");

/** Paths relative to the installed npm package */
const pkgRoot = path.resolve(__dirname, "..");

export const paths = {
  // User data
  base,
  data: path.join(base, "data"),
  log: path.join(base, "logs"),
  db: path.join(base, "data", "openguardrails.db"),
  config: path.join(base, "config.json"),
  dashboardPid: path.join(base, "dashboard.pid"),
  gatewayPid: path.join(base, "gateway.pid"),

  // Bundled assets (inside the npm package)
  bundled: path.join(pkgRoot, "bundled"),
  dashboardApi: path.join(pkgRoot, "bundled", "dashboard", "api", "index.js"),
  dashboardWeb: path.join(pkgRoot, "bundled", "dashboard", "web"),
  dashboardMigrations: path.join(pkgRoot, "bundled", "dashboard", "drizzle", "sqlite"),
  gatewayEntry: path.join(pkgRoot, "bundled", "gateway", "index.js"),
};
