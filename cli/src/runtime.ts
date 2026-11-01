/**
 * The OGR Runtime API on this machine. Every agent plugin already speaks `/v1/evaluate`, so pointing
 * `OGR_RUNTIME_URL` here gives each of them the local rules and the model with no change to its
 * wire, and pointing it at an enterprise AIRS later is the same setting.
 *
 * Only a step/response can be refused here: it is where tool calls exist. A step/request is kept
 * for its conversation, which is the context the model will need.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { homeDir, type Config } from "./config.js";
import { decideTool } from "./decide.js";
import { judge, ModelUnavailable, modelTarget, type Judgement, type ModelTarget } from "./model-api.js";
import { loadRuleset } from "./secrets/mask.js";
import { shellLine } from "./tools.js";
import { buildTranscript, callsIn, entriesFromMessages, type NormalCall, type TranscriptEntry } from "./transcript.js";

export const PROVIDER = "openguardrails-local";
const MAX_SESSIONS = 200;
const MAX_ENTRIES_KEPT = 512;
/**
 * Hermes reports a shell command twice: as the tool call and again as the real argv at execution.
 * Both must be enforced, but one action is one model call, and a person pays for model calls.
 */
const REPEAT_WINDOW_MS = 10_000;

interface Finding {
  category: string;
  severity: "low" | "medium" | "high" | "critical";
  path: string;
  detector: string;
  subject: string;
}

export interface Verdict {
  event_id: string;
  provider: string;
  decision: "allow" | "block";
  latency_ms: number;
  findings?: Finding[];
  unjudged?: string[];
  continuation?: { style: "drop_calls"; paths: string[]; notice: string };
}

/** Never holds an argument, a command or a message: what ran is not what this file is for. */
function logDecision(fields: Record<string, unknown>): void {
  try {
    mkdirSync(homeDir(), { recursive: true, mode: 0o700 });
    appendFileSync(join(homeDir(), "decisions.ndjson"), `${JSON.stringify({ t: new Date().toISOString(), ...fields })}\n`, { mode: 0o600 });
  } catch {
    // A full disk must not turn into a refused or an allowed tool call.
  }
}

/** Exactly what left this machine, so a person can check. Already masked. */
function logSent(request: unknown): void {
  try {
    appendFileSync(join(homeDir(), "model-requests.ndjson"), `${JSON.stringify({ t: new Date().toISOString(), request })}\n`, { mode: 0o600 });
  } catch {
    // As above.
  }
}

const RULE_NOTICE = (reason: string) =>
  `This action was refused by a local safety rule and was NOT executed. Reason: ${reason}. Tell the user what you were trying to do, or reach the goal another way. Do not retry this action in a different form.`;
const MODEL_NOTICE = (reason: string) =>
  `This action was refused as unsafe and was NOT executed. Reason: ${reason}. Reach the user's goal another way, or tell the user. Do not retry this action in a different form.`;
const DECISION_NOTICE = (reason: string) =>
  `This action was NOT executed because it needs the user's own decision: ${reason}. Ask the user directly, and try again only after they answer in this conversation.`;

export class LocalRuntime {
  private readonly sessions = new Map<string, TranscriptEntry[]>();
  private readonly recent = new Map<string, { at: number; judgement: Judgement }>();
  private readonly model: ModelTarget | null;
  private readonly workspaces: string[];

  constructor(config: Config, env = process.env) {
    this.model = modelTarget(config, env);
    this.workspaces = config.workspaces ?? [];
  }

  private remember(key: string, entries: TranscriptEntry[]): void {
    this.sessions.delete(key);
    this.sessions.set(key, entries.slice(-MAX_ENTRIES_KEPT));
    if (this.sessions.size > MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value as string);
  }

  private async judgeOnce(key: string, request: { transcript: TranscriptEntry[]; environment: { agent_type: string; workspaces: string[] } }): Promise<Judgement> {
    const now = Date.now();
    for (const [old, entry] of this.recent) if (now - entry.at > REPEAT_WINDOW_MS) this.recent.delete(old);
    const seen = this.recent.get(key);
    if (seen) return seen.judgement;
    logSent(request);
    const judgement = await judge(this.model!, request);
    this.recent.set(key, { at: now, judgement });
    return judgement;
  }

  async evaluate(event: Record<string, any>): Promise<Verdict> {
    const started = Date.now();
    const base = { event_id: randomUUID(), provider: PROVIDER };
    const session = String(event.session_hint ?? event.connection ?? event.agent_id ?? "");
    if (event.kind === "step/request") {
      const messages = event.payload?.messages ?? event.payload?.input;
      const entries = entriesFromMessages(messages);
      if (entries.length > 0) this.remember(session, entries);
      return { ...base, decision: "allow", latency_ms: Date.now() - started };
    }

    const calls = callsIn(String(event.llm_protocol ?? "canonical"), event.payload);
    const findings: Finding[] = [];
    const notices: string[] = [];
    const paths: string[] = [];
    const unjudged: string[] = [];
    const history = this.sessions.get(session) ?? [];
    const refuse = (call: NormalCall & { path: string }, category: string, severity: Finding["severity"], detector: string, notice: string) => {
      findings.push({ category, severity, path: call.path, detector, subject: call.name });
      paths.push(call.path);
      notices.push(notice);
    };
    const agentType = String(event.agent_type ?? "");

    for (const call of calls) {
      const local = decideTool(call, { workspaces: this.workspaces });
      const record = (layer: string, decision: string, reason: string, extra: Record<string, unknown> = {}) =>
        logDecision({ agent: agentType, tool: call.name, layer, decision, reason, ...extra });
      if (local.verdict === "allow") {
        record("rules", "allow", local.reason);
      } else if (local.verdict === "deny") {
        record("rules", "deny", local.reason);
        refuse(call, "security.malicious_command", "critical", "local-rules", RULE_NOTICE(local.reason));
      } else if (!this.model) {
        // No model means no auto mode: the action goes on to the harness's own permission check,
        // and it is reported as not judged. Nothing here claims it was looked at.
        record("none", "unjudged", local.reason);
        unjudged.push(call.path);
      } else {
        const transcript = buildTranscript(history, call);
        const request = { transcript, environment: { agent_type: agentType, workspaces: this.workspaces } };
        // Keyed on what would run, not on the tool's name: `terminal` and `bash` are one action.
        const key = `${session}\n${JSON.stringify(shellLine(call.args) ?? [call.name, call.args])}`;
        let judgement: Judgement | null = null;
        try {
          judgement = await this.judgeOnce(key, request);
        } catch (error) {
          const quota = error instanceof ModelUnavailable ? error.quota : undefined;
          record("model", "unjudged", String((error as Error).message), quota ? { claim_url: quota.claim_url } : {});
          unjudged.push(call.path);
        }
        if (judgement?.decision === "allow") {
          record("model", "allow", local.reason);
        } else if (judgement?.decision === "block") {
          const reason = judgement.reason ?? judgement.category ?? "the model judged this action unsafe";
          record("model", "block", reason, { category: judgement.category });
          refuse(call, judgement.category ?? "security.unsafe_action", judgement.severity ?? "high", "model", MODEL_NOTICE(reason));
        } else if (judgement?.decision === "needs_decision") {
          const reason = judgement.reason ?? "this is the user's decision";
          record("model", "needs_decision", reason);
          refuse(call, "x.ogr.needs_decision", "low", "model", DECISION_NOTICE(reason));
        }
      }
      // Later calls in this step are judged knowing this one came first.
      history.push({ [call.name]: "(earlier call in this step)" });
    }
    this.remember(session, history);

    return {
      ...base,
      decision: findings.length > 0 ? "block" : "allow",
      latency_ms: Date.now() - started,
      ...(findings.length > 0 ? { findings, continuation: { style: "drop_calls" as const, paths, notice: notices.join(" ") } } : {}),
      ...(unjudged.length > 0 ? { unjudged } : {}),
    };
  }
}

const readJson = (req: IncomingMessage): Promise<any> =>
  new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on("data", (part: Buffer) => parts.push(part));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString("utf8") || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });

const send = (res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(value));
};

/** Answers the Runtime API's paths. Returns false for any other path. */
export async function handleRuntime(runtime: LocalRuntime, req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  if (pathname === "/v1/evaluate" && req.method === "POST") {
    let event: Record<string, any>;
    try {
      event = await readJson(req);
    } catch {
      send(res, 400, { error: { message: "the body is not JSON" } });
      return true;
    }
    send(res, 200, await runtime.evaluate(event));
    return true;
  }
  if (pathname === "/v1/rules" && req.method === "GET") {
    const ruleset = loadRuleset();
    if (req.headers["if-none-match"]?.includes(ruleset.id)) {
      res.writeHead(304).end();
      return true;
    }
    send(res, 200, { ruleset }, { etag: `"${ruleset.id}"` });
    return true;
  }
  if (pathname === "/v1/heartbeat" && req.method === "POST") {
    await readJson(req).catch(() => ({}));
    send(res, 200, { rules: { id: loadRuleset().id } });
    return true;
  }
  if (pathname === "/v1/limits" && req.method === "GET") {
    send(res, 200, {});
    return true;
  }
  return false;
}
