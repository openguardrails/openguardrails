#!/usr/bin/env node

import { Command } from "commander";
import { registerDashboardCommands } from "./commands/dashboard.js";
import { registerGatewayCommands } from "./commands/gateway.js";

const program = new Command();

program
  .name("openguardrails")
  .description("OpenGuardrails — Runtime Security for AI Agents")
  .version("6.5.0");

registerDashboardCommands(program);
registerGatewayCommands(program);

program.parse();
