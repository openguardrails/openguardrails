/**
 * The Linux file and exec telemetry: libogr-observe (native/observe.c), preloaded into the sandbox,
 * appends what each process opens and runs to a log, and this reads it back. It covers what the
 * sandbox allowed, which the sandbox itself does not report. It is telemetry, not a boundary: a
 * statically linked program or a raw system call is not seen.
 */
import { existsSync, openSync, readSync, closeSync, fstatSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface FileEvent {
  t: number;
  action: "read" | "write" | "exec";
  pid: number;
  process: string;
  path: string;
}

/** The library for this machine, when the package carries one. */
export function preloadLibrary(platform = process.platform, arch = process.arch): string | null {
  if (platform !== "linux") return null;
  const path = fileURLToPath(new URL(`../../native/libogr-observe-linux-${arch}.so`, import.meta.url));
  return existsSync(path) ? path : null;
}

export function parseLine(line: string): FileEvent | null {
  const [t, action, pid, name, ...rest] = line.split("\t");
  const path = rest.join("\t");
  if (!t || !pid || !path || (action !== "read" && action !== "write" && action !== "exec")) return null;
  return { t: Number(t), action, pid: Number(pid), process: name ?? "?", path };
}

/**
 * What every program reads to start: its own code, libraries and the system's files. Reading them
 * says nothing about the task, and there are thousands. Writes and execs are always kept.
 */
export function isRoutineRead(path: string): boolean {
  if (/^\/(usr|lib|lib32|lib64|bin|sbin|snap|opt)\//.test(path)) return true;
  // macOS: the system, its frameworks and caches, and each app's own bundle.
  if (/^\/(System|Library|dev)\/|^\/private\/var\/db\/|^\/private\/etc\/|\/Contents\/(Frameworks|Resources|MacOS|Info\.plist)|\.(dylib|framework)(\/|$)/.test(path)) return true;
  if (/\/(site-packages|dist-packages|node_modules|__pycache__|\.git)\//.test(path)) return true;
  if (/\.(pyc|so(\.\d+)*|pth)$/.test(path)) return true;
  return /^\/etc\/(ssl|ca-certificates|localtime|nsswitch\.conf|host\.conf|resolv\.conf|hosts|gai\.conf|mime\.types|passwd|group)$|^\/etc\/(ssl|ca-certificates|fonts|alternatives)\//.test(path);
}

/** One line Seatbelt logs for an allowed operation, as "Sandbox: cat(12) allow file-read-data /a". */
export function parseSeatbeltReport(message: string, t: number): FileEvent | null {
  const match = /^Sandbox: (.+?)\((\d+)\) allow (process-exec\*?|file-read-data|file-write-\S+) (\/[^\n]*)/.exec(message);
  if (!match) return null;
  const action = match[3]!.startsWith("process-exec") ? "exec" : match[3] === "file-read-data" ? "read" : "write";
  return { t, action, pid: Number(match[2]), process: match[1]!, path: match[4]! };
}

/** Reads new lines from the log as they are written. */
export class ObserveLog {
  private offset = 0;
  private rest = "";

  constructor(readonly path: string) {}

  read(): FileEvent[] {
    if (!existsSync(this.path)) return [];
    const fd = openSync(this.path, "r");
    try {
      const size = fstatSync(fd).size;
      if (size <= this.offset) return [];
      const buffer = Buffer.alloc(Math.min(size - this.offset, 8 * 1024 * 1024));
      const n = readSync(fd, buffer, 0, buffer.length, this.offset);
      this.offset += n;
      const text = this.rest + buffer.subarray(0, n).toString("utf8");
      const lines = text.split("\n");
      this.rest = lines.pop() ?? "";
      return lines.map(parseLine).filter((event): event is FileEvent => event !== null);
    } finally {
      closeSync(fd);
    }
  }
}

/** Keeps the first of each action on each path within a window, so a loop over one file is one line. */
export class Deduper {
  private seen = new Map<string, number>();
  constructor(private readonly windowMs = 10_000) {}

  fresh(event: FileEvent): boolean {
    const key = `${event.action}\t${event.path}`;
    const last = this.seen.get(key);
    if (last !== undefined && event.t - last < this.windowMs) return false;
    this.seen.set(key, event.t);
    if (this.seen.size > 50_000) this.seen.clear();
    return true;
  }
}
