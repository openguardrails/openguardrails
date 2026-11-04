/**
 * systemctl and journalctl inside a sandbox.
 *
 * A service that systemd runs also manages itself through it: a watchdog restarts a unit, a monitor
 * asks whether one is active, a page reads its journal. The sandbox cannot reach systemd (its bus is
 * hidden, because starting a unit would start a program outside the sandbox), so the commands are
 * replaced inside it by small shims that ask this broker, which runs the real command here for the
 * units the sandbox is given (`--units voicego-*`) and nothing else. Reloading systemd, editing
 * units and systemd-run are refused.
 *
 * ⚠️ Only a unit that itself runs in the sandbox may be started, stopped or restarted from inside
 * it. A unit that runs outside it often runs a script the sandbox can write, so starting it would
 * run the sandbox's code outside. Such a unit can be asked about, and `start` succeeds only when it
 * is already running, which does nothing.
 */
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";

/** Where the shims find the broker inside the sandbox, which has a network of its own. */
export const BROKER_PORT = 4189;

/** Verbs that change something. The rest only read. */
const MUTATING = new Set(["start", "stop", "restart", "try-restart", "reload-or-restart"]);

const SYSTEMCTL_VERBS = new Set(["start", "stop", "restart", "try-restart", "reload-or-restart", "is-active", "is-enabled", "is-failed", "status", "show", "cat", "list-units", "list-timers"]);
/** Options that take no value, and options that take one (as `--x=v`, `--x v` or `-x v`). */
const SYSTEMCTL_FLAGS = new Set(["--user", "--no-block", "--quiet", "-q", "--no-pager", "--plain", "--no-legend", "--value", "--all", "-a", "--full", "-l"]);
const SYSTEMCTL_VALUED = new Set(["-p", "--property", "-n", "--lines", "-o", "--output", "--state", "-t", "--type"]);
const JOURNALCTL_FLAGS = new Set(["--user", "--no-pager", "-q", "--quiet", "-r", "--reverse", "--utc", "-a", "--all", "-x", "--no-hostname"]);
const JOURNALCTL_VALUED = new Set(["-u", "--unit", "-n", "--lines", "-o", "--output", "-S", "--since", "-U", "--until", "-p", "--priority", "--output-fields", "-g", "--grep"]);

export function unitMatcher(patterns: string[]): (unit: string) => boolean {
  const regexes = patterns.map((pattern) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, ".")}$`));
  return (unit) => {
    const name = /\.[a-z]+$/.test(unit) ? unit : `${unit}.service`;
    return regexes.some((regex) => regex.test(name) || regex.test(unit));
  };
}

interface Parsed {
  flags: string[];
  values: Array<[string, string]>;
  words: string[];
}

function parse(args: string[], flags: Set<string>, valued: Set<string>): Parsed | string {
  const out: Parsed = { flags: [], values: [], words: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!arg.startsWith("-")) {
      out.words.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    if (flags.has(name) && eq < 0) out.flags.push(name);
    else if (valued.has(name)) {
      const value = eq > 0 ? arg.slice(eq + 1) : args[++i];
      if (value === undefined) return `${name} needs a value`;
      out.values.push([name, value]);
    } else return `${arg} is not allowed inside the sandbox`;
  }
  return out;
}

/** Whether a sandboxed command may run this, and why not. */
export function allowed(tool: string, args: string[], unitAllowed: (unit: string) => boolean): string | null {
  if (tool === "systemctl") {
    const parsed = parse(args, SYSTEMCTL_FLAGS, SYSTEMCTL_VALUED);
    if (typeof parsed === "string") return parsed;
    if (!parsed.flags.includes("--user")) return "only systemctl --user is available inside the sandbox";
    const [verb, ...units] = parsed.words;
    if (!verb || !SYSTEMCTL_VERBS.has(verb)) return `systemctl ${verb ?? ""} is not available inside the sandbox`;
    if (units.length === 0 && !verb.startsWith("list-")) return `systemctl ${verb} needs a unit`;
    const outside = units.find((unit) => !unitAllowed(unit));
    return outside ? `${outside} is not one of this sandbox's units` : null;
  }
  if (tool === "journalctl") {
    const parsed = parse(args, JOURNALCTL_FLAGS, JOURNALCTL_VALUED);
    if (typeof parsed === "string") return parsed;
    if (!parsed.flags.includes("--user")) return "only journalctl --user is available inside the sandbox";
    if (parsed.words.length > 0) return "journalctl matches are not available inside the sandbox; use -u";
    const units = parsed.values.filter(([name]) => name === "-u" || name === "--unit").map(([, unit]) => unit);
    if (units.length === 0) return "journalctl inside the sandbox needs -u <unit>";
    const outside = units.find((unit) => !unitAllowed(unit));
    return outside ? `${outside} is not one of this sandbox's units` : null;
  }
  return `${tool} is not brokered`;
}

/** The shims, put first on PATH inside the sandbox. They speak to the broker over a bridged port. */
export function writeShims(dir: string, port: number): string {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  for (const tool of ["systemctl", "journalctl"]) {
    const path = join(bin, tool);
    writeFileSync(
      path,
      `#!/bin/bash
# openguardrails: inside this sandbox ${tool} goes to a broker that runs it only for the sandbox's own units.
exec 3<>/dev/tcp/127.0.0.1/${port} || { echo "openguardrails: the sandbox's ${tool} broker is not reachable" >&2; exit 1; }
printf '%s\\0%s\\0' ${tool} "$#" >&3
for arg in "$@"; do printf '%s\\0' "$arg" >&3; done
LC_ALL=C IFS=' ' read -r code length <&3
# read -N takes exactly the stdout bytes; head would read on into what follows.
if [ "\${length:-0}" -gt 0 ]; then LC_ALL=C IFS= read -r -d '' -N "$length" out <&3; printf '%s' "$out"; fi
cat <&3 >&2
exit "\${code:-1}"
`,
    );
    chmodSync(path, 0o755);
  }
  return bin;
}

const MAX_ARGS = 64;

/** Reads `<tool>\0<n>\0<arg>\0...`, runs it if allowed, answers `<code> <stdout length>\n<stdout><stderr>`. */
/** The units a systemctl command names, and whether it changes them. */
export function unitsChanged(args: string[]): string[] {
  const words = args.filter((arg, i) => !arg.startsWith("-") && !SYSTEMCTL_VALUED.has(args[i - 1] ?? ""));
  return MUTATING.has(words[0] ?? "") ? words.slice(1) : [];
}

const run = (tool: string, args: string[]) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
    execFile(tool, args, { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) =>
      resolve({ code: error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0, stdout, stderr }),
    ),
  );

/**
 * Whether a unit runs in this sandbox: its command starts with `run --in <name>`. Asked of systemd
 * each time, so a unit moved out of the sandbox is treated as outside at once.
 */
export async function runsInside(unit: string, sandbox: string): Promise<boolean> {
  const shown = await run("systemctl", ["--user", "show", "-p", "ExecStart", "--value", unit]);
  return new RegExp(`\\brun --in ${sandbox.replace(/[^\w-]/g, "")} --`).test(shown.stdout);
}

export function startBroker(
  socketPath: string,
  sandbox: string | null,
  unitAllowed: (unit: string) => boolean,
  onRequest: (tool: string, args: string[], refused: string | null) => void,
): Promise<net.Server> {
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 64 * 1024) return void socket.destroy();
      const parts = buffer.toString("utf8").split("\0");
      if (parts.length < 3) return;
      const [tool, count] = parts as [string, string];
      const n = Number(count);
      if (!Number.isInteger(n) || n < 0 || n > MAX_ARGS) return void socket.destroy();
      if (parts.length < n + 3) return;
      socket.removeAllListeners("data");
      const args = parts.slice(2, 2 + n);
      const answer = (code: number, stdout: string, stderr: string) => {
        const out = Buffer.from(stdout);
        socket.end(Buffer.concat([Buffer.from(`${code} ${out.length}\n`), out, Buffer.from(stderr)]));
      };
      void (async () => {
        let refused = allowed(tool, args, unitAllowed);
        let command = args;
        if (!refused && tool === "systemctl" && unitsChanged(args).length > 0) {
          const verb = args.find((arg) => !arg.startsWith("-"));
          const outside: string[] = [];
          for (const unit of unitsChanged(args)) {
            if (sandbox && (await runsInside(unit, sandbox))) continue;
            // Starting what already runs does nothing, so it is answered without running anything.
            if (verb === "start" && (await run("systemctl", ["--user", "is-active", "--quiet", unit])).code === 0) {
              outside.push(unit);
              continue;
            }
            refused = `${unit} runs outside the sandbox, so it cannot be ${verb === "start" ? "started" : verb === "stop" ? "stopped" : "restarted"} from inside it`;
            break;
          }
          // Only the units inside reach systemd; an outside one is never named to it.
          command = args.filter((arg) => !outside.includes(arg));
          if (!refused && unitsChanged(command).length === 0) {
            onRequest(tool, args, null);
            return answer(0, "", "");
          }
        }
        onRequest(tool, args, refused);
        if (refused) return answer(1, "", `openguardrails: ${refused}\n`);
        const result = await run(tool, command);
        answer(result.code, result.stdout, result.stderr);
      })();
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve(server));
  });
}
