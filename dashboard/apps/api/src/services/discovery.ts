import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";

export interface DiscoveredAgent {
  id: string;
  name: string;
  emoji: string;
  creature: string;
  vibe: string;
  model: string;
  provider: string;
  workspacePath: string;
  ownerName: string;
  avatarUrl: string | null;
  skills: { name: string; description?: string }[];
  connectedSystems: string[];
  channels: string[];
  plugins: { name: string; enabled: boolean }[];
  hooks: { name: string; enabled: boolean }[];
  sessionCount: number;
  lastActive: string | null;
}

export interface AgentSkill {
  name: string;
  description?: string;
  emoji?: string;
  source: "system" | "workspace";
}

export interface CronJob {
  id?: string;
  schedule?: string;
  task?: string;
  enabled?: boolean;
}

export interface BundledExtension {
  name: string;
  description: string;
  channels: string[];
}

export interface AgentProfile extends DiscoveredAgent {
  workspaceFiles: {
    soul: string;
    identity: string;
    user: string;
    agents: string;
    tools: string;
    heartbeat: string;
  };
  bootstrapExists: boolean;
  cronJobs: CronJob[];
  allSkills: AgentSkill[];
  bundledExtensions: BundledExtension[];
}

const OPENCLAW_DIR = join(homedir(), ".openclaw");

function readJsonSafe(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function readFileSafe(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

function parseOwnerName(workspacePath: string): string {
  const content = readFileSafe(join(workspacePath, "USER.md"));
  if (!content) return "";
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    // Handle "- **Name:** value" (bullet + bold markdown)
    const bulletBold = trimmed.match(/^[-*]\s+\*\*name:\*\*\s*(.*)/i);
    if (bulletBold) {
      const val = bulletBold[1].trim();
      if (val) return val;
      continue;
    }
    // Handle "**Name:** value" or "Name: value"
    const plain = trimmed.match(/^\*?\*?name\*?\*?:\s*(.*)/i);
    if (plain) {
      const val = plain[1].replace(/^\*?\*?\s*/, "").trim();
      if (val) return val;
    }
  }
  return "";
}

const AVATAR_EXTENSIONS = ["png", "jpg", "jpeg", "svg", "webp"];

function discoverAvatar(workspacePath: string): string | null {
  for (const ext of AVATAR_EXTENSIONS) {
    if (existsSync(join(workspacePath, `avatar.${ext}`))) {
      return ext;
    }
  }
  return null;
}

function parseIdentityMd(content: string): { name: string; emoji: string; creature: string; vibe: string } {
  const result = { name: "", emoji: "", creature: "", vibe: "" };
  const lines = content.split("\n");
  let currentKey = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- **Name:**")) {
      currentKey = "name";
      const inline = trimmed.replace("- **Name:**", "").trim();
      if (inline) result.name = inline;
    } else if (trimmed.startsWith("- **Creature:**")) {
      currentKey = "creature";
      const inline = trimmed.replace("- **Creature:**", "").trim();
      if (inline) result.creature = inline;
    } else if (trimmed.startsWith("- **Vibe:**")) {
      currentKey = "vibe";
      const inline = trimmed.replace("- **Vibe:**", "").trim();
      if (inline) result.vibe = inline;
    } else if (trimmed.startsWith("- **Emoji:**")) {
      currentKey = "emoji";
      const inline = trimmed.replace("- **Emoji:**", "").trim();
      if (inline) result.emoji = inline;
    } else if (trimmed.startsWith("- **") || trimmed.startsWith("---") || trimmed.startsWith("#")) {
      currentKey = "";
    } else if (currentKey && trimmed) {
      const key = currentKey as keyof typeof result;
      if (!result[key]) result[key] = trimmed;
    }
  }

  return result;
}

function countSessions(agentDir: string): { count: number; lastActive: string | null } {
  const sessionsDir = join(agentDir, "sessions");
  if (!existsSync(sessionsDir)) return { count: 0, lastActive: null };

  const sessionsFile = join(sessionsDir, "sessions.json");
  const sessionsData = readJsonSafe(sessionsFile) as Record<string, { updatedAt?: number }> | null;

  if (!sessionsData) return { count: 0, lastActive: null };

  let latestTs = 0;
  let count = 0;
  for (const value of Object.values(sessionsData)) {
    count++;
    if (typeof value === "object" && value && typeof value.updatedAt === "number") {
      if (value.updatedAt > latestTs) latestTs = value.updatedAt;
    }
  }

  return {
    count,
    lastActive: latestTs ? new Date(latestTs).toISOString() : null,
  };
}

function discoverSkills(workspacePath: string): { name: string; description?: string }[] {
  const skillsDir = join(workspacePath, "skills");
  if (!existsSync(skillsDir)) return [];

  try {
    return readdirSync(skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const metaPath = join(skillsDir, d.name, "_meta.json");
        const meta = readJsonSafe(metaPath) as { description?: string } | null;
        return { name: d.name, description: meta?.description };
      });
  } catch {
    return [];
  }
}

function discoverCredentials(): string[] {
  const credsDir = join(OPENCLAW_DIR, "credentials");
  if (!existsSync(credsDir)) return [];

  try {
    return readdirSync(credsDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => basename(f, ".json"));
  } catch {
    return [];
  }
}

export function scanAgents(): DiscoveredAgent[] {
  if (!existsSync(OPENCLAW_DIR)) return [];

  const config = readJsonSafe(join(OPENCLAW_DIR, "openclaw.json")) as Record<string, unknown> | null;
  if (!config) return [];

  const agentsConfig = config.agents as { defaults?: { model?: { primary?: string }; workspace?: string } } | undefined;
  const pluginsConfig = config.plugins as { entries?: Record<string, { enabled?: boolean }> } | undefined;
  const hooksConfig = config.hooks as { internal?: { entries?: Record<string, { enabled?: boolean }> } } | undefined;
  const gatewayConfig = config.gateway as { port?: number } | undefined;

  const defaultModel = agentsConfig?.defaults?.model?.primary || "unknown";
  const workspacePath = agentsConfig?.defaults?.workspace || join(OPENCLAW_DIR, "workspace");

  // Parse model string like "openai-codex/gpt-5.3-codex"
  const [provider, model] = defaultModel.includes("/")
    ? defaultModel.split("/", 2)
    : ["unknown", defaultModel];

  // Read identity
  const identityContent = readFileSafe(join(workspacePath, "IDENTITY.md"));
  const identity = parseIdentityMd(identityContent);

  // Discover skills
  const skills = discoverSkills(workspacePath);

  // Connected systems (credentials)
  const connectedSystems = discoverCredentials();

  // Channels — derive from session data
  const channels: string[] = [];
  const agentsDir = join(OPENCLAW_DIR, "agents");
  if (existsSync(agentsDir)) {
    try {
      const agentDirs = readdirSync(agentsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
      for (const agentDir of agentDirs) {
        const sessionsFile = join(agentsDir, agentDir.name, "sessions", "sessions.json");
        const sessionsData = readJsonSafe(sessionsFile) as Record<string, { lastChannel?: string }> | null;
        if (sessionsData) {
          for (const value of Object.values(sessionsData)) {
            if (typeof value === "object" && value && typeof value.lastChannel === "string") {
              if (!channels.includes(value.lastChannel)) {
                channels.push(value.lastChannel);
              }
            }
          }
        }
      }
    } catch { /* ignore */ }
  }

  // Plugins
  const plugins: { name: string; enabled: boolean }[] = [];
  if (pluginsConfig?.entries) {
    for (const [name, entry] of Object.entries(pluginsConfig.entries)) {
      plugins.push({ name, enabled: entry?.enabled !== false });
    }
  }

  // Hooks
  const hooks: { name: string; enabled: boolean }[] = [];
  if (hooksConfig?.internal?.entries) {
    for (const [name, entry] of Object.entries(hooksConfig.internal.entries)) {
      hooks.push({ name, enabled: entry?.enabled !== false });
    }
  }

  // Count sessions across all agent dirs
  let totalSessions = 0;
  let lastActive: string | null = null;

  if (existsSync(agentsDir)) {
    try {
      for (const dir of readdirSync(agentsDir, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        const result = countSessions(join(agentsDir, dir.name));
        totalSessions += result.count;
        if (result.lastActive && (!lastActive || result.lastActive > lastActive)) {
          lastActive = result.lastActive;
        }
      }
    } catch { /* ignore */ }
  }

  const ownerName = parseOwnerName(workspacePath);
  const avatarExt = discoverAvatar(workspacePath);

  const agent: DiscoveredAgent = {
    id: "main",
    name: identity.name || "Agent",
    emoji: identity.emoji || "🤖",
    creature: identity.creature || "",
    vibe: identity.vibe || "",
    model,
    provider,
    workspacePath,
    ownerName,
    avatarUrl: avatarExt ? `/api/discovery/agents/main/avatar` : null,
    skills,
    connectedSystems,
    channels,
    plugins,
    hooks,
    sessionCount: totalSessions,
    lastActive,
  };

  // Check for additional agent directories
  const agents: DiscoveredAgent[] = [agent];

  if (existsSync(agentsDir)) {
    try {
      for (const dir of readdirSync(agentsDir, { withFileTypes: true })) {
        if (!dir.isDirectory() || dir.name === "main") continue;

        const agentPath = join(agentsDir, dir.name);
        const sessionInfo = countSessions(agentPath);

        agents.push({
          id: dir.name,
          name: dir.name,
          emoji: "🤖",
          creature: "",
          vibe: "",
          model,
          provider,
          workspacePath: agentPath,
          ownerName: "",
          avatarUrl: null,
          skills: [],
          connectedSystems: [],
          channels: [],
          plugins: [],
          hooks: [],
          sessionCount: sessionInfo.count,
          lastActive: sessionInfo.lastActive,
        });
      }
    } catch { /* ignore */ }
  }

  return agents;
}

export function getAgent(id: string): DiscoveredAgent | undefined {
  const agents = scanAgents();
  return agents.find((a) => a.id === id);
}

// ---- Profile enrichment ----

function parseFrontmatter(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!content.startsWith("---")) return result;
  const end = content.indexOf("---", 3);
  if (end === -1) return result;
  const block = content.slice(3, end);

  for (const line of block.split("\n")) {
    const match = line.match(/^(\w[\w\s]*):\s*(.+)/);
    if (match) {
      const key = match[1].trim().toLowerCase();
      let val = match[2].trim();
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      result[key] = val;
    }
  }

  // Try to extract nested emoji from metadata block
  const emojiMatch = block.match(/emoji:\s*["']?([^\n"']+)["']?/);
  if (emojiMatch) result["emoji"] = emojiMatch[1].trim();

  return result;
}

let _openclawRoot: string | null | undefined = undefined;

function resolveOpenclawRoot(): string | null {
  if (_openclawRoot !== undefined) return _openclawRoot;

  // Try env var first
  if (process.env.OPENCLAW_SKILLS_PATH) {
    _openclawRoot = process.env.OPENCLAW_SKILLS_PATH;
    return _openclawRoot;
  }

  try {
    const bin = execSync("which openclaw", { encoding: "utf-8", timeout: 5000 }).trim();
    if (bin) {
      // Binary is at <prefix>/bin/openclaw
      const binDir = dirname(bin);

      // Standard global install: <prefix>/bin/openclaw → <prefix>/lib/node_modules/openclaw
      // Covers nvm, volta, fnm, homebrew node, system node
      const globalPkg = join(binDir, "..", "lib", "node_modules", "openclaw");
      if (existsSync(join(globalPkg, "skills"))) {
        _openclawRoot = globalPkg;
        return _openclawRoot;
      }

      // Sibling layout: <pkg>/bin/openclaw → <pkg>/skills
      if (existsSync(join(binDir, "..", "skills"))) {
        _openclawRoot = join(binDir, "..");
        return _openclawRoot;
      }

      // node_modules/.bin symlink: node_modules/.bin/openclaw → node_modules/openclaw
      const parentDir = dirname(binDir);
      if (existsSync(join(parentDir, "openclaw", "skills"))) {
        _openclawRoot = join(parentDir, "openclaw");
        return _openclawRoot;
      }
    }
  } catch {
    // which not found or timeout
  }

  // Fallback: common locations
  const candidates = [
    join(homedir(), ".openclaw", "node_modules", "openclaw"),
    "/usr/local/lib/node_modules/openclaw",
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "skills"))) {
      _openclawRoot = c;
      return _openclawRoot;
    }
  }

  _openclawRoot = null;
  return null;
}

function discoverSystemSkills(): AgentSkill[] {
  const root = resolveOpenclawRoot();
  if (!root) return [];

  const skillsDir = join(root, "skills");
  if (!existsSync(skillsDir)) return [];

  try {
    return readdirSync(skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const skillMd = readFileSafe(join(skillsDir, d.name, "SKILL.md"));
        const fm = parseFrontmatter(skillMd);
        return {
          name: fm["name"] || d.name,
          description: fm["description"],
          emoji: fm["emoji"],
          source: "system" as const,
        };
      });
  } catch {
    return [];
  }
}

function discoverWorkspaceSkillsEnriched(workspacePath: string): AgentSkill[] {
  const skillsDir = join(workspacePath, "skills");
  if (!existsSync(skillsDir)) return [];

  try {
    return readdirSync(skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        // Try SKILL.md frontmatter first, fall back to _meta.json
        const skillMd = readFileSafe(join(skillsDir, d.name, "SKILL.md"));
        const fm = parseFrontmatter(skillMd);
        const meta = readJsonSafe(join(skillsDir, d.name, "_meta.json")) as { description?: string } | null;
        return {
          name: fm["name"] || d.name,
          description: fm["description"] || meta?.description,
          emoji: fm["emoji"],
          source: "workspace" as const,
        };
      });
  } catch {
    return [];
  }
}

function discoverSystemExtensions(): BundledExtension[] {
  const root = resolveOpenclawRoot();
  if (!root) return [];

  const extDir = join(root, "extensions");
  if (!existsSync(extDir)) return [];

  try {
    return readdirSync(extDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const pluginJson = readJsonSafe(join(extDir, d.name, "openclaw.plugin.json")) as {
          id?: string;
          channels?: string[];
        } | null;
        const pkgJson = readJsonSafe(join(extDir, d.name, "package.json")) as {
          description?: string;
        } | null;
        return {
          name: pluginJson?.id || d.name,
          description: pkgJson?.description || "",
          channels: pluginJson?.channels || [],
        };
      });
  } catch {
    return [];
  }
}

export function getAgentProfile(id: string): AgentProfile | undefined {
  const agent = getAgent(id);
  if (!agent) return undefined;

  const wp = agent.workspacePath;

  // Read workspace MD files
  const workspaceFiles = {
    soul: readFileSafe(join(wp, "SOUL.md")),
    identity: readFileSafe(join(wp, "IDENTITY.md")),
    user: readFileSafe(join(wp, "USER.md")),
    agents: readFileSafe(join(wp, "AGENTS.md")),
    tools: readFileSafe(join(wp, "TOOLS.md")),
    heartbeat: readFileSafe(join(wp, "HEARTBEAT.md")),
  };

  // Bootstrap existence
  const bootstrapExists = existsSync(join(wp, "BOOTSTRAP.md"));

  // Cron jobs
  let cronJobs: CronJob[] = [];
  const cronPath = join(OPENCLAW_DIR, "cron", "jobs.json");
  try {
    const raw = readFileSafe(cronPath);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        cronJobs = parsed;
      } else if (typeof parsed === "object" && parsed !== null) {
        // Handle { jobs: [...] } shape
        cronJobs = parsed.jobs || Object.values(parsed);
      }
    }
  } catch {
    // ignore
  }

  // Combine system + workspace skills
  const systemSkills = discoverSystemSkills();
  const workspaceSkills = discoverWorkspaceSkillsEnriched(wp);
  const allSkills = [...systemSkills, ...workspaceSkills];

  // Bundled extensions
  const bundledExtensions = discoverSystemExtensions();

  return {
    ...agent,
    workspaceFiles,
    bootstrapExists,
    cronJobs,
    allSkills,
    bundledExtensions,
  };
}
