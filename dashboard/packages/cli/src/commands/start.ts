import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { paths } from "../lib/paths.js";
import { loadConfig } from "../lib/config.js";

export async function startCommand(options: { port?: string; webPort?: string }) {
  const config = loadConfig();

  if (!fs.existsSync(paths.data)) {
    console.error("Error: OpenGuardrails not initialized. Run 'openguardrails init' first.");
    process.exit(1);
  }

  const apiPort = options.port ? parseInt(options.port, 10) : config.port;
  const webPort = options.webPort ? parseInt(options.webPort, 10) : config.webPort;

  // Find the API entry point
  const possibleApiPaths = [
    // When installed globally via npm
    path.join(__dirname, "..", "..", "..", "api", "dist", "index.js"),
    // In monorepo dev/build mode
    path.join(__dirname, "..", "..", "..", "..", "apps", "api", "dist", "index.js"),
    path.join(__dirname, "..", "..", "..", "..", "apps", "api", "src", "index.ts"),
  ];

  let apiEntryPoint: string | null = null;
  for (const p of possibleApiPaths) {
    if (fs.existsSync(p)) {
      apiEntryPoint = p;
      break;
    }
  }

  if (!apiEntryPoint) {
    console.error("Error: Could not find API entry point. Make sure the package is properly installed.");
    console.error("Searched paths:", possibleApiPaths);
    process.exit(1);
  }

  console.log(`Starting OpenGuardrails Dashboard...`);
  console.log(`API:  http://localhost:${apiPort}`);
  console.log(`Web:  http://localhost:${webPort}`);

  // Set environment
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    PORT: String(apiPort),
    WEB_ORIGIN: `http://localhost:${webPort}`,
    DB_DIALECT: "sqlite",
    SQLITE_PATH: paths.db,
    DASHBOARD_MODE: "standalone",
  };

  // Start API process
  const isTs = apiEntryPoint.endsWith(".ts");
  const runtime = isTs ? "tsx" : "node";

  const apiProcess = spawn(runtime, [apiEntryPoint], {
    env,
    stdio: "inherit",
  });

  // Save PID
  fs.writeFileSync(paths.pid, String(apiProcess.pid), "utf-8");

  apiProcess.on("exit", (code) => {
    try { fs.unlinkSync(paths.pid); } catch {}
    if (code !== 0 && code !== null) {
      console.error(`API process exited with code ${code}`);
    }
  });

  // Handle signals
  const cleanup = () => {
    apiProcess.kill("SIGTERM");
    try { fs.unlinkSync(paths.pid); } catch {}
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  console.log(`\nSession Token: ${config.sessionToken}`);
  console.log("Press Ctrl+C to stop.\n");
}
