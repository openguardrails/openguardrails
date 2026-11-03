/**
 * One reader per agent. Each knows where its agent keeps the model's base URL, its MCP servers, its
 * skills and its plugins, as of the versions checked on 2026-11-03: Hermes, OpenClaw 2026.6,
 * OpenCode, Codex and DeepSeek Harness. An agent with neither a binary on PATH nor a config is absent.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { appData, endpoint, expandHome, isObj, mcpServer, onPath, pluginDirs, readConfig, secretFindings, skillsIn, str, strings, type Obj } from "./util.js";
import type { Agent, Component, Finding, ScanContext } from "./types.js";

export interface AgentScan {
  agent: Agent;
  findings: Finding[];
}

type Reader = (ctx: ScanContext) => AgentScan | null;

const present = (binary: string | undefined, files: string[]) => !!binary || files.some((file) => existsSync(file));

function mcpTable(table: unknown, file: string, ctx: ScanContext): Component[] {
  if (!isObj(table)) return [];
  return Object.entries(table)
    .filter((entry): entry is [string, Obj] => isObj(entry[1]))
    .map(([name, raw]) => mcpServer(name, raw, file, ctx));
}

/** Hermes: `~/.hermes/config.yaml`, skills grouped by category under `~/.hermes/skills`. */
const hermes: Reader = (ctx) => {
  const root = ctx.env.HERMES_HOME ?? join(ctx.home, ".hermes");
  const file = join(root, "config.yaml");
  const binary = onPath("hermes", ctx);
  if (!present(binary, [file])) return null;
  const config = readConfig(file);
  const cfg = isObj(config) ? config : {};
  const agent: Agent = { id: "hermes", name: "Hermes", kind: "personal", open_source: true, protectable: true, ...(binary ? { binary } : {}), config_files: existsSync(file) ? [file] : [], models: [], components: [] };
  const model = cfg.model;
  if (isObj(model)) agent.models.push(endpoint(str(model.provider) ?? "default", str(model.base_url), file, ctx));
  else if (typeof model === "string") agent.models.push(endpoint("default", undefined, file, ctx));
  const custom = cfg.custom_providers;
  const customList = Array.isArray(custom) ? custom : isObj(custom) ? Object.entries(custom).map(([name, value]) => (isObj(value) ? { name, ...value } : {})) : [];
  for (const provider of customList) {
    if (isObj(provider) && str(provider.base_url)) agent.models.push(endpoint(str(provider.name) ?? "custom", str(provider.base_url), file, ctx));
  }
  agent.components.push(...mcpTable(cfg.mcp_servers, file, ctx));
  agent.components.push(...skillsIn(join(root, "skills"), join(root, "skills")));
  const skills = isObj(cfg.skills) ? cfg.skills : {};
  for (const dir of strings(skills.external_dirs)) agent.components.push(...skillsIn(expandHome(dir, ctx), file));
  agent.components.push(...pluginDirs(join(root, "plugins"), join(root, "plugins")));
  return { agent, findings: secretFindings(config, agent.id, file) };
};

/** OpenClaw: `~/.openclaw/openclaw.json` (JSON5), `mcp.servers`, skills in the workspace and extra dirs. */
const openclaw: Reader = (ctx) => {
  const root = ctx.env.OPENCLAW_STATE_DIR ?? join(ctx.home, ".openclaw");
  const file = ctx.env.OPENCLAW_CONFIG_PATH ?? join(root, "openclaw.json");
  const binary = onPath("openclaw", ctx);
  if (!present(binary, [file])) return null;
  const config = readConfig(file);
  const cfg = isObj(config) ? config : {};
  const agent: Agent = { id: "openclaw", name: "OpenClaw", kind: "personal", open_source: true, protectable: true, ...(binary ? { binary } : {}), config_files: existsSync(file) ? [file] : [], models: [], components: [] };
  const models = isObj(cfg.models) ? cfg.models : {};
  if (isObj(models.providers)) {
    for (const [name, provider] of Object.entries(models.providers)) {
      if (isObj(provider)) agent.models.push(endpoint(name, str(provider.baseUrl) ?? str(provider.baseURL), file, ctx));
    }
  }
  const mcp = isObj(cfg.mcp) ? cfg.mcp : {};
  agent.components.push(...mcpTable(mcp.servers, file, ctx));
  const agents = isObj(cfg.agents) ? cfg.agents : {};
  const defaults = isObj(agents.defaults) ? agents.defaults : {};
  const workspace = str(defaults.workspace) ? expandHome(str(defaults.workspace)!, ctx) : join(root, "workspace");
  agent.components.push(...skillsIn(join(workspace, "skills"), join(workspace, "skills")));
  agent.components.push(...skillsIn(join(root, "skills"), join(root, "skills")));
  const skills = isObj(cfg.skills) ? cfg.skills : {};
  const load = isObj(skills.load) ? skills.load : {};
  for (const dir of strings(load.extraDirs)) agent.components.push(...skillsIn(expandHome(dir, ctx), file));
  const plugins = isObj(cfg.plugins) ? cfg.plugins : {};
  if (isObj(plugins.entries)) {
    for (const [name, entry] of Object.entries(plugins.entries)) {
      agent.components.push({ kind: "plugin", name, ...(isObj(entry) && entry.enabled === false ? { enabled: false } : {}), declared_in: file });
    }
  }
  return { agent, findings: secretFindings(config, agent.id, file) };
};

/** OpenCode: `~/.config/opencode/opencode.json(c)`, `mcp` with a command array, npm plugins. */
const opencode: Reader = (ctx) => {
  const root = join(ctx.env.XDG_CONFIG_HOME ?? join(ctx.home, ".config"), "opencode");
  const files = ["opencode.json", "opencode.jsonc"].map((name) => join(root, name));
  const binary = onPath("opencode", ctx);
  if (!present(binary, files)) return null;
  const agent: Agent = { id: "opencode", name: "OpenCode", kind: "coding", open_source: true, protectable: true, ...(binary ? { binary } : {}), config_files: files.filter((file) => existsSync(file)), models: [], components: [] };
  const findings: Finding[] = [];
  for (const file of agent.config_files) {
    const config = readConfig(file);
    const cfg = isObj(config) ? config : {};
    if (isObj(cfg.provider)) {
      for (const [name, provider] of Object.entries(cfg.provider)) {
        const options = isObj(provider) && isObj(provider.options) ? provider.options : {};
        agent.models.push(endpoint(name, str(options.baseURL), file, ctx));
      }
    }
    agent.components.push(...mcpTable(cfg.mcp, file, ctx));
    for (const spec of strings(cfg.plugin)) {
      const at = spec.lastIndexOf("@");
      const [name, version] = at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : [spec, undefined];
      agent.components.push({ kind: "plugin", name, package: { ecosystem: "npm", name, ...(version ? { version } : {}), pinned: !!version && /^\d+\.\d+\.\d+/.test(version) }, declared_in: file });
    }
    findings.push(...secretFindings(config, agent.id, file));
  }
  if (agent.models.length === 0 && agent.config_files.length > 0) agent.models.push(endpoint("default", undefined, agent.config_files[0]!, ctx));
  for (const dir of ["plugin", "plugins"]) agent.components.push(...pluginDirs(join(root, dir), join(root, dir)));
  for (const dir of ["skill", "skills"]) agent.components.push(...skillsIn(join(root, dir), join(root, dir)));
  return { agent, findings };
};

/** Codex: `~/.codex/config.toml`, `model_providers` and `mcp_servers`, skills under `~/.codex/skills`. */
const codex: Reader = (ctx) => {
  const root = ctx.env.CODEX_HOME ?? join(ctx.home, ".codex");
  const file = join(root, "config.toml");
  const binary = onPath("codex", ctx);
  if (!present(binary, [file])) return null;
  const config = readConfig(file);
  const cfg = isObj(config) ? config : {};
  const agent: Agent = { id: "codex", name: "Codex", kind: "coding", open_source: true, protectable: true, ...(binary ? { binary } : {}), config_files: existsSync(file) ? [file] : [], models: [], components: [] };
  const providers = isObj(cfg.model_providers) ? cfg.model_providers : {};
  const active = str(cfg.model_provider);
  for (const [name, provider] of Object.entries(providers)) {
    if (isObj(provider)) agent.models.push(endpoint(name, str(provider.base_url), file, ctx));
  }
  if (!active || !providers[active]) {
    // The built-in OpenAI provider, which OPENAI_BASE_URL can move.
    agent.models.push(endpoint(active ?? "openai", ctx.env.OPENAI_BASE_URL, ctx.env.OPENAI_BASE_URL ? "OPENAI_BASE_URL" : file, ctx));
  }
  agent.components.push(...mcpTable(cfg.mcp_servers, file, ctx));
  agent.components.push(...skillsIn(join(root, "skills"), join(root, "skills")));
  if (isObj(cfg.plugins)) {
    for (const [name, entry] of Object.entries(cfg.plugins)) {
      agent.components.push({ kind: "plugin", name, ...(isObj(entry) && entry.enabled === false ? { enabled: false } : {}), declared_in: file });
    }
  }
  return { agent, findings: secretFindings(config, agent.id, file) };
};

const DSH_MCP = "@deepseek-ai/dsh-mcp-client";

/** DeepSeek Harness: one profile per directory, each a list of cordis patch entries. */
const dsh: Reader = (ctx) => {
  const root = ctx.env.DSH_HOME ?? join(ctx.home, ".dsh");
  const profiles = join(root, "profiles");
  const binary = onPath("dsh", ctx);
  if (!present(binary, [profiles])) return null;
  const agent: Agent = { id: "deepseek-harness", name: "DeepSeek Harness", kind: "coding", open_source: true, protectable: true, ...(binary ? { binary } : {}), config_files: [], models: [], components: [] };
  const findings: Finding[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(profiles, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    // no profiles yet
  }
  for (const profile of names) {
    const file = join(profiles, profile, "cordis.patch.yml");
    if (!existsSync(file)) continue;
    agent.config_files.push(file);
    const config = readConfig(file);
    // An entry is a plugin by itself, or an `insert:` list of them.
    const entries = (Array.isArray(config) ? config : []).flatMap((entry) => (isObj(entry) && Array.isArray(entry.insert) ? entry.insert : [entry]));
    for (const entry of entries) {
      if (!isObj(entry)) continue;
      const entryConfig = isObj(entry.config) ? entry.config : {};
      if (entry.id === "llm-pi-ai" && isObj(entryConfig.providers)) {
        for (const [name, provider] of Object.entries(entryConfig.providers)) {
          if (isObj(provider)) agent.models.push(endpoint(`${profile}/${name}`, str(provider.baseURL), file, ctx));
        }
      }
      if (entry.name === DSH_MCP) {
        agent.components.push(mcpServer(`${profile}/${str(entryConfig.serverName) ?? str(entry.id) ?? "mcp"}`, entryConfig, file, ctx));
      } else if (str(entry.name)) {
        agent.components.push({ kind: "plugin", name: str(entry.name)!, declared_in: file });
      }
    }
    findings.push(...secretFindings(config, agent.id, file));
    const pkg = readConfig(join(profiles, profile, "package.json"));
    if (isObj(pkg) && isObj(pkg.dependencies)) {
      for (const [name, version] of Object.entries(pkg.dependencies)) {
        const spec = typeof version === "string" ? version : undefined;
        agent.components.push({ kind: "plugin", name, package: { ecosystem: "npm", name, ...(spec ? { version: spec } : {}), pinned: !!spec && /^\d+\.\d+\.\d+/.test(spec) }, declared_in: join(profiles, profile, "package.json") });
      }
    }
  }
  return { agent, findings };
};

// Listed only. A person should see every agent on the machine, but OpenGuardrails does not put these
// behind its gateway: Claude Code's own permissions are strong, and the others are closed apps or
// editors whose model settings are not a file we can safely rewrite.

/** Claude Code: MCP servers in `~/.claude.json` (global and per project), settings in `~/.claude/settings.json`. */
const claudeCode: Reader = (ctx) => {
  const state = join(ctx.home, ".claude.json");
  const root = ctx.env.CLAUDE_CONFIG_DIR ?? join(ctx.home, ".claude");
  const settingsFile = join(root, "settings.json");
  const binary = onPath("claude", ctx);
  if (!present(binary, [state, settingsFile])) return null;
  const agent: Agent = { id: "claude-code", name: "Claude Code", kind: "coding", open_source: false, protectable: false, ...(binary ? { binary } : {}), config_files: [state, settingsFile].filter((file) => existsSync(file)), models: [], components: [] };
  const findings: Finding[] = [];
  const settings = readConfig(settingsFile);
  const settingsObj = isObj(settings) ? settings : {};
  const env = isObj(settingsObj.env) ? settingsObj.env : {};
  const base = str(env.ANTHROPIC_BASE_URL) ?? ctx.env.ANTHROPIC_BASE_URL;
  agent.models.push(endpoint("anthropic", base, str(env.ANTHROPIC_BASE_URL) ? settingsFile : base ? "ANTHROPIC_BASE_URL" : settingsFile, ctx));
  if (settings !== undefined) findings.push(...secretFindings({ env: settingsObj.env }, agent.id, settingsFile));
  const stateObj = readConfig(state);
  if (isObj(stateObj)) {
    agent.components.push(...mcpTable(stateObj.mcpServers, state, ctx));
    findings.push(...secretFindings({ mcpServers: stateObj.mcpServers }, agent.id, state));
    if (isObj(stateObj.projects)) {
      for (const [project, entry] of Object.entries(stateObj.projects)) {
        if (!isObj(entry) || !isObj(entry.mcpServers)) continue;
        for (const server of mcpTable(entry.mcpServers, state, ctx)) agent.components.push({ ...server, name: `${project}: ${server.name}` });
        findings.push(...secretFindings({ projects: { [project]: { mcpServers: entry.mcpServers } } }, agent.id, state));
      }
    }
  }
  agent.components.push(...skillsIn(join(root, "skills"), join(root, "skills")));
  if (isObj(settingsObj.enabledPlugins)) {
    for (const [name, on] of Object.entries(settingsObj.enabledPlugins)) agent.components.push({ kind: "plugin", name, ...(on === false ? { enabled: false } : {}), declared_in: settingsFile });
  }
  const installed = readConfig(join(root, "plugins", "installed_plugins.json"));
  if (isObj(installed) && isObj(installed.plugins)) {
    for (const name of Object.keys(installed.plugins)) {
      if (!agent.components.some((c) => c.kind === "plugin" && c.name === name)) agent.components.push({ kind: "plugin", name, declared_in: join(root, "plugins", "installed_plugins.json") });
    }
  }
  return { agent, findings };
};

/** Gemini CLI: `~/.gemini/settings.json`, and extensions that can bring MCP servers of their own. */
const gemini: Reader = (ctx) => {
  const root = join(ctx.home, ".gemini");
  const file = join(root, "settings.json");
  const binary = onPath("gemini", ctx);
  if (!present(binary, [file])) return null;
  const agent: Agent = { id: "gemini-cli", name: "Gemini CLI", kind: "coding", open_source: true, protectable: false, ...(binary ? { binary } : {}), config_files: existsSync(file) ? [file] : [], models: [], components: [] };
  const config = readConfig(file);
  const cfg = isObj(config) ? config : {};
  agent.models.push(endpoint("google", ctx.env.GOOGLE_GEMINI_BASE_URL, ctx.env.GOOGLE_GEMINI_BASE_URL ? "GOOGLE_GEMINI_BASE_URL" : file, ctx));
  agent.components.push(...mcpTable(cfg.mcpServers, file, ctx));
  const findings = config === undefined ? [] : secretFindings({ mcpServers: cfg.mcpServers }, agent.id, file);
  for (const extension of pluginDirs(join(root, "extensions"), join(root, "extensions"))) {
    agent.components.push(extension);
    const manifest = join(extension.path!, "gemini-extension.json");
    const ext = readConfig(manifest);
    if (!isObj(ext)) continue;
    for (const server of mcpTable(ext.mcpServers, manifest, ctx)) agent.components.push({ ...server, name: `${extension.name}: ${server.name}` });
    findings.push(...secretFindings({ mcpServers: ext.mcpServers }, agent.id, manifest));
  }
  return { agent, findings };
};

/** An app whose only readable footprint is an MCP file: Cursor, Claude Desktop, VS Code, Windsurf. */
function mcpOnly(spec: { id: string; name: string; kind: "personal" | "coding"; openSource: boolean; binary?: string; file: (ctx: ScanContext) => string; table: string; apps?: string[] }): Reader {
  return (ctx) => {
    const file = spec.file(ctx);
    const binary = spec.binary ? onPath(spec.binary, ctx) : undefined;
    const app = ctx.platform === "darwin" ? (spec.apps ?? []).find((path) => existsSync(path)) : undefined;
    if (!present(binary ?? app, [file])) return null;
    const agent: Agent = { id: spec.id, name: spec.name, kind: spec.kind, open_source: spec.openSource, protectable: false, ...(binary ? { binary } : {}), config_files: existsSync(file) ? [file] : [], models: [], components: [] };
    const config = readConfig(file);
    const cfg = isObj(config) ? config : {};
    agent.components.push(...mcpTable(cfg[spec.table], file, ctx));
    return { agent, findings: config === undefined ? [] : secretFindings({ [spec.table]: cfg[spec.table] }, agent.id, file) };
  };
}

const cursor = mcpOnly({ id: "cursor", name: "Cursor", kind: "coding", openSource: false, binary: "cursor-agent", file: (ctx) => join(ctx.home, ".cursor", "mcp.json"), table: "mcpServers", apps: ["/Applications/Cursor.app"] });
const claudeDesktop = mcpOnly({ id: "claude-desktop", name: "Claude Desktop", kind: "personal", openSource: false, file: (ctx) => join(appData(ctx), "Claude", "claude_desktop_config.json"), table: "mcpServers", apps: ["/Applications/Claude.app"] });
const vscode = mcpOnly({ id: "vscode", name: "VS Code (Copilot and other extensions)", kind: "coding", openSource: false, binary: "code", file: (ctx) => join(appData(ctx), "Code", "User", "mcp.json"), table: "servers", apps: ["/Applications/Visual Studio Code.app"] });
const windsurf = mcpOnly({ id: "windsurf", name: "Windsurf", kind: "coding", openSource: false, file: (ctx) => join(ctx.home, ".codeium", "windsurf", "mcp_config.json"), table: "mcpServers", apps: ["/Applications/Windsurf.app"] });

/** The agents OpenGuardrails protects come first, then the ones it only lists. */
export const READERS: Reader[] = [openclaw, hermes, opencode, codex, dsh, claudeCode, gemini, cursor, claudeDesktop, vscode, windsurf];
