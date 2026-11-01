/**
 * Ties what the sandbox saw to the tool call that caused it. A call is open from the reply that
 * issued it until the request that carries its result, and anything observed in that window
 * belongs to it. Several calls open at once share what happened: nothing here can tell them apart,
 * and guessing would blame the wrong one.
 */
export interface Observation {
  /** When it happened, on this machine's clock. Reports can arrive late; the macOS log does. */
  t: number;
  kind: "network" | "file";
  /** host:port, or a path. */
  target: string;
  /** HTTP method, or read / write. */
  action?: string;
  denied?: boolean;
  bytes?: number;
  process?: string;
}

export interface ExecItem {
  kind: "network" | "file";
  target: string;
  action?: string;
  denied?: boolean;
  bytes_up?: number;
  count: number;
  call_ids: string[];
  /** A network target no call in its window named. A claim by the sensor, not a verdict. */
  undeclared?: boolean;
}

export interface ExecReport {
  items: ExecItem[];
  /** Items beyond the cap, which are recorded locally and not sent. */
  dropped?: number;
}

interface OpenCall {
  id: string;
  hosts: string[];
  openedAt: number;
  closedAt?: number;
}

const covers = (known: string, host: string) => host === known || host.endsWith(`.${known}`);
const hostOf = (target: string) => target.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();

export class ExecTracker {
  private readonly calls = new Map<string, OpenCall>();
  private pending = new Map<string, ExecItem>();
  constructor(
    private readonly maxItems = 200,
    /** A call whose result never comes, because it was refused or abandoned, stops collecting. */
    private readonly openTtlMs = 600_000,
    /** How long a closed call can still claim an observation that reports late. */
    private readonly retainMs = 300_000,
  ) {}

  open(calls: Array<{ id: string; hosts: string[] }>, t: number): void {
    for (const call of calls) {
      if (!this.calls.has(call.id)) this.calls.set(call.id, { id: call.id, hosts: call.hosts, openedAt: t });
    }
  }

  close(ids: string[], t: number): void {
    for (const id of ids) {
      const call = this.calls.get(id);
      if (call && call.closedAt === undefined) call.closedAt = t;
    }
    for (const [id, call] of this.calls) {
      if (t - (call.closedAt ?? call.openedAt) > this.retainMs + (call.closedAt === undefined ? this.openTtlMs : 0)) this.calls.delete(id);
    }
  }

  private windowOf(t: number): OpenCall[] {
    return [...this.calls.values()].filter((call) => call.openedAt <= t && t <= (call.closedAt ?? call.openedAt + this.openTtlMs));
  }

  observe(observation: Observation): ExecItem {
    const window = this.windowOf(observation.t);
    const callIds = window.map((call) => call.id).sort();
    const undeclared =
      observation.kind === "network" && window.length > 0 && !window.some((call) => call.hosts.some((host) => covers(host, hostOf(observation.target)) || covers(hostOf(observation.target), host)));
    const key = JSON.stringify([observation.kind, observation.target, observation.action, observation.denied, callIds]);
    const item = this.pending.get(key) ?? {
      kind: observation.kind,
      target: observation.target,
      ...(observation.action ? { action: observation.action } : {}),
      ...(observation.denied ? { denied: true } : {}),
      count: 0,
      call_ids: callIds,
      ...(undeclared ? { undeclared: true } : {}),
    };
    item.count += 1;
    if (observation.bytes) item.bytes_up = (item.bytes_up ?? 0) + observation.bytes;
    this.pending.set(key, item);
    return item;
  }

  /** What has been seen since the last report, the most telling first, since the cap cuts the rest. */
  drain(): ExecReport | undefined {
    if (this.pending.size === 0) return undefined;
    const rank = (item: ExecItem) => (item.denied ? 0 : item.undeclared ? 1 : item.call_ids.length > 0 ? 2 : 3);
    const all = [...this.pending.values()].sort((a, b) => rank(a) - rank(b));
    this.pending = new Map();
    const items = all.slice(0, this.maxItems);
    return { items, ...(all.length > items.length ? { dropped: all.length - items.length } : {}) };
  }
}

/** A macOS sandbox line as an observation, or null for what says nothing about the agent's work. */
export function fileObservation(line: string, t: number): Observation | null {
  const match = /^(\S+?)\(\d+\) deny\(\d+\) file-(read-data|write-\S+) (.+)$/.exec(line);
  if (!match) return null;
  return { t, kind: "file", target: match[3]!, action: match[2] === "read-data" ? "read" : "write", denied: true, process: match[1]! };
}
