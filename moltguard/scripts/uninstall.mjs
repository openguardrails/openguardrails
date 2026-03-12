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
//   1. Restores original provider URLs if sanitize (gateway) is enabled
//   2. Removes "moltguard" from plugins.entries in ~/.openclaw/openclaw.json
//   3. Removes "moltguard" from plugins.installs in ~/.openclaw/openclaw.json
//   4. Removes plugin files at ~/.openclaw/extensions/moltguard/
//   5. Removes credentials at ~/.openclaw/credentials/moltguard/
// ============================================================================

import { readFileSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
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
const openclawDir = join(home, ".openclaw");
const openclawJson = join(openclawDir, "openclaw.json");
const extensionsDir = join(openclawDir, "extensions", "moltguard");
const credentialsDir = join(openclawDir, "credentials", "moltguard");
const gatewayBackup = join(openclawDir, "extensions", "moltguard", "data", "gateway-backup.json");
const GATEWAY_SERVER_URL = "http://127.0.0.1:53669";

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

// ── Restore sanitize (gateway) if enabled ──────────────────────────────
// If gateway-backup.json exists, sanitize is on. We must restore original
// provider URLs in openclaw.json and agent models.json files before deleting
// moltguard, otherwise OpenClaw's LLM providers will point to a dead gateway.
let sanitizeRestored = false;
if (existsSync(gatewayBackup)) {
  log("AI Security Gateway (sanitize) is enabled, restoring original provider URLs...");

  try {
    const backup = JSON.parse(readFileSync(gatewayBackup, "utf-8"));

    // Restore openclaw.json provider baseUrls
    if (backup.routedProviders && config.models?.providers) {
      const providers = config.models.providers;
      const restored = [];
      for (const [name, routeInfo] of Object.entries(backup.routedProviders)) {
        const provider = providers[name];
        if (!provider) continue;
        if (provider.baseUrl && provider.baseUrl.startsWith(GATEWAY_SERVER_URL)) {
          provider.baseUrl = routeInfo.originalBaseUrl;
          restored.push(name);
        }
      }
      if (restored.length > 0) {
        log(`Restored provider URLs: ${restored.join(", ")}`);
      }
    }

    // Restore agent models.json files
    if (backup.agentModelsBackup) {
      let restoredFiles = 0;
      for (const [filePath, fileBackup] of Object.entries(backup.agentModelsBackup)) {
        if (!existsSync(filePath)) continue;
        try {
          const data = JSON.parse(readFileSync(filePath, "utf-8"));
          if (!data?.providers) continue;
          let modified = false;
          for (const [name, originalUrl] of Object.entries(fileBackup.originalBaseUrls)) {
            if (data.providers[name]) {
              data.providers[name].baseUrl = originalUrl;
              modified = true;
            }
          }
          if (modified) {
            writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
            restoredFiles++;
          }
        } catch {
          // Skip files that can't be read/written
        }
      }
      if (restoredFiles > 0) {
        log(`Restored ${restoredFiles} agent models.json file(s)`);
      }
    }

    // Delete backup file (marks sanitize as off)
    unlinkSync(gatewayBackup);
    sanitizeRestored = true;
  } catch (e) {
    warn(`Failed to restore gateway config: ${e.message}`);
    warn("You may need to manually fix provider URLs in ~/.openclaw/openclaw.json");
  }
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

// Write back config (includes both sanitize restore and plugin removal)
if (changed || sanitizeRestored) {
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
