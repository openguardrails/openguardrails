/** The run's record. It holds destinations and tool names, and never a body, a query, an argument or a long path segment. */
import { appendFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const runsDir = () => join(process.env.OPENGUARDRAILS_HOME ?? join(homedir(), ".openguardrails"), "runs");

export type RunEvent = { t: string; type: string } & Record<string, unknown>;

export class Recorder {
  readonly path: string;
  constructor(readonly runId: string) {
    mkdirSync(runsDir(), { recursive: true, mode: 0o700 });
    this.path = join(runsDir(), `${runId}.ndjson`);
  }
  write(type: string, fields: Record<string, unknown>): void {
    appendFileSync(this.path, `${JSON.stringify({ t: new Date().toISOString(), type, ...fields })}\n`, { mode: 0o600 });
  }
}

/** Paths carry credentials too (webhook URLs, bot tokens), so a long segment is not kept. */
export const safePath = (pathname: string) =>
  pathname.split("/").map((segment) => (segment.length > 16 ? "…" : segment)).join("/");

export function latestRun(): string | null {
  if (!existsSync(runsDir())) return null;
  const runs = readdirSync(runsDir()).filter((name) => name.endsWith(".ndjson")).sort();
  return runs.at(-1)?.replace(/\.ndjson$/, "") ?? null;
}

export function readRun(runId: string): RunEvent[] {
  return readFileSync(join(runsDir(), `${runId}.ndjson`), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RunEvent);
}

export function renderEvent(event: RunEvent): string {
  const time = event.t.slice(11, 19);
  const f = event as Record<string, any>;
  switch (event.type) {
    case "start": return `${time} run      ${f.mode}: ${f.command}`;
    case "connect": return `${time} connect  ${f.host}:${f.port}${f.allowed ? "" : "  DENIED"}`;
    case "request": return `${time} http     ${f.method} ${f.host}${f.path}${f.bytes ? `  ${f.bytes}B up` : ""}`;
    case "model": return `${time} model    ${f.harness} -> ${f.host} ${f.model ?? "?"} (${f.protocol})`;
    case "tool_call": return `${time} tool     ${f.name}${f.hosts.length ? `  names ${f.hosts.join(", ")}` : ""}`;
    case "undeclared": return `${time} FINDING  undeclared destination ${f.host}: ${f.methods.join("/")} x${f.requests}, ${f.bytes_up}B up, no tool call named it`;
    case "unverified": return `${time} UNVERIFIED destination ${f.host}: ${f.methods.join("/")} x${f.requests}, ${f.bytes_up}B up, not named by a visible call, but the calls of ${f.blind_to.join(", ")} are not visible`;
    case "violation": return `${time} denied   ${f.line}`;
    case "verdict": return `${time} airs     ${f.decision} (${f.findings} findings)${f.error ? ` error: ${f.error}` : ""}`;
    case "exit": return `${time} exit     ${f.code}`;
    default: return `${time} ${event.type}`;
  }
}
