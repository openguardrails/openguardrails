/**
 * Named sandboxes, on Linux: one sandbox that several commands share.
 *
 * A service made of many processes that look for each other (one checks with `ps` that another is
 * running, one reads the pid in a lock file) breaks when each runs in a sandbox of its own, because
 * each sandbox has its own processes. `openguardrails sandbox start <name>` keeps one sandbox
 * running with a placeholder process in it, the holder, and `openguardrails run --in <name> --
 * <command>` starts a command inside it, through native/join.c. The service manager still starts,
 * restarts and times each command, and all of them see one another.
 *
 * Everything the run behind the sandbox does applies to every command in it: one network policy and
 * record, one set of writable paths, one GPU, one set of rules.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { homeDir, keyEnvNames, loadConfig } from "./config.js";
import { run, type RunOptions } from "./run.js";

export interface SandboxState {
  name: string;
  /** The `sandbox start` process, which holds the sandbox's network, records and rules. */
  run: number;
  /** The holder, by its pid on this machine. */
  holder: number;
  /** The environment the sandbox gives its commands (its proxy, certificates, telemetry). */
  env: Record<string, string>;
  started: string;
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const statePath = (name: string) => join(homeDir(), "sandboxes", `${name}.json`);
export const holderName = (name: string) => `ogr-holder-${name}`;

export function joinBinary(platform = process.platform, arch = process.arch): string | null {
  if (platform !== "linux") return null;
  const path = fileURLToPath(new URL(`../../native/ogr-join-linux-${arch}`, import.meta.url));
  return existsSync(path) ? path : null;
}

/** What a command run in the sandbox needs from the holder's environment: what the sandbox set. */
export function sandboxEnv(holder: Record<string, string>, outside: NodeJS.ProcessEnv): Record<string, string> {
  // PATH stays the joining command's own; the sandbox's shims are put in front of it (runIn).
  const own = new Set(["PWD", "OLDPWD", "SHLVL", "_", "PATH"]);
  return Object.fromEntries(Object.entries(holder).filter(([key, value]) => !own.has(key) && outside[key] !== value));
}

export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of text.split("\0")) {
    const at = entry.indexOf("=");
    if (at > 0) env[entry.slice(0, at)] = entry.slice(at + 1);
  }
  return env;
}

/** The pid, on this machine, of the process whose argv[0] is `argv0` and that descends from `root`. */
export function findDescendant(root: number, argv0: string, proc = "/proc"): number | null {
  const parent = new Map<number, number>();
  const found: number[] = [];
  for (const entry of readdirSync(proc)) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(join(proc, entry, "stat"), "utf8");
      parent.set(Number(entry), Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]));
      if (readFileSync(join(proc, entry, "cmdline"), "utf8").split("\0")[0] === argv0) found.push(Number(entry));
    } catch {
      // Gone already.
    }
  }
  for (const pid of found) {
    for (let p: number | undefined = pid; p && p > 1; p = parent.get(p)) if (p === root) return pid;
  }
  return null;
}

function alive(state: SandboxState): boolean {
  try {
    return readFileSync(`/proc/${state.holder}/cmdline`, "utf8").split("\0")[0] === holderName(state.name);
  } catch {
    return false;
  }
}

export function readSandbox(name: string): SandboxState | null {
  try {
    const state = JSON.parse(readFileSync(statePath(name), "utf8")) as SandboxState;
    return alive(state) ? state : null;
  } catch {
    return null;
  }
}

export async function startSandbox(name: string, options: Omit<RunOptions, "command">): Promise<number> {
  if (process.platform !== "linux") throw new Error("named sandboxes are Linux only");
  if (!NAME.test(name)) throw new Error(`a sandbox name is lowercase letters, digits, - and _, not ${name}`);
  if (!joinBinary()) throw new Error("this install has no ogr-join for this machine; build it with npm run build");
  if (readSandbox(name)) throw new Error(`sandbox ${name} is already running`);
  const dir = mkdtempSync(join(tmpdir(), `openguardrails-sandbox-${name}-`));
  const envFile = join(dir, "holder.env");
  mkdirSync(join(homeDir(), "sandboxes"), { recursive: true, mode: 0o700 });
  let state: SandboxState | null = null;
  const code = await run({
    ...options,
    allowWrite: [...options.allowWrite, dir],
    label: `sandbox ${name}`,
    command: ["bash", "-c", `env -0 > ${dir}/holder.env && exec -a ${holderName(name)} sleep infinity`],
    onStarted: async (child) => {
      for (let i = 0; i < 300 && !state; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const holder = existsSync(envFile) ? findDescendant(child, holderName(name)) : null;
        if (holder === null) continue;
        state = { name, run: process.pid, holder, env: sandboxEnv(parseEnv(readFileSync(envFile, "utf8")), process.env), started: new Date().toISOString() };
        writeFileSync(statePath(name), JSON.stringify(state, null, 2), { mode: 0o600 });
        process.stderr.write(`[openguardrails] sandbox ${name} is running. Start commands in it with: openguardrails run --in ${name} -- <command>\n`);
      }
      if (!state) process.stderr.write(`[openguardrails] sandbox ${name} did not start its holder\n`);
      return state ? () => sandboxCpu(state!.holder) : undefined;
    },
  });
  rmSync(statePath(name), { force: true });
  rmSync(dir, { recursive: true, force: true });
  return code;
}

/** Starts a command inside a running sandbox and waits for it, passing on the signals it is sent. */
export async function runIn(name: string, command: string[], cwd = process.cwd()): Promise<number> {
  const state = readSandbox(name);
  if (!state) {
    process.stderr.write(`[openguardrails] sandbox ${name} is not running. Start it with: openguardrails sandbox start ${name} [run options]\n`);
    return 125;
  }
  const join = joinBinary();
  if (!join) throw new Error("this install has no ogr-join for this machine; build it with npm run build");
  const env: NodeJS.ProcessEnv = { ...process.env, ...state.env };
  if (state.env.OGR_SANDBOX_BIN) env.PATH = `${state.env.OGR_SANDBOX_BIN}:${process.env.PATH ?? "/usr/bin:/bin"}`;
  // The keys this tool holds never reach a sandboxed command, joined or not.
  for (const key of keyEnvNames(loadConfig())) delete env[key];
  const child = spawn(join, [String(state.holder), cwd, ...command], { stdio: "inherit", env });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGUSR1", "SIGUSR2"] as const) process.on(signal, () => child.kill(signal));
  return new Promise((resolve) => {
    child.on("error", () => resolve(127));
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}

export function stopSandbox(name: string): number {
  const state = readSandbox(name);
  if (!state) {
    process.stderr.write(`[openguardrails] sandbox ${name} is not running\n`);
    return 1;
  }
  process.kill(state.run, "SIGTERM");
  return 0;
}

export function listSandboxes(): string[] {
  const dir = join(homeDir(), "sandboxes");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -5))
    .filter((name) => readSandbox(name) !== null);
}

/** CPU seconds used by every process in the holder's PID namespace: the whole sandbox, joined commands too. */
export function sandboxCpu(holder: number, proc = "/proc"): number {
  let ns: string;
  try {
    ns = readlinkSync(join(proc, String(holder), "ns", "pid"));
  } catch {
    return 0;
  }
  let ticks = 0;
  for (const entry of readdirSync(proc)) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (readlinkSync(join(proc, entry, "ns", "pid")) !== ns) continue;
      const stat = readFileSync(join(proc, entry, "stat"), "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      // Its own time, and that of the children it has waited for, which have left the process table.
      ticks += Number(fields[11]) + Number(fields[12]) + Number(fields[13]) + Number(fields[14]);
    } catch {
      // Gone, or not ours to read.
    }
  }
  return ticks / 100;
}
