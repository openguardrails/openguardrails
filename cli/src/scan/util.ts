/** Reading agent configs without ever copying a secret out of them. */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, relative } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { compiledRules } from "../secrets/mask.js";
import { ruleSpans } from "../redaction/ruleset.js";
import type { Component, Finding, ModelEndpoint, PackageRef, ScanContext } from "./types.js";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Obj = { [key: string]: Json };

export const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
export const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
export const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

export function expandHome(path: string, ctx: ScanContext): string {
  if (path === "~") return ctx.home;
  if (path.startsWith("~/")) return join(ctx.home, path.slice(2));
  return path;
}

/** JSON that tolerates comments and trailing commas, as JSONC and JSON5 configs use them. */
export function parseLooseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    let out = "";
    let inString = false;
    for (let i = 0; i < text.length; i += 1) {
      const c = text[i]!;
      if (inString) {
        out += c;
        if (c === "\\") out += text[++i] ?? "";
        else if (c === '"') inString = false;
      } else if (c === '"') {
        inString = true;
        out += c;
      } else if (c === "/" && text[i + 1] === "/") {
        while (i < text.length && text[i] !== "\n") i += 1;
        out += "\n";
      } else if (c === "/" && text[i + 1] === "*") {
        i = text.indexOf("*/", i + 2);
        if (i < 0) break;
        i += 1;
      } else out += c;
    }
    return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
  }
}

/** A config file, parsed by its extension. A file that is missing or does not parse is `undefined`. */
export function readConfig(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    const text = readFileSync(path, "utf8");
    if (path.endsWith(".toml")) return parseToml(text);
    if (path.endsWith(".yaml") || path.endsWith(".yml")) return parseYaml(text);
    return parseLooseJson(text);
  } catch {
    return undefined;
  }
}

export function onPath(name: string, ctx: ScanContext): string | undefined {
  for (const dir of (ctx.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return undefined;
}

/** Scheme, host, port and path. A URL that names credentials or a query keeps neither. */
export function cleanUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return undefined;
  }
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
export function throughGateway(raw: string | undefined, ctx: ScanContext): boolean {
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return LOOPBACK.has(url.hostname) && Number(url.port || (url.protocol === "https:" ? 443 : 80)) === ctx.gatewayPort;
  } catch {
    return false;
  }
}

export function endpoint(provider: string, raw: string | undefined, declaredIn: string, ctx: ScanContext): ModelEndpoint {
  const base = raw ? cleanUrl(raw) : undefined;
  return { provider, ...(base ? { base_url: base } : {}), through_gateway: throughGateway(raw, ctx), declared_in: declaredIn };
}

const EXACT_SEMVER = /^v?\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/;

function npmSpec(spec: string): PackageRef {
  const at = spec.lastIndexOf("@");
  const [name, version] = at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : [spec, undefined];
  return { ecosystem: "npm", name, ...(version ? { version } : {}), pinned: !!version && EXACT_SEMVER.test(version) };
}

function pypiSpec(spec: string): PackageRef {
  const match = /^([A-Za-z0-9_.\[\]-]+)\s*(==|>=|<=|~=|>|<)?\s*([^\s;]*)/.exec(spec);
  const name = match?.[1] ?? spec;
  const op = match?.[2];
  const version = match?.[3] || undefined;
  return { ecosystem: "pypi", name, ...(version ? { version } : {}), pinned: op === "==" && !!version };
}

/**
 * The package a stdio MCP server runs, read from how it is started. Only launchers that fetch a
 * package are understood; anything else is a local program and has no package.
 */
export function packageOf(command: string, args: string[]): PackageRef | undefined {
  const base = command.split(/[\\/]/).pop()!.replace(/\.(cmd|exe)$/i, "");
  const positional = (list: string[], valued: string[]) => {
    for (let i = 0; i < list.length; i += 1) {
      const arg = list[i]!;
      if (valued.includes(arg)) {
        i += 1;
        continue;
      }
      if (!arg.startsWith("-")) return { arg, rest: list.slice(i + 1) };
    }
    return undefined;
  };
  if (base === "npx" || base === "bunx") {
    const pkgFlag = args.findIndex((arg) => arg === "-p" || arg === "--package");
    if (pkgFlag >= 0 && args[pkgFlag + 1]) return npmSpec(args[pkgFlag + 1]!);
    const found = positional(args, ["--registry", "--cache"]);
    return found ? npmSpec(found.arg) : undefined;
  }
  if ((base === "pnpm" || base === "yarn") && args[0] === "dlx") {
    const found = positional(args.slice(1), []);
    return found ? npmSpec(found.arg) : undefined;
  }
  if (base === "uvx" || (base === "uv" && args[0] === "tool" && args[1] === "run") || (base === "pipx" && args[0] === "run")) {
    const list = base === "uvx" ? args : args.slice(base === "uv" ? 2 : 1);
    const from = list.findIndex((arg) => arg === "--from" || arg === "--spec");
    if (from >= 0 && list[from + 1]) return pypiSpec(list[from + 1]!);
    const found = positional(list, ["--python", "--with", "--index-url", "--index"]);
    return found ? pypiSpec(found.arg) : undefined;
  }
  if (base === "docker" || base === "podman") {
    const run = args.indexOf("run");
    if (run < 0) return undefined;
    const found = positional(args.slice(run + 1), ["-e", "--env", "-v", "--volume", "--name", "--network", "-p", "--publish", "--env-file", "-w", "--workdir", "--entrypoint", "-u", "--user"]);
    if (!found) return undefined;
    const image = found.arg;
    const digest = image.includes("@sha256:");
    const colon = image.lastIndexOf(":");
    const tag = !digest && colon > image.lastIndexOf("/") ? image.slice(colon + 1) : undefined;
    const name = digest ? image.slice(0, image.indexOf("@")) : tag ? image.slice(0, colon) : image;
    return { ecosystem: "docker", name, ...(tag ? { version: tag } : digest ? { version: image.slice(image.indexOf("@") + 1) } : {}), pinned: digest };
  }
  return undefined;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "__pycache__", ".venv", "venv"]);
const HASH_LIMIT = 8 * 1024 * 1024;

/** sha256 over a file, or over a directory's relative paths and contents, in a stable order. */
export function hashPath(path: string): string | undefined {
  try {
    const stat = statSync(path);
    const hash = createHash("sha256");
    if (stat.isFile()) {
      if (stat.size > HASH_LIMIT) return undefined;
      return hash.update(readFileSync(path)).digest("hex");
    }
    let total = 0;
    const walk = (dir: string): boolean => {
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!walk(full)) return false;
        } else if (entry.isFile()) {
          total += statSync(full).size;
          if (total > HASH_LIMIT) return false;
          hash.update(relative(path, full)).update("\0").update(readFileSync(full)).update("\0");
        }
      }
      return true;
    };
    return walk(path) ? hash.digest("hex") : undefined;
  } catch {
    return undefined;
  }
}

/** Every directory under `root` holding a SKILL.md, however deeply skills are grouped. */
export function skillsIn(root: string, declaredIn: string): Component[] {
  if (!existsSync(root)) return [];
  const found: Component[] = [];
  const walk = (dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
      const sha = hashPath(dir);
      found.push({ kind: "skill", name: relative(root, dir) || dir.split(/[\\/]/).pop()!, path: dir, ...(sha ? { sha256: sha } : {}), declared_in: declaredIn });
      return;
    }
    if (depth >= 3) return;
    for (const entry of entries) {
      if ((entry.isDirectory() || entry.isSymbolicLink()) && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) walk(join(dir, entry.name), depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

/** Plugins installed as directories, one per entry. */
export function pluginDirs(root: string, declaredIn: string): Component[] {
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith("."))
      .map((entry) => {
        const path = join(root, entry.name);
        const sha = hashPath(path);
        return { kind: "plugin" as const, name: entry.name, path, ...(sha ? { sha256: sha } : {}), declared_in: declaredIn };
      });
  } catch {
    return [];
  }
}

/** One MCP server from the shapes the agents use: command + args, a command array, or a URL. */
export function mcpServer(name: string, raw: Obj, declaredIn: string, ctx: ScanContext): Component {
  const commandList = Array.isArray(raw.command) ? strings(raw.command) : [];
  const command = commandList[0] ?? str(raw.command);
  const args = commandList.length > 0 ? commandList.slice(1) : strings(raw.args);
  const url = str(raw.url) ?? str(raw.serverUrl) ?? str(raw.httpUrl);
  if (command) {
    const pkg = packageOf(command, args);
    const script = args.find((arg) => /\.(m?js|cjs|ts|py)$/.test(arg));
    const scriptPath = script ? (isAbsolute(script) ? script : expandHome(script, ctx)) : undefined;
    const sha = !pkg && scriptPath && isAbsolute(scriptPath) ? hashPath(scriptPath) : undefined;
    return {
      kind: "mcp_server",
      name,
      transport: "stdio",
      command: command.split(/[\\/]/).pop()!,
      ...(pkg ? { package: pkg } : {}),
      ...(scriptPath && !pkg ? { path: scriptPath } : {}),
      ...(sha ? { sha256: sha } : {}),
      ...(raw.enabled === false || raw.disabled === true ? { enabled: false } : {}),
      declared_in: declaredIn,
    };
  }
  const clean = url ? cleanUrl(url) : undefined;
  return {
    kind: "mcp_server",
    name,
    transport: "http",
    ...(clean ? { url: clean } : {}),
    ...(raw.enabled === false || raw.disabled === true ? { enabled: false } : {}),
    declared_in: declaredIn,
  };
}

const SECRET_KEY = /(^|[_.-])(api[_-]?key|apikey|token|secret|password|passwd|authorization|bearer|private[_-]?key|access[_-]?key|client[_-]?secret)$/i;
/** A value that only points at a secret kept elsewhere: an environment variable or a file reference. */
const REFERENCE = /^(\$\{[^}]+\}|\$[A-Z_][A-Z0-9_]*|env:|\{env:|file:|\{file:|op:\/\/|!!js|<[^>]+>)/i;

/**
 * Plaintext secrets in a parsed config: a value under a secret-looking key that is not a reference,
 * or any string a secret rule recognizes. The finding names the key path, never the value.
 */
export function secretFindings(value: unknown, agent: string, file: string): Finding[] {
  const findings: Finding[] = [];
  const rules = compiledRules().rules;
  const walk = (node: unknown, path: string, key: string) => {
    if (typeof node === "string") {
      const trimmed = node.trim().replace(/^Bearer\s+/i, "");
      if (trimmed.length < 8 || REFERENCE.test(trimmed)) return;
      // A word such as `local-no-auth` or `EMPTY` is a placeholder for a server that wants no key. Real
      // credentials carry digits; a recognized secret is reported whatever it looks like.
      const placeholder = /^[A-Za-z_-]+$/.test(trimmed);
      // `botToken` and `bot_token` alike: camelCase is split before the key is matched.
      const named = SECRET_KEY.test(key.replace(/([a-z0-9])([A-Z])/g, "$1_$2")) && !placeholder;
      const rule = rules.find((candidate) => ruleSpans(candidate, node).length > 0);
      if (named || rule) {
        findings.push({
          id: "config.plaintext_secret",
          severity: "high",
          agent,
          location: `${file}: ${path}`,
          message: `a secret is written in plain text${rule ? ` (${rule.id})` : ""}; keep it in an environment variable or a key store`,
        });
      }
      return;
    }
    if (Array.isArray(node)) node.forEach((item, index) => walk(item, `${path}[${index}]`, key));
    else if (isObj(node)) for (const [childKey, child] of Object.entries(node)) walk(child, path ? `${path}.${childKey}` : childKey, childKey);
  };
  walk(value, "", "");
  return findings;
}
