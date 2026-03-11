#!/usr/bin/env node
// ============================================================================
// MoltGuard Enterprise Unenroll Script
// ============================================================================
// Removes enterprise configuration from OpenClaw, restoring default behavior.
// The moltguard plugin remains enabled but without enterprise config.
//
// Usage:
//   node scripts/enterprise-unenroll.mjs
//
// What it does:
//   Removes the "config" block from moltguard plugin in ~/.openclaw/openclaw.json:
//     Before:
//       "moltguard": { "enabled": true, "config": { "plan": "enterprise", "coreUrl": "..." } }
//     After:
//       "moltguard": { "enabled": true }
// ============================================================================

import { readFileSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const RED = "\x1b[0;31m";
const GREEN = "\x1b[0;32m";
const YELLOW = "\x1b[1;33m";
const NC = "\x1b[0m";

function log(msg) {
  console.log(`${GREEN}==>${NC} ${msg}`);
}

function warn(msg) {
  console.log(`${YELLOW}==>${NC} ${msg}`);
}

function error(msg) {
  console.error(`${RED}ERROR:${NC} ${msg}`);
  process.exit(1);
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

// Check if enterprise config exists
const currentPlan =
  config?.plugins?.entries?.moltguard?.config?.plan;
if (!currentPlan) {
  warn("No enterprise config found. Nothing to remove.");
  process.exit(0);
}

const currentUrl =
  config?.plugins?.entries?.moltguard?.config?.coreUrl || "";

log("Removing enterprise config...");
log(`  Current plan:    ${currentPlan}`);
log(`  Current coreUrl: ${currentUrl}`);

// Remove the config block from moltguard plugin
delete config.plugins.entries.moltguard.config;

// Write back
try {
  writeFileSync(openclawJson, JSON.stringify(config, null, 2) + "\n", "utf-8");
} catch (e) {
  error(`Failed to write ${openclawJson}: ${e.message}`);
}

log("Enterprise unenrollment complete!");
console.log();
console.log(`Config updated: ${openclawJson}`);
console.log("MoltGuard will use the default public Core on next restart.");
console.log();
console.log("Next steps:");
console.log("  Restart OpenClaw to apply the change.");
