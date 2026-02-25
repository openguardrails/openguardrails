#!/usr/bin/env npx tsx
/**
 * Migrate tenant_id from "default" to each user's email.
 *
 * Reads the core database to get agent → email mapping,
 * then updates all dashboard tables accordingly.
 *
 * Usage: cd dashboard/packages/db && pnpm tsx scripts/migrate-tenant.ts
 *
 * Environment variables:
 *   CORE_DATABASE_URL - path to core database (default: ../../../../core/data/openguardrails.db)
 *   DATABASE_URL - path to dashboard database (default: ../../data/openguardrails.db)
 */

import Database from "better-sqlite3";
import { resolve } from "node:path";

const scriptDir = import.meta.dirname;
const coreDbPath = process.env.CORE_DATABASE_URL?.replace("file:", "") ||
  resolve(scriptDir, "../../../../core/data/openguardrails.db");
const dashboardDbPath = process.env.DATABASE_URL?.replace("file:", "") ||
  resolve(scriptDir, "../../data/openguardrails.db");

console.log("=== Tenant Migration ===\n");
console.log(`Core database:      ${coreDbPath}`);
console.log(`Dashboard database: ${dashboardDbPath}\n`);

// Step 1: Read agent → email mapping from core
const coreDb = new Database(coreDbPath, { readonly: true });

interface CoreAgent {
  id: string;
  name: string;
  email: string | null;
}

const coreAgents = coreDb.prepare(`
  SELECT id, name, email FROM registered_agents WHERE email IS NOT NULL
`).all() as CoreAgent[];

coreDb.close();

if (coreAgents.length === 0) {
  console.log("No agents with email found in core database. Nothing to migrate.");
  process.exit(0);
}

console.log(`Found ${coreAgents.length} agents with email in core:\n`);
for (const agent of coreAgents) {
  console.log(`  - ${agent.name} (${agent.id}) → ${agent.email}`);
}
console.log();

// Build lookup maps
const emailByAgentId = new Map<string, string>();
const emailByAgentName = new Map<string, string>();

for (const agent of coreAgents) {
  if (agent.email) {
    emailByAgentId.set(agent.id, agent.email);
    emailByAgentName.set(agent.name.toLowerCase(), agent.email);
  }
}

// Step 2: Update dashboard database
const dashDb = new Database(dashboardDbPath);

// 2a: Update agents table - match by metadata.openclawId or by name
interface DashboardAgent {
  id: string;
  name: string;
  tenant_id: string;
  metadata: string;
}

const dashAgents = dashDb.prepare(`
  SELECT id, name, tenant_id, metadata FROM agents WHERE tenant_id = 'default'
`).all() as DashboardAgent[];

console.log(`Dashboard agents with tenant_id='default': ${dashAgents.length}\n`);

let agentsUpdated = 0;
const agentIdToEmail = new Map<string, string>();

for (const agent of dashAgents) {
  let email: string | undefined;

  // Try to match by openclawId in metadata
  try {
    const metadata = JSON.parse(agent.metadata || "{}");
    if (metadata.openclawId && emailByAgentId.has(metadata.openclawId)) {
      email = emailByAgentId.get(metadata.openclawId);
    }
  } catch {
    // ignore parse errors
  }

  // Fall back to name matching
  if (!email) {
    email = emailByAgentName.get(agent.name.toLowerCase());
  }

  if (email) {
    dashDb.prepare(`UPDATE agents SET tenant_id = ? WHERE id = ?`).run(email, agent.id);
    agentIdToEmail.set(agent.id, email);
    console.log(`  agents: ${agent.name} → ${email}`);
    agentsUpdated++;
  } else {
    console.log(`  agents: ${agent.name} → [no match found, skipped]`);
  }
}

console.log(`\nAgents updated: ${agentsUpdated}\n`);

// 2b: Update other tables that have agent_id
// For each record, look up the agent's email and update tenant_id

const tablesWithAgentId = [
  "tool_call_observations",
  "agent_permissions",
  "usage_logs",
  "detection_results",
];

for (const table of tablesWithAgentId) {
  try {
    // Get distinct agent_ids with default tenant
    const records = dashDb.prepare(`
      SELECT DISTINCT agent_id FROM ${table} WHERE tenant_id = 'default' AND agent_id IS NOT NULL
    `).all() as { agent_id: string }[];

    let tableUpdated = 0;

    for (const { agent_id } of records) {
      // First check our local mapping from dashboard agents
      let email = agentIdToEmail.get(agent_id);

      // If not found, try core mapping directly (agent_id might be the core ID)
      if (!email) {
        email = emailByAgentId.get(agent_id);
      }

      if (email) {
        const result = dashDb.prepare(`
          UPDATE ${table} SET tenant_id = ? WHERE agent_id = ? AND tenant_id = 'default'
        `).run(email, agent_id);
        tableUpdated += result.changes;
      }
    }

    console.log(`  ${table}: ${tableUpdated} rows updated`);
  } catch (err) {
    console.log(`  ${table}: skipped (${(err as Error).message})`);
  }
}

// 2c: Update tables without agent_id (scanners, policies)
// These are global settings - assign to the first email found or leave as default
const globalTables = ["scanner_definitions", "policies"];
const firstEmail = coreAgents[0]?.email;

if (firstEmail) {
  console.log(`\nGlobal tables (assigned to ${firstEmail}):`);
  for (const table of globalTables) {
    try {
      const result = dashDb.prepare(`
        UPDATE ${table} SET tenant_id = ? WHERE tenant_id = 'default'
      `).run(firstEmail);
      console.log(`  ${table}: ${result.changes} rows updated`);
    } catch (err) {
      console.log(`  ${table}: skipped (${(err as Error).message})`);
    }
  }
}

dashDb.close();

console.log("\n=== Migration complete ===");
