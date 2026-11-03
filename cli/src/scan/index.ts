/** `openguardrails scan`: the agents on this machine, what they load, and what is worth fixing. */
import { homedir } from "node:os";
import { DEFAULT_PORT, loadConfig } from "../config.js";
import { READERS } from "./agents.js";
import type { Agent, Finding, Inventory, ScanContext } from "./types.js";

export function defaultContext(): ScanContext {
  let port = DEFAULT_PORT;
  try {
    port = loadConfig().gateway?.port ?? DEFAULT_PORT;
  } catch {
    // An unreadable config still leaves the default port to compare against.
  }
  return { home: homedir(), env: process.env, gatewayPort: port };
}

function derivedFindings(agent: Agent): Finding[] {
  const findings: Finding[] = [];
  if (agent.models.length > 0 && !agent.models.some((model) => model.through_gateway)) {
    findings.push({
      id: "gateway.not_attached",
      severity: "medium",
      agent: agent.id,
      location: agent.models[0]!.declared_in,
      message: "the agent calls its model directly, so nothing masks its secrets or judges its tool calls",
    });
  }
  for (const component of agent.components) {
    if (component.kind === "mcp_server" && component.package && !component.package.pinned) {
      findings.push({
        id: "mcp.unpinned_package",
        severity: "medium",
        agent: agent.id,
        component: component.name,
        location: component.declared_in,
        message: `${component.package.ecosystem} package ${component.package.name} is not pinned to an exact version, so each start can run different code`,
      });
    }
  }
  return findings;
}

export function scan(ctx: ScanContext = defaultContext(), now = new Date()): Inventory {
  const agents: Agent[] = [];
  const findings: Finding[] = [];
  for (const read of READERS) {
    const result = read(ctx);
    if (!result) continue;
    agents.push(result.agent);
    findings.push(...result.findings, ...derivedFindings(result.agent));
  }
  const order = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return { scanned_at: now.toISOString(), platform: process.platform, gateway_port: ctx.gatewayPort, agents, findings };
}

const tilde = (path: string, home: string) => (path.startsWith(home) ? `~${path.slice(home.length)}` : path);

export function render(inventory: Inventory, home = homedir()): string {
  const lines: string[] = [];
  if (inventory.agents.length === 0) {
    lines.push("No supported agent found. Looked for OpenClaw, Hermes, OpenCode, Codex and DeepSeek Harness.");
    return `${lines.join("\n")}\n`;
  }
  for (const agent of inventory.agents) {
    const count = (kind: string) => agent.components.filter((component) => component.kind === kind).length;
    lines.push(`${agent.name}  (${agent.kind} agent, ${agent.open_source ? "open source" : "closed source"})`);
    for (const model of agent.models) {
      lines.push(`  model     ${model.provider}  ${model.base_url ?? "(built-in default)"}  ${model.through_gateway ? "through the gateway" : "direct"}`);
    }
    lines.push(`  loads     ${count("mcp_server")} MCP servers, ${count("skill")} skills, ${count("plugin")} plugins`);
    for (const component of agent.components.filter((item) => item.kind === "mcp_server")) {
      const what = component.package ? `${component.package.ecosystem} ${component.package.name}${component.package.version ? `@${component.package.version}` : ""}` : component.url ?? component.command ?? "";
      lines.push(`    mcp     ${component.name}  ${component.transport ?? ""}  ${what}${component.enabled === false ? "  (disabled)" : ""}`);
    }
  }
  lines.push("");
  if (inventory.findings.length === 0) lines.push("Nothing to fix.");
  else {
    lines.push(`${inventory.findings.length} findings:`);
    for (const finding of inventory.findings) {
      lines.push(`  ${finding.severity.padEnd(6)} ${finding.agent}${finding.component ? `/${finding.component}` : ""}: ${finding.message}`);
      lines.push(`         ${tilde(finding.location, home)}`);
    }
  }
  lines.push("", "`openguardrails scan --json` prints everything, including each skill and plugin.");
  return `${lines.join("\n")}\n`;
}
