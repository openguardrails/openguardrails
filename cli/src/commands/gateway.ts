import { Command } from "commander";
import fs from "node:fs";
import { paths } from "../lib/paths.js";
import { loadConfig } from "../lib/config.js";
import { startProcess, stopProcess, isRunning } from "../lib/process-manager.js";

export function registerGatewayCommands(program: Command): void {
  const gateway = program
    .command("gateway")
    .description("Manage the AI Security Gateway");

  gateway
    .command("start")
    .description("Start the AI Security Gateway")
    .option("-p, --port <port>", "Gateway port (default: 8900)")
    .option("-c, --config <path>", "Config file path")
    .action(startCommand);

  gateway
    .command("stop")
    .description("Stop the AI Security Gateway")
    .action(stopCommand);

  gateway
    .command("status")
    .description("Show gateway status")
    .action(statusCommand);
}

async function startCommand(options: { port?: string; config?: string }) {
  const config = loadConfig();

  const { running } = isRunning(paths.gatewayPid);
  if (running) {
    console.error("Gateway is already running. Use 'openguardrails gateway stop' first.");
    process.exit(1);
  }

  const port = options.port ? parseInt(options.port, 10) : config.gatewayPort;

  console.log("Starting OpenGuardrails AI Security Gateway...");
  console.log(`  Port: ${port}`);

  const args = [paths.gatewayEntry];
  if (options.config) args.push(options.config);

  const env: Record<string, string> = {
    GATEWAY_PORT: String(port),
  };

  const child = startProcess({
    entry: paths.gatewayEntry,
    pidFile: paths.gatewayPid,
    env,
    label: "Gateway",
  });

  const cleanup = () => {
    child.kill("SIGTERM");
    try { fs.unlinkSync(paths.gatewayPid); } catch {}
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  console.log("Press Ctrl+C to stop.\n");
}

async function stopCommand() {
  stopProcess(paths.gatewayPid, "Gateway");
}

async function statusCommand() {
  const config = loadConfig();

  console.log("OpenGuardrails Gateway Status\n");

  const { running, pid } = isRunning(paths.gatewayPid);
  if (running) {
    console.log(`  Status: Running (PID: ${pid})`);
  } else {
    console.log("  Status: Stopped");
  }

  console.log(`  Port:   ${config.gatewayPort}`);

  if (running) {
    console.log(`\n  Health: http://127.0.0.1:${config.gatewayPort}/health`);
    console.log(`  Endpoints:`);
    console.log(`    POST /v1/messages           — Anthropic`);
    console.log(`    POST /v1/chat/completions   — OpenAI`);
    console.log(`    POST /v1/models/:m:generateContent — Gemini`);
  }
}
