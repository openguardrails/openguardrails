/** ~/.openguardrails/config.json: the upstreams, the routes, the AIRS connection and sandbox defaults. */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Upstream {
  baseURL: string;
  /** The model name this upstream knows. Replaces whatever the client asked for. */
  model: string;
  /** The name of an environment variable holding the key. Preferred over `apiKey`. */
  apiKeyEnv?: string;
  apiKey?: string;
  /** Renames chat_template_kwargs, for models whose templates spell a switch differently. */
  renameTemplateKwargs?: Record<string, string>;
}

export interface Config {
  gateway?: {
    port?: number;
    upstreams: Record<string, Upstream>;
    /** A model name clients can ask for, and the upstreams to try, in order. */
    routes?: Record<string, string[]>;
    /** How long a failed upstream is skipped. */
    cooldownMs?: number;
    connectTimeoutMs?: number;
    /** A shared vLLM can queue a request for minutes before the first byte. */
    firstByteTimeoutMs?: number;
  };
  /** The OpenGuardrails Model API. With no key anywhere, what the rules cannot decide goes unjudged. */
  model?: {
    url?: string;
    apiKeyEnv?: string;
    apiKey?: string;
    model?: string;
    timeoutMs?: number;
    /** When the model cannot answer. `closed`, the default, refuses the action and says it can be retried. */
    failMode?: "open" | "closed";
  };
  /** Absolute directories the agent works in. Relative paths are taken as inside. */
  workspaces?: string[];
  airs?: { url: string; apiKeyEnv?: string; apiKey?: string; agentId?: string; agentWorkspace?: string; failMode?: "open" | "closed"; requestTimeoutMs?: number };
  sandbox?: { allowHosts?: string[]; denyHosts?: string[]; allowRead?: string[]; allowWrite?: string[]; allowLocalBinding?: boolean };
}

export const homeDir = () => process.env.OPENGUARDRAILS_HOME ?? join(homedir(), ".openguardrails");
export const configPath = () => join(homeDir(), "config.json");
export const DEFAULT_PORT = 4180;

export function loadConfig(): Config {
  const path = configPath();
  if (!existsSync(path)) return {};
  const config = JSON.parse(readFileSync(path, "utf8")) as Config;
  return validate(config);
}

/** Refuses a broken config: a typo here must not become traffic that only looks routed. */
export function validate(config: Config): Config {
  const gateway = config.gateway;
  if (!gateway) return config;
  for (const [name, upstream] of Object.entries(gateway.upstreams ?? {})) {
    if (!upstream.baseURL || !upstream.model) throw new Error(`config: upstream "${name}" needs baseURL and model`);
    new URL(upstream.baseURL);
  }
  for (const [name, members] of Object.entries(gateway.routes ?? {})) {
    if (members.length === 0) throw new Error(`config: route "${name}" is empty`);
    for (const member of members) {
      if (!gateway.upstreams?.[member]) throw new Error(`config: route "${name}" names unknown upstream "${member}"`);
    }
  }
  return config;
}

export function secretOf(holder: { apiKeyEnv?: string; apiKey?: string }, env = process.env): string | undefined {
  return (holder.apiKeyEnv ? env[holder.apiKeyEnv] : undefined) ?? holder.apiKey;
}

/** A readable config file with a key in it is the leak this tool exists to prevent. */
export function looseConfigWarning(config: Config): string | null {
  const inline = config.airs?.apiKey || config.model?.apiKey || Object.values(config.gateway?.upstreams ?? {}).some((upstream) => upstream.apiKey);
  if (!inline || process.platform === "win32") return null;
  return (statSync(configPath()).mode & 0o077) === 0 ? null : `${configPath()} holds keys and is readable by others. Run: chmod 600 ${configPath()}`;
}

/** The environment variables that hold this config's keys, which no sandboxed process may inherit. */
export const keyEnvNames = (config: Config): string[] =>
  [config.airs?.apiKeyEnv, config.model?.apiKeyEnv, "OPENGUARDRAILS_API_KEY", ...Object.values(config.gateway?.upstreams ?? {}).map((upstream) => upstream.apiKeyEnv)].filter((name): name is string => Boolean(name));

/** The upstreams to try for a requested model: a route, one upstream by name, or null. */
export function resolveRoute(gateway: NonNullable<Config["gateway"]>, model: unknown): string[] | null {
  if (typeof model !== "string") return null;
  if (gateway.routes?.[model]) return gateway.routes[model]!;
  return gateway.upstreams[model] ? [model] : null;
}
