#!/usr/bin/env node

import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { startCommand } from "./commands/start.js";
import { stopCommand } from "./commands/stop.js";
import { statusCommand } from "./commands/status.js";
import { tokenCommand } from "./commands/token.js";

const program = new Command();

program
  .name("openguardrails")
  .description("OpenGuardrails Dashboard - AI Agent Security Management")
  .version("0.1.0");

program
  .command("init")
  .description("Initialize the dashboard (create DB, seed scanners, generate token)")
  .option("--core-key <key>", "Set core API key during init")
  .action(initCommand);

program
  .command("start")
  .description("Start the dashboard")
  .option("-p, --port <port>", "API port (default: 3001)")
  .option("-w, --web-port <port>", "Web UI port (default: 3000)")
  .action(startCommand);

program
  .command("stop")
  .description("Stop the dashboard")
  .action(stopCommand);

program
  .command("status")
  .description("Show dashboard status")
  .action(statusCommand);

program
  .command("token")
  .description("Show or reset session token")
  .option("--reset", "Generate a new session token")
  .action(tokenCommand);

program.parse();
