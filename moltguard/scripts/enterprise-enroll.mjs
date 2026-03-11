#!/usr/bin/env node
// ============================================================================
// MoltGuard Enterprise Enroll Script
// ============================================================================
// Configures OpenClaw to connect to a private enterprise Core deployment.
// Designed to be executed by enterprise EDR systems for managed devices.
//
// Usage:
//   node scripts/enterprise-enroll.mjs <core-url>
//
// Example:
//   node scripts/enterprise-enroll.mjs https://core.company.com
//
// What it does:
//   Sets moltguard plugin config in ~/.openclaw/openclaw.json:
//     "moltguard": {
//       "enabled": true,
//       "config": {
//         "plan": "enterprise",
//         "coreUrl": "<core-url>"
//       }
//     }
// ============================================================================

import { readFileSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const RED = "\x1b[0;31m";
const GREEN = "\x1b[0;32m";
const NC = "\x1b[0m";

function log(msg) {
  console.log(`${GREEN}==>${NC} ${msg}`);
}

function error(msg) {
  console.error(`${RED}ERROR:${NC} ${msg}`);
  process.exit(1);
}

// Validate arguments
const coreUrl = process.argv[2];
if (!coreUrl) {
  error(
    `Usage: node scripts/enterprise-enroll.mjs <core-url>

Example:
  node scripts/enterprise-enroll.mjs https://core.company.com
  node scripts/enterprise-enroll.mjs http://10.0.1.100:53666`
  );
}

const openclawJson = join(homedir(), ".openclaw", "openclaw.json");

// Check openclaw.json exists
if (!existsSync(openclawJson)) {
  error(
    `OpenClaw config not found at ${openclawJson}
Is OpenClaw installed on this machine?`
  );
}

// Read and parse config
let config;
try {
  config = JSON.parse(readFileSync(openclawJson, "utf-8"));
} catch (e) {
  error(`Failed to parse ${openclawJson}: ${e.message}`);
}

log("Enrolling in enterprise plan...");
log(`Core URL: ${coreUrl}`);

// Update moltguard plugin config
if (!config.plugins) config.plugins = {};
if (!config.plugins.entries) config.plugins.entries = {};
if (!config.plugins.entries.moltguard) config.plugins.entries.moltguard = {};

config.plugins.entries.moltguard.enabled = true;
config.plugins.entries.moltguard.config = {
  plan: "enterprise",
  coreUrl: coreUrl,
};

// Write back
try {
  writeFileSync(openclawJson, JSON.stringify(config, null, 2) + "\n", "utf-8");
} catch (e) {
  error(`Failed to write ${openclawJson}: ${e.message}`);
}

log("Enterprise enrollment complete!");
console.log();
console.log(`Config updated: ${openclawJson}`);
console.log(`  plan:    enterprise`);
console.log(`  coreUrl: ${coreUrl}`);
console.log();
console.log("Next steps:");
console.log("  Restart OpenClaw to apply the new configuration.");
