#!/usr/bin/env node
// ============================================================================
// MoltGuard Uninstall Script
// ============================================================================
// Removes MoltGuard plugin from OpenClaw completely.
//
// Usage:
//   node scripts/uninstall.mjs
//
// What it does:
//   1. Removes "moltguard" from plugins.entries in ~/.openclaw/openclaw.json
//   2. Removes "moltguard" from plugins.installs in ~/.openclaw/openclaw.json
//   3. Removes plugin files at ~/.openclaw/extensions/moltguard/
//   4. Removes credentials at ~/.openclaw/credentials/moltguard/
// ============================================================================

import { readFileSync, writeFileSync, rmSync } from "node:fs";
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

const home = homedir();
const openclawJson = join(home, ".openclaw", "openclaw.json");
const extensionsDir = join(home, ".openclaw", "extensions", "moltguard");
const credentialsDir = join(home, ".openclaw", "credentials", "moltguard");

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

let changed = false;

// Remove plugins.entries.moltguard
if (config?.plugins?.entries?.moltguard) {
  log("Removing plugins.entries.moltguard...");
  delete config.plugins.entries.moltguard;
  changed = true;
} else {
  warn("plugins.entries.moltguard not found, skipping.");
}

// Remove plugins.installs.moltguard
if (config?.plugins?.installs?.moltguard) {
  log("Removing plugins.installs.moltguard...");
  delete config.plugins.installs.moltguard;
  changed = true;
} else {
  warn("plugins.installs.moltguard not found, skipping.");
}

// Write back config
if (changed) {
  try {
    writeFileSync(
      openclawJson,
      JSON.stringify(config, null, 2) + "\n",
      "utf-8"
    );
    log(`Config updated: ${openclawJson}`);
  } catch (e) {
    error(`Failed to write ${openclawJson}: ${e.message}`);
  }
}

// Remove plugin files
if (existsSync(extensionsDir)) {
  log(`Removing plugin files: ${extensionsDir}`);
  rmSync(extensionsDir, { recursive: true, force: true });
} else {
  warn(`Plugin directory not found: ${extensionsDir}`);
}

// Remove credentials
if (existsSync(credentialsDir)) {
  log(`Removing credentials: ${credentialsDir}`);
  rmSync(credentialsDir, { recursive: true, force: true });
} else {
  warn(`Credentials directory not found: ${credentialsDir}`);
}

log("MoltGuard uninstall complete!");
console.log();
console.log("Next steps:");
console.log("  Restart OpenClaw to apply the change.");
