/**
 * The gateway: one local base URL in front of many model APIs, trying them in order.
 * It rewrites the model name and the key and nothing else: it does not translate protocols, so
 * the members of a route must speak the protocol their client speaks.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";
import { INTEGRATION } from "./airs.js";
import { homeDir, resolveRoute, secretOf, type Config, type Upstream } from "./config.js";
import { ExecTracker, type ExecReport, type Observation } from "./exec.js";
import { handleRuntime, LocalRuntime } from "./runtime.js";
import { classifyModelRequest, harnessFrom, hostsIn, toolCallsIn, toolCallsInReply, toolResultIdsIn, type LlmProtocol } from "./model.js";

type Gateway = NonNullable<Config["gateway"]>;

/** The request's fault: another upstream would refuse it too, so it goes back to the client. */
export const isFailoverStatus = (status: number) => status >= 500 || [401, 403, 404, 408, 429].includes(status);

export function rewriteBody(body: Record<string, any>, upstream: Upstream): Record<string, any> {
  const out: Record<string, any> = { ...body, model: upstream.model };
  const kwargs = body.chat_template_kwargs;
  if (upstream.renameTemplateKwargs && kwargs && typeof kwargs === "object") {
    out.chat_template_kwargs = Object.fromEntries(
      Object.entries(kwargs).map(([key, value]) => [upstream.renameTemplateKwargs![key] ?? key, value]),
    );
  }
  return out;
}

/** The URL for a client path: /v1/chat/completions on a base of http://h/v1 is http://h/v1/chat/completions. */
export function upstreamUrl(baseURL: string, clientPath: string): URL {
  const base = baseURL.replace(/\/$/, "");
  return new URL(base + clientPath.replace(/^\/v1(?=\/)/, ""));
}

const HOP_BY_HOP = new Set(["host", "connection", "content-length", "content-encoding", "transfer-encoding", "keep-alive", "te", "trailer", "upgrade", "proxy-connection", "proxy-authorization"]);

export function upstreamHeaders(client: IncomingHttpHeaders, protocol: LlmProtocol | null, key: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(client)) {
    if (!HOP_BY_HOP.has(name) && typeof value === "string") headers[name] = value;
  }
  if (key) {
    delete headers.authorization;
    delete headers["x-api-key"];
    if (protocol === "anthropic.messages") headers["x-api-key"] = key;
    else headers.authorization = `Bearer ${key}`;
  }
  return headers;
}

/** Remembers which upstreams just failed, so a dead one does not cost every request a timeout. */
export class Health {
  private readonly until = new Map<string, number>();
  constructor(private readonly cooldownMs: number) {}
  fail(name: string, now = Date.now()): void {
    this.until.set(name, now + this.cooldownMs);
  }
  ok(name: string): void {
    this.until.delete(name);
  }
  /** Healthy members first in their order; cooling ones after, since one may have recovered. */
  order(members: string[], now = Date.now()): string[] {
    const cooling = (name: string) => (this.until.get(name) ?? 0) > now;
    return [...members.filter((name) => !cooling(name)), ...members.filter(cooling)];
  }
  cooling(now = Date.now()): string[] {
    return [...this.until].filter(([, until]) => until > now).map(([name]) => name);
  }
}

const decode = (bytes: Buffer, encoding: string | undefined): Buffer => {
  switch (encoding) {
    case "gzip": return zlib.gunzipSync(bytes);
    case "br": return zlib.brotliDecompressSync(bytes);
    case "deflate": return zlib.inflateSync(bytes);
    case "zstd": return zlib.zstdDecompressSync(bytes);
    default: return bytes;
  }
};

const readAll = (stream: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    stream.on("data", (part: Buffer) => parts.push(part));
    stream.on("end", () => resolve(Buffer.concat(parts)));
    stream.on("error", reject);
  });

/** Beyond this a reply is forwarded but not sent for judging; a process must not grow without bound. */
const MAX_JUDGED_REPLY_BYTES = 64 * 1024 * 1024;

/** What to do with a body once AIRS has answered, from the verdict alone. */
export type Judged =
  | { kind: "forward"; body?: Record<string, any> }
  | { kind: "answer"; status: number; contentType: string; body: string; reason: string };

/** The cases of the verdict's `payload`. A `block` with a continuation is a body to carry on with. */
export function readVerdict(verdict: Record<string, any>): Judged {
  const { decision, payload, continuation, payload_stream: stream } = verdict;
  if (decision === "block" && !(continuation && typeof payload === "object" && payload && continuation.style !== "answer")) {
    if (typeof payload === "string" && stream) return { kind: "answer", status: 200, contentType: "text/event-stream", body: payload, reason: "blocked" };
    if (payload && typeof payload === "object") return { kind: "answer", status: 200, contentType: "application/json", body: JSON.stringify(payload), reason: "blocked" };
    // Nothing rendered, as for a canonical event: refusing is the only reading of a block.
    return { kind: "answer", status: 403, contentType: "application/json", body: JSON.stringify({ error: { message: "Refused by OpenGuardrails AIRS.", type: "openguardrails_blocked" } }), reason: "blocked" };
  }
  if (payload && typeof payload === "object") return { kind: "forward", body: payload };
  return { kind: "forward" };
}

const refusal = (message: string): Extract<Judged, { kind: "answer" }> => ({
  kind: "answer",
  status: 503,
  contentType: "application/json",
  body: JSON.stringify({ error: { message, type: "openguardrails_fail_closed" } }),
  reason: "fail-closed",
});

export function startGateway(config: Config): Promise<http.Server> {
  const gateway: Gateway = config.gateway ?? { upstreams: {} };
  const health = new Health(gateway.cooldownMs ?? 30_000);
  const connectTimeoutMs = gateway.connectTimeoutMs ?? 5_000;
  const firstByteTimeoutMs = gateway.firstByteTimeoutMs ?? 600_000;
  const airs = config.airs;
  const airsKey = airs ? secretOf(airs) : undefined;
  const failClosed = airs?.failMode === "closed";
  const requestTimeoutMs = airs?.requestTimeoutMs ?? 6_000;
  let lastFailover: unknown = null;
  let served = 0;
  // What runs ask for, since agents reach the gateway directly and their calls never pass the proxy.
  const seenCalls = new Set<string>();
  const activity: Array<{ t: number; agent: string; name: string; hosts: string[] }> = [];
  const blindTo = new Set<string>();
  const exec = new ExecTracker();
  // An older AIRS refuses the field. The judgement matters more than the evidence, so it is dropped.
  let execRefused = false;

  mkdirSync(homeDir(), { recursive: true, mode: 0o700 });
  // Sandboxed agents can reach this port, so what only `openguardrails run` may do takes a token they cannot read.
  const internalToken = randomBytes(24).toString("hex");
  writeFileSync(join(homeDir(), "gateway.token"), internalToken, { mode: 0o600 });
  const log = (type: string, fields: Record<string, unknown>) =>
    appendFileSync(join(homeDir(), "gateway.ndjson"), `${JSON.stringify({ t: new Date().toISOString(), type, ...fields })}\n`, { mode: 0o600 });

  const identity = (agentType: string) => ({
    id: airs?.agentId ?? `${agentType}-${hostname()}`,
    type: agentType,
    workspace: airs?.agentWorkspace ?? "",
    user: userInfo().username,
  });
  const airsUrl = () => new URL(`${airs!.url.replace(/\/$/, "")}/v1/evaluate?payload=true`);

  const noteCalls = (agentType: string, calls: Array<{ id: string; name: string; args: string }>, t: number) => {
    const opened = [];
    for (const call of calls) {
      const hosts = hostsIn(call.args);
      opened.push({ id: call.id, hosts });
      if (seenCalls.has(call.id)) continue;
      seenCalls.add(call.id);
      activity.push({ t, agent: agentType, name: call.name, hosts });
      if (activity.length > 5000) activity.shift();
    }
    exec.open(opened, t);
  };

  /** Judges a request before the model sees it. An absent verdict follows the fail mode. */
  const judgeRequest = async (stepId: string, protocol: LlmProtocol, payload: unknown, agentType: string, endpoint: string, report: ExecReport | undefined): Promise<Judged> => {
    if (!airsKey) return { kind: "forward" };
    const who = identity(agentType);
    const event = {
      kind: "step/request", step_id: stepId, agent_id: who.id, agent_type: who.type, agent_workspace: who.workspace,
      agent_user: who.user, llm_protocol: protocol, payload, integration: INTEGRATION, llm_endpoint: endpoint,
    };
    const post = (body: unknown) =>
      fetch(airsUrl(), {
        method: "POST",
        headers: { authorization: `Bearer ${airsKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    try {
      let response = await post(report && !execRefused ? { ...event, exec: report } : event);
      if (response.status === 400 && report && !execRefused) {
        const text = await response.text();
        if (/\bexec\b/.test(text)) {
          execRefused = true;
          log("exec_refused", { detail: "this AIRS does not accept the exec field; evidence stays in this log" });
          response = await post(event);
        } else {
          throw new Error(`HTTP 400 ${text.slice(0, 200)}`);
        }
      }
      const verdict = (await response.json().catch(() => ({}))) as Record<string, any>;
      // A 200 without a decision is not a verdict.
      if (!response.ok || !verdict.decision) throw new Error(`HTTP ${response.status}`);
      log("verdict", { kind: "step/request", step: stepId, decision: verdict.decision, findings: verdict.findings?.length ?? 0 });
      if (failClosed && verdict.unjudged?.length) return refusal("OpenGuardrails AIRS could not judge all of this request.");
      return readVerdict(verdict);
    } catch (error) {
      log("verdict", { kind: "step/request", step: stepId, decision: "unjudged", error: String(error) });
      return failClosed ? refusal("OpenGuardrails AIRS gave no verdict, and this gateway fails closed.") : { kind: "forward" };
    }
  };

  /** Judges a whole, unstreamed reply. Answers what the client should receive. */
  const judgeWholeReply = async (stepId: string, protocol: LlmProtocol, reply: Buffer, agentType: string, endpoint: string): Promise<{ status?: number; body: Buffer | string; contentType?: string; refused?: boolean }> => {
    if (!airsKey) return { body: reply };
    const who = identity(agentType);
    try {
      const response = await fetch(airsUrl(), {
        method: "POST",
        headers: { authorization: `Bearer ${airsKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          kind: "step/response", step_id: stepId, agent_id: who.id, agent_type: who.type, agent_workspace: who.workspace,
          agent_user: who.user, llm_protocol: protocol, payload: JSON.parse(reply.toString("utf8")), integration: INTEGRATION, llm_endpoint: endpoint,
        }),
        signal: AbortSignal.timeout(requestTimeoutMs * 3),
      });
      const verdict = (await response.json().catch(() => ({}))) as Record<string, any>;
      if (!response.ok || !verdict.decision) throw new Error(`HTTP ${response.status}`);
      log("verdict", { kind: "step/response", step: stepId, decision: verdict.decision, findings: verdict.findings?.length ?? 0 });
      const judged = readVerdict(verdict);
      if (judged.kind === "answer") return { status: judged.status, body: judged.body, contentType: judged.contentType, refused: true };
      return { body: judged.body ? JSON.stringify(judged.body) : reply };
    } catch (error) {
      log("verdict", { kind: "step/response", step: stepId, decision: "unjudged", error: String(error) });
      if (!failClosed) return { body: reply };
      const refused = refusal("OpenGuardrails AIRS gave no verdict, and this gateway fails closed.");
      return { status: refused.status, body: refused.body, contentType: refused.contentType, refused: true };
    }
  };

  /**
   * Carries a streamed reply through AIRS: the frames go up as they arrive, and what comes back is
   * what the client gets. Prose flows live; tool calls and the end wait for the verdict.
   */
  const judgedStream = (stepId: string, protocol: LlmProtocol, agentType: string, endpoint: string, res: ServerResponse, outHeaders: IncomingHttpHeaders, status: number) => {
    const who = identity(agentType);
    const url = airsUrl();
    const held: Buffer[] = [];
    let state: "waiting" | "judged" | "direct" = "waiting";
    let upstreamEnded = false;
    let tail = "";
    const direct = (why: string) => {
      if (state !== "waiting") return;
      log("verdict", { kind: "step/response", step: stepId, decision: "unjudged", error: why });
      if (failClosed) {
        state = "direct";
        const refused = refusal("OpenGuardrails AIRS gave no verdict, and this gateway fails closed.");
        res.writeHead(refused.status, { "content-type": refused.contentType });
        res.end(refused.body);
        return;
      }
      state = "direct";
      res.writeHead(status, outHeaders);
      for (const chunk of held) res.write(chunk);
      held.length = 0;
      if (upstreamEnded) res.end();
    };
    const request = (url.protocol === "https:" ? https : http).request(
      url,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${airsKey}`, "content-type": "text/event-stream", "ogr-kind": "step/response", "ogr-step-id": stepId, "ogr-llm-protocol": protocol,
          "ogr-agent-id": who.id, "ogr-agent-type": who.type, "ogr-agent-workspace": who.workspace, "ogr-agent-user": who.user,
          "ogr-integration": INTEGRATION, "ogr-llm-endpoint": endpoint, "ogr-fail-mode": failClosed ? "closed" : "open",
        },
      },
      (airsRes) => {
        clearTimeout(headTimer);
        if (airsRes.statusCode !== 200 || !String(airsRes.headers["content-type"]).includes("text/event-stream")) {
          airsRes.resume();
          return direct(`AIRS answered HTTP ${airsRes.statusCode}`);
        }
        state = "judged";
        held.length = 0;
        const { "content-length": _length, "content-encoding": _encoding, ...headers } = outHeaders;
        res.writeHead(200, { ...headers, "content-type": "text/event-stream" });
        airsRes.on("data", (chunk: Buffer) => {
          res.write(chunk);
          tail = (tail + chunk.toString("utf8")).slice(-8192);
        });
        airsRes.on("end", () => {
          res.end();
          const verdict = /: ogr (\{.*\})/.exec(tail)?.[1];
          let decision = "unknown";
          try {
            decision = (JSON.parse(verdict ?? "{}") as { decision?: string }).decision ?? "unknown";
          } catch {
            // Reported as unknown.
          }
          log("verdict", { kind: "step/response", step: stepId, decision });
        });
        airsRes.on("error", () => res.destroy());
      },
    );
    // AIRS may answer nothing until it has judged the whole reply, so its clock starts when it has
    // the whole reply. Started any earlier, a slow generation would time out into a fail-open, and
    // every reply slower than the budget would escape judgement.
    let headTimer: NodeJS.Timeout | undefined;
    request.on("error", (error) => {
      clearTimeout(headTimer);
      if (state === "waiting") direct(String(error));
      else if (state === "judged") res.destroy();
    });
    return {
      write(chunk: Buffer) {
        if (state === "direct") {
          if (!res.writableEnded) res.write(chunk);
        } else {
          if (state === "waiting") held.push(chunk);
          request.write(chunk);
        }
      },
      end() {
        upstreamEnded = true;
        if (state === "direct") {
          if (!res.writableEnded) res.end();
        } else {
          request.end();
          if (state === "waiting") {
            headTimer = setTimeout(() => {
              direct(`no answer from AIRS ${requestTimeoutMs * 5}ms after the reply ended`);
              request.destroy();
            }, requestTimeoutMs * 5);
          }
        }
      },
      abort() {
        clearTimeout(headTimer);
        request.destroy();
      },
    };
  };

  /** One attempt. Resolves with why it failed, or null once the reply is the client's. */
  const attempt = (name: string, upstream: Upstream, path: string, protocol: LlmProtocol, stepId: string, agentType: string, method: string, clientHeaders: IncomingHttpHeaders, body: Buffer, res: ServerResponse): Promise<string | null> =>
    new Promise((resolve) => {
      const url = upstreamUrl(upstream.baseURL, path);
      const headers = upstreamHeaders(clientHeaders, protocol, secretOf(upstream));
      headers["content-length"] = String(body.length);
      // The reply is read here and sent on to AIRS, so it has to arrive readable.
      if (airsKey) delete headers["accept-encoding"];
      const endpoint = new URL(upstream.baseURL).host;
      let settled = false;
      let replied = false;
      let clientGone = false;
      let sink: ReturnType<typeof judgedStream> | null = null;
      const settle = (reason: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(firstByteTimer);
        resolve(reason);
      };
      const client = (url.protocol === "https:" ? https : http).request(url, { method, headers }, (upstreamRes) => {
        const status = upstreamRes.statusCode ?? 502;
        if (isFailoverStatus(status)) {
          upstreamRes.resume();
          return settle(`HTTP ${status}`);
        }
        const contentType = String(upstreamRes.headers["content-type"] ?? "");
        const streamed = contentType.includes("text/event-stream");
        const encoding = upstreamRes.headers["content-encoding"] as string | undefined;
        const parts: Buffer[] = [];
        let size = 0;
        let started = false;
        const out = { ...upstreamRes.headers, "x-openguardrails-upstream": name } as IncomingHttpHeaders;
        delete out.connection;
        delete out["keep-alive"];
        delete out["transfer-encoding"];
        // The head waits for the first byte: until a byte has gone out, a failure can still fail over.
        const start = () => {
          started = true;
          clearTimeout(firstByteTimer);
          settle(null);
          if (airsKey && streamed && status < 400 && !encoding) sink = judgedStream(stepId, protocol, agentType, endpoint, res, out, status);
          else if (!airsKey || status >= 400) res.writeHead(status, out);
        };
        const decoded = (): Buffer | null => {
          if (size > MAX_JUDGED_REPLY_BYTES) return null;
          try {
            return decode(Buffer.concat(parts), encoding);
          } catch {
            return null;
          }
        };
        const finish = () => {
          if (replied) return;
          replied = true;
          const reply = status < 400 ? decoded() : null;
          log("step", { step: stepId, upstream: name, model: upstream.model, protocol, agent_type: agentType, reply_bytes: reply?.length ?? null });
          if (reply) noteCalls(agentType, toolCallsInReply(protocol, reply.toString("utf8"), streamed), Date.now());
        };
        upstreamRes.on("data", (chunk: Buffer) => {
          if (!started) start();
          size += chunk.length;
          if (size <= MAX_JUDGED_REPLY_BYTES) parts.push(chunk);
          if (sink) sink.write(chunk);
          else if (res.headersSent) res.write(chunk);
        });
        upstreamRes.on("end", async () => {
          if (!started) start();
          health.ok(name);
          finish();
          if (sink) return sink.end();
          if (res.headersSent) return void res.end();
          // A whole reply, held for its verdict.
          const reply = decoded();
          if (!reply) {
            res.writeHead(status, out);
            return void res.end(Buffer.concat(parts));
          }
          const judged = await judgeWholeReply(stepId, protocol, reply, agentType, endpoint);
          const { "content-encoding": _encoding, "content-length": _length, ...headers } = out;
          res.writeHead(judged.status ?? status, { ...headers, ...(judged.contentType ? { "content-type": judged.contentType } : {}) });
          res.end(judged.body);
        });
        // Clients often hang up on seeing the end marker. That is not the upstream failing, and what
        // arrived is still recorded. Either event can come first, so both ask the same question.
        const broken = () => {
          if (upstreamRes.complete) return;
          if (clientGone) {
            if (started) finish();
            return settle("the client went away");
          }
          fail(started);
        };
        upstreamRes.on("error", broken);
        upstreamRes.on("close", broken);
      });
      const fail = (started: boolean) => {
        if (!started) return settle("the stream ended before its first byte");
        // Too late to switch: bytes are out. The client sees a cut stream, and its retry skips this upstream.
        health.fail(name);
        log("cut", { upstream: name });
        sink?.abort();
        res.destroy();
      };
      const firstByteTimer = setTimeout(() => {
        client.destroy();
        settle(`no first byte in ${firstByteTimeoutMs}ms`);
      }, firstByteTimeoutMs);
      client.on("socket", (socket) => {
        if (socket.connecting) {
          const timer = setTimeout(() => {
            client.destroy();
            settle(`no connection in ${connectTimeoutMs}ms`);
          }, connectTimeoutMs);
          socket.once("connect", () => clearTimeout(timer));
          socket.once("secureConnect", () => clearTimeout(timer));
          socket.once("close", () => clearTimeout(timer));
        }
      });
      client.on("error", (error) => settle(error.message));
      res.on("close", () => {
        if (res.writableEnded) return;
        clientGone = true;
        sink?.abort();
        client.destroy();
      });
      client.end(body);
    });

  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };

  const runtime = new LocalRuntime(config);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://gateway");
      if (await handleRuntime(runtime, req, res, url.pathname)) return;
      if (url.pathname === "/__ogr/health") {
        return json(res, 200, { ok: true, pid: process.pid, served, cooling: health.cooling(), last_failover: lastFailover, airs: Boolean(airsKey), exec_refused: execRefused });
      }
      if (url.pathname.startsWith("/__ogr/") && req.headers["x-openguardrails-token"] !== internalToken) {
        return json(res, 403, { error: { message: "openguardrails: this path is for openguardrails run" } });
      }
      if (url.pathname === "/__ogr/activity") {
        const since = Number(url.searchParams.get("since") ?? 0);
        return json(res, 200, { served, blind_to: [...blindTo], calls: activity.filter((call) => call.t > since) });
      }
      if (url.pathname === "/__ogr/observe" && req.method === "POST") {
        const observations = JSON.parse((await readAll(req)).toString("utf8")) as Observation[];
        for (const observation of observations.slice(0, 1000)) {
          const item = exec.observe(observation);
          log("exec", { ...observation, call_ids: item.call_ids, undeclared: item.undeclared ?? false });
        }
        return json(res, 200, { ok: true });
      }
      if (req.method === "GET" && /\/models$/.test(url.pathname)) {
        const names = [...Object.keys(gateway.routes ?? {}), ...Object.keys(gateway.upstreams)];
        return json(res, 200, { object: "list", data: names.map((id) => ({ id, object: "model", owned_by: "openguardrails" })) });
      }
      const protocol = classifyModelRequest(req.method ?? "", url.pathname);
      if (!protocol) return json(res, 404, { error: { message: `openguardrails gateway does not serve ${req.method} ${url.pathname}` } });

      const parsed = JSON.parse(decode(await readAll(req), req.headers["content-encoding"] as string | undefined).toString("utf8"));
      const members = resolveRoute(gateway, parsed?.model);
      if (!members) {
        const known = [...Object.keys(gateway.routes ?? {}), ...Object.keys(gateway.upstreams)].join(", ");
        return json(res, 404, { error: { message: `openguardrails gateway has no model "${parsed?.model}". Known: ${known}` } });
      }

      served += 1;
      const stepId = randomBytes(16).toString("hex");
      const agentType = harnessFrom(req.headers["user-agent"] ?? "");
      const now = Date.now();
      // History names calls too, for a client whose reply never passed through this gateway.
      noteCalls(agentType, toolCallsIn(protocol, parsed), now);
      const resultIds = toolResultIdsIn(protocol, parsed);
      if (resultIds.some((id) => !seenCalls.has(id))) blindTo.add(agentType);
      exec.close(resultIds, now);

      const order = health.order(members);
      const first = gateway.upstreams[order[0]!]!;
      const judged = await judgeRequest(stepId, protocol, { ...parsed, model: first.model }, agentType, new URL(first.baseURL).host, exec.drain());
      if (judged.kind === "answer") {
        log("refused", { step: stepId, reason: judged.reason, agent_type: agentType });
        res.writeHead(judged.status, { "content-type": judged.contentType, "x-openguardrails-verdict": judged.reason });
        return void res.end(judged.body);
      }
      const payload = judged.body ?? parsed;

      const failures: string[] = [];
      for (const name of order) {
        const upstream = gateway.upstreams[name]!;
        const body = Buffer.from(JSON.stringify(rewriteBody(payload, upstream)));
        const reason = await attempt(name, upstream, url.pathname, protocol, stepId, agentType, req.method!, req.headers, body, res);
        if (reason === null) {
          if (failures.length > 0) {
            lastFailover = { to: name, failed: failures, t: new Date().toISOString() };
            log("failover", lastFailover as Record<string, unknown>);
            process.stderr.write(`[openguardrails] served by ${name} after: ${failures.join("; ")}\n`);
          }
          return;
        }
        if (res.destroyed) return;
        health.fail(name);
        failures.push(`${name}: ${reason}`);
      }
      log("exhausted", { failed: failures });
      return json(res, 502, { error: { message: `openguardrails gateway: every upstream failed. ${failures.join("; ")}`, type: "rontye_upstreams_failed" } });
    } catch (error) {
      if (!res.headersSent) return json(res, 400, { error: { message: `openguardrails gateway: ${String(error)}` } });
      res.destroy();
    }
  });
  // No proxy-side idle limit: a reasoning model can be silent for a long time.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.timeout = 0;
  const port = gateway.port ?? 4180;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    // Loopback only: this process holds the keys.
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
