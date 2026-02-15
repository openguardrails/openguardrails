import fs from "node:fs";
import { paths } from "../lib/paths.js";
import { loadConfig } from "../lib/config.js";

export async function statusCommand() {
  const config = loadConfig();

  console.log("OpenGuardrails Dashboard Status\n");

  // Check if running
  let running = false;
  if (fs.existsSync(paths.pid)) {
    const pid = parseInt(fs.readFileSync(paths.pid, "utf-8").trim(), 10);
    try {
      process.kill(pid, 0); // Check if process exists
      running = true;
      console.log(`  Status:   Running (PID: ${pid})`);
    } catch {
      console.log("  Status:   Stopped (stale PID file)");
      try { fs.unlinkSync(paths.pid); } catch {}
    }
  } else {
    console.log("  Status:   Stopped");
  }

  console.log(`  API Port: ${config.port}`);
  console.log(`  Web Port: ${config.webPort}`);
  console.log(`  Database: ${paths.db}`);
  console.log(`  DB exists: ${fs.existsSync(paths.db) ? "Yes" : "No"}`);
  console.log(`  core:  ${config.ogCoreKey ? "Configured" : "Not configured"}`);

  if (running) {
    console.log(`\n  Dashboard: http://localhost:${config.webPort}`);
    console.log(`  API:       http://localhost:${config.port}`);
  }
}
