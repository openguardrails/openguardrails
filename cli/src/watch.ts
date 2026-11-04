/**
 * A rule the person writes about their own work, such as "tell me when translating or publishing
 * gets stuck". Stuck means busy without progress: the command keeps using CPU, the network or the
 * model, yet nothing new appears where its output goes. A command that finished and sits idle is not
 * stuck, so being quiet alone never alerts.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface WatchRule {
  /** The person's own words for the rule; the alert is titled with them. */
  name: string;
  /** Only runs whose command line contains this. Every run when absent. */
  command?: string;
  /** Files and directories the command writes its output to. A change anywhere inside is progress. */
  progress: string[];
  /** How long busy without progress counts as stuck. */
  idleMinutes: number;
  /** Channels from `notify`, such as "email". */
  notify: string[];
}

export interface Activity {
  cpuPercent: number;
  networkEvents: number;
  openConnections: number;
  modelCalls: number;
  modelWaiting: number;
}

export interface Sample {
  t: number;
  busy: boolean;
  activity: Activity;
}

/** What makes a sample busy. Below 5% of one core is a process waiting, not working. */
export function isBusy(activity: Activity): boolean {
  return activity.cpuPercent >= 5 || activity.networkEvents > 0 || activity.openConnections > 0 || activity.modelCalls > 0 || activity.modelWaiting > 0;
}

export function describeActivity(activity: Activity): string {
  const parts: string[] = [];
  if (activity.cpuPercent >= 5) parts.push(`CPU ${Math.round(activity.cpuPercent)}%`);
  if (activity.modelWaiting > 0) parts.push(`${activity.modelWaiting} model request(s) waiting for an answer`);
  if (activity.modelCalls > 0) parts.push(`${activity.modelCalls} model call(s)`);
  if (activity.openConnections > 0) parts.push(`${activity.openConnections} open network connection(s)`);
  if (activity.networkEvents > 0) parts.push(`${activity.networkEvents} network request(s)`);
  return parts.join(", ") || "nothing";
}

export type Transition = { kind: "stalled"; idleMs: number; busyWith: Activity } | { kind: "recovered"; stalledMs: number } | null;

/** One rule over one run. `step` is given each sample and says when the rule fires or clears. */
export class StallWatch {
  private samples: Sample[] = [];
  private alertedAt: number | null = null;

  constructor(
    readonly rule: WatchRule,
    private readonly startedAt: number,
  ) {}

  get stalled(): boolean {
    return this.alertedAt !== null;
  }

  step(sample: Sample, progressAt: number): Transition {
    const idleMs = this.rule.idleMinutes * 60_000;
    // Output from before the run is not this run's progress; the run's start is.
    const lastProgress = Math.max(progressAt, this.startedAt);
    this.samples.push(sample);
    this.samples = this.samples.filter((s) => s.t > sample.t - idleMs);

    if (this.alertedAt !== null) {
      if (progressAt > this.alertedAt) {
        const stalledMs = sample.t - this.alertedAt;
        this.alertedAt = null;
        return { kind: "recovered", stalledMs };
      }
      return null;
    }
    if (sample.t - lastProgress < idleMs) return null;
    // Busy for most of the quiet window, not for one moment of it: a health check is not work.
    const window = this.samples.filter((s) => s.t > lastProgress);
    if (window.length < 2 || window.filter((s) => s.busy).length * 2 < window.length) return null;
    this.alertedAt = sample.t;
    return { kind: "stalled", idleMs: sample.t - lastProgress, busyWith: sample.activity };
  }
}

/** The newest modification under the given paths, and where it was. Symbolic links are not followed. */
export function newestChange(paths: string[], limit = 200_000): { t: number; path: string | null } {
  let newest = { t: 0, path: null as string | null };
  let seen = 0;
  const visit = (path: string, depth: number) => {
    if (seen++ > limit) return;
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      return;
    }
    // A new file also touches its directory; the file is the one worth naming.
    if (stat.mtimeMs > newest.t || (stat.mtimeMs === newest.t && !stat.isDirectory())) newest = { t: stat.mtimeMs, path };
    if (!stat.isDirectory() || depth > 8) return;
    let names: string[];
    try {
      names = readdirSync(path);
    } catch {
      return;
    }
    for (const name of names) visit(join(path, name), depth + 1);
  };
  for (const path of paths) visit(path, 0);
  return newest;
}

/** `ps` CPU time ([dd-]hh:mm:ss, or m:ss.cc on macOS) in seconds. */
export function cpuSeconds(text: string): number {
  const [days, rest] = text.includes("-") ? text.split("-") : ["0", text];
  return rest!.split(":").reduce((total, part) => total * 60 + Number(part), 0) + Number(days) * 86_400;
}

/** The CPU seconds used so far by a process and everything under it, from `ps` output. */
export function treeCpuSeconds(psOutput: string, root: number): number {
  const children = new Map<number, number[]>();
  const cpu = new Map<number, number>();
  for (const line of psOutput.split("\n")) {
    const [pid, ppid, time] = line.trim().split(/\s+/);
    if (!pid || !ppid || !time) continue;
    cpu.set(Number(pid), cpuSeconds(time));
    children.set(Number(ppid), [...(children.get(Number(ppid)) ?? []), Number(pid)]);
  }
  let total = 0;
  const stack = [root];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    total += cpu.get(pid) ?? 0;
    stack.push(...(children.get(pid) ?? []));
  }
  return total;
}

export function processTreeCpu(root: number): number {
  try {
    return treeCpuSeconds(execFileSync("ps", ["-A", "-o", "pid=,ppid=,time="], { encoding: "utf8", timeout: 5000 }), root);
  } catch {
    return 0;
  }
}
