/**
 * `openguardrails attach`: point an agent's model calls at the local gateway.
 *
 * Only the base URL changes. The key stays where the agent keeps it and the gateway forwards it as it
 * came; the model name is untouched. A base URL `https://api.example.com/v1` becomes
 * `http://127.0.0.1:4180/u/api.example.com/v1`, and the gateway sends the request on to
 * `https://api.example.com/v1/...`. The config file is edited in place, value by value, so comments and
 * formatting survive; a copy of it is kept first, and `detach` puts the old URLs back.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { configPath, DEFAULT_PORT, homeDir, loadConfig, type Config } from "./config.js";
import { scan } from "./scan/index.js";
import type { Agent, ScanContext } from "./scan/types.js";
import { cleanUrl } from "./scan/util.js";

export interface Attachment {
  agent: string;
  file: string;
  from: string;
  to: string;
  name: string;
  backup: string;
  at: string;
}

export interface Plan {
  changes: Attachment[];
  /** What could not be attached, and why. */
  skipped: Array<{ agent: string; provider: string; reason: string }>;
}

const manifestPath = () => join(homeDir(), "attached.json");

export function readManifest(): Attachment[] {
  if (!existsSync(manifestPath())) return [];
  return JSON.parse(readFileSync(manifestPath(), "utf8")) as Attachment[];
}

function writePrivate(path: string, text: string): void {
  mkdirSync(homeDir(), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Every place `url` is a VALUE in a JSON, JSON5, YAML or TOML file: after `:` or `=`, quoted or not,
 * and ending where the value ends. A mention in a comment or inside a longer string is left alone.
 */
function valuePattern(url: string): RegExp {
  return new RegExp(`([:=]\\s*)(["']?)${escape(url)}\\2(?=\\s*(?:[,}\\]\\r\\n#]|//|$))`, "g");
}

/** The exact strings in `text` that are values and that `cleanUrl` maps to `base`. */
function rawUrlsFor(text: string, base: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/https?:\/\/[^\s"',}\]#]+/g)) {
    const raw = match[0];
    if (cleanUrl(raw) === base && valuePattern(raw).test(text)) found.add(raw);
  }
  return [...found];
}

/** A name for an origin: its host, and its port when it has one. Two origins never share a name. */
function nameFor(origin: string, taken: Record<string, { origin: string }>): string {
  const url = new URL(origin);
  const base = `${url.hostname}${url.port ? `-${url.port}` : ""}`.replace(/[^A-Za-z0-9._-]/g, "-");
  let name = base;
  for (let n = 2; taken[name] && taken[name]!.origin !== origin; n += 1) name = `${base}-${n}`;
  return name;
}

export function planAttach(agents: Agent[], port: number, config: Config, now = new Date()): Plan {
  const plan: Plan = { changes: [], skipped: [] };
  const taken: Record<string, { origin: string }> = { ...(config.gateway?.attached ?? {}) };
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  for (const agent of agents) {
    if (!agent.protectable) {
      plan.skipped.push({ agent: agent.id, provider: "*", reason: "OpenGuardrails does not protect this agent" });
      continue;
    }
    for (const model of agent.models) {
      if (model.through_gateway) continue;
      if (!model.base_url) {
        plan.skipped.push({ agent: agent.id, provider: model.provider, reason: "it uses its built-in provider; give it a base URL to attach it" });
        continue;
      }
      if (!existsSync(model.declared_in)) {
        plan.skipped.push({ agent: agent.id, provider: model.provider, reason: `its base URL comes from ${model.declared_in}, which is not a file` });
        continue;
      }
      const text = readFileSync(model.declared_in, "utf8");
      const raws = rawUrlsFor(text, model.base_url);
      if (raws.length === 0) {
        plan.skipped.push({ agent: agent.id, provider: model.provider, reason: `its base URL is not written as a plain value in ${model.declared_in}` });
        continue;
      }
      for (const raw of raws) {
        if (plan.changes.some((change) => change.file === model.declared_in && change.from === raw)) continue;
        const url = new URL(raw);
        if (url.username || url.password) {
          plan.skipped.push({ agent: agent.id, provider: model.provider, reason: "its base URL carries credentials, which the gateway would not forward" });
          continue;
        }
        const name = nameFor(url.origin, taken);
        taken[name] = { origin: url.origin };
        const to = `http://127.0.0.1:${port}/u/${name}${url.pathname === "/" ? "" : url.pathname}${url.search}`;
        const backup = join(homeDir(), "backups", stamp, `${agent.id}-${basename(model.declared_in)}`);
        plan.changes.push({ agent: agent.id, file: model.declared_in, from: raw, to, name, backup, at: now.toISOString() });
      }
    }
  }
  return plan;
}

function replaceValues(text: string, from: string, to: string): string {
  return text.replace(valuePattern(from), (_whole, lead: string, quote: string) => `${lead}${quote}${to}${quote}`);
}

/** Applies a plan: back up, rewrite each file once, then record the origins and the changes. */
export function applyAttach(plan: Plan, config: Config): void {
  const byFile = new Map<string, Attachment[]>();
  for (const change of plan.changes) byFile.set(change.file, [...(byFile.get(change.file) ?? []), change]);
  for (const [file, changes] of byFile) {
    mkdirSync(join(changes[0]!.backup, ".."), { recursive: true, mode: 0o700 });
    copyFileSync(file, changes[0]!.backup);
    chmodSync(changes[0]!.backup, 0o600);
    let text = readFileSync(file, "utf8");
    for (const change of changes) text = replaceValues(text, change.from, change.to);
    const mode = statSync(file).mode & 0o777;
    const tmp = `${file}.openguardrails-${process.pid}`;
    writeFileSync(tmp, text, { mode });
    renameSync(tmp, file);
  }
  const gateway = config.gateway ?? { upstreams: {} };
  const attached = { ...(gateway.attached ?? {}) };
  for (const change of plan.changes) {
    const origin = new URL(change.from).origin;
    const entry = attached[change.name] ?? { origin, agents: [] };
    if (!entry.agents.includes(change.agent)) entry.agents.push(change.agent);
    attached[change.name] = entry;
  }
  writePrivate(configPath(), `${JSON.stringify({ ...config, gateway: { ...gateway, upstreams: gateway.upstreams ?? {}, attached } }, null, 2)}\n`);
  writePrivate(manifestPath(), `${JSON.stringify([...readManifest(), ...plan.changes], null, 2)}\n`);
}

/** Puts each agent's old base URLs back, value by value, and forgets the names nothing uses any more. */
export function detach(agentIds: string[] | "all", config: Config): Attachment[] {
  const manifest = readManifest();
  const undo = manifest.filter((entry) => agentIds === "all" || agentIds.includes(entry.agent));
  for (const entry of undo) {
    if (!existsSync(entry.file)) continue;
    const text = readFileSync(entry.file, "utf8");
    const restored = replaceValues(text, entry.to, entry.from);
    if (restored !== text) {
      const mode = statSync(entry.file).mode & 0o777;
      const tmp = `${entry.file}.openguardrails-${process.pid}`;
      writeFileSync(tmp, restored, { mode });
      renameSync(tmp, entry.file);
    }
  }
  const kept = manifest.filter((entry) => !undo.includes(entry));
  const used = new Set(kept.map((entry) => entry.name));
  const attached = Object.fromEntries(
    Object.entries(config.gateway?.attached ?? {})
      .filter(([name]) => used.has(name))
      .map(([name, entry]) => [name, { ...entry, agents: entry.agents.filter((agent) => kept.some((k) => k.name === name && k.agent === agent)) }]),
  );
  if (config.gateway) writePrivate(configPath(), `${JSON.stringify({ ...config, gateway: { ...config.gateway, attached } }, null, 2)}\n`);
  writePrivate(manifestPath(), `${JSON.stringify(kept, null, 2)}\n`);
  return undo;
}

export function selectAgents(agents: Agent[], wanted: string[] | "all"): { chosen: Agent[]; unknown: string[] } {
  if (wanted === "all") return { chosen: agents.filter((agent) => agent.protectable), unknown: [] };
  const chosen = agents.filter((agent) => wanted.includes(agent.id));
  return { chosen, unknown: wanted.filter((id) => !agents.some((agent) => agent.id === id)) };
}

export function attachCommand(args: string[], ctx?: ScanContext): { plan: Plan; unknown: string[] } {
  const config = loadConfig();
  const port = config.gateway?.port ?? DEFAULT_PORT;
  const wanted = args.includes("--all") ? "all" : args.filter((arg) => !arg.startsWith("--"));
  const inventory = scan(ctx);
  const { chosen, unknown } = selectAgents(inventory.agents, wanted);
  const plan = planAttach(chosen, port, config);
  if (!args.includes("--dry-run")) applyAttach(plan, config);
  return { plan, unknown };
}
