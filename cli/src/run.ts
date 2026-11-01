/** `openguardrails run`: start a command in the sandbox and record what its whole process tree does. */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import zlib from "node:zlib";
import { SandboxManager, type FilterRequestCallback, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { airsTarget, guardEvent, report } from "./airs.js";
import { keyEnvNames, loadConfig, looseConfigWarning } from "./config.js";
import { Correlator } from "./correlate.js";
import { fileObservation, type Observation } from "./exec.js";
import { classifyModelRequest, harnessFrom, hostsIn, toolCallsIn, toolResultIdsIn, type LlmProtocol } from "./model.js";
import { buildPolicy, isLocalTarget, openLoopbackPort, type PolicyOptions } from "./policy.js";
import { Recorder, safePath } from "./record.js";
import { ensureGateway, gatewayPort, gatewayToken, hydrateEnv } from "./serve.js";

export interface RunOptions extends Omit<PolicyOptions, "cwd"> {
  enforce: boolean;
  allowLocalBinding?: boolean;
  command: string[];
}

/** A connection waits this long for the tool call that names it, which only arrives with the next model request. */
const GRACE_MS = 120_000;

function decode(bytes: Buffer, encoding: string): Buffer {
  switch (encoding) {
    case "gzip": return zlib.gunzipSync(bytes);
    case "br": return zlib.brotliDecompressSync(bytes);
    case "deflate": return zlib.inflateSync(bytes);
    case "zstd": return zlib.zstdDecompressSync(bytes);
    default: return bytes;
  }
}

const quote = (arg: string) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`);

export async function run(options: RunOptions): Promise<number> {
  const runId = `${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${randomBytes(3).toString("hex")}`;
  const recorder = new Recorder(runId);
  const correlator = new Correlator();
  const settings = loadConfig();
  hydrateEnv(settings);
  const warning = looseConfigWarning(settings);
  if (warning) process.stderr.write(`[openguardrails] ${warning}\n`);
  const airs = airsTarget(settings);
  // The gateway reports what passes through it; reporting it here too would judge each call twice.
  const ownPort = settings.gateway ? gatewayPort(settings) : null;
  if (settings.gateway) await ensureGateway(settings);
  const seenCalls = new Set<string>();
  const command = options.command.map(quote).join(" ");

  // Set once a tool result answers a call this run never saw. From then on "no tool call named it"
  // cannot be claimed, because a call we cannot see may have named it.
  const blindTo = new Set<string>();

  const flush = (final = false) => {
    for (const found of correlator.flush(Date.now(), GRACE_MS, final)) {
      const { bytesUp, ...rest } = found;
      const verified = blindTo.size === 0;
      recorder.write(verified ? "undeclared" : "unverified", { ...rest, bytes_up: bytesUp, blind_to: [...blindTo] });
      const label = verified ? "undeclared destination" : "unverified destination";
      process.stderr.write(`[openguardrails] ${label}: ${found.host} (${found.methods.join("/")}, ${bytesUp}B up)\n`);
    }
  };

  // Calls that went straight to the gateway never pass this process's proxy, so they are asked for.
  const startedAt = Date.now();
  let lastActivity = startedAt;
  let servedAtStart: number | null = null;
  const syncGateway = async () => {
    if (ownPort === null) return;
    try {
      const response = await fetch(`http://127.0.0.1:${ownPort}/__ogr/activity?since=${lastActivity}`, { headers: { "x-openguardrails-token": gatewayToken() }, signal: AbortSignal.timeout(2000) });
      const seen = (await response.json()) as { served: number; blind_to: string[]; calls: Array<{ t: number; agent: string; name: string; hosts: string[] }> };
      servedAtStart ??= seen.served;
      if (seen.served > servedAtStart) correlator.noteModelHost("127.0.0.1");
      for (const name of seen.blind_to) blindTo.add(name);
      for (const call of seen.calls) {
        lastActivity = Math.max(lastActivity, call.t);
        correlator.noteDeclared(call.hosts);
        recorder.write("tool_call", { harness: call.agent, name: call.name, hosts: call.hosts });
      }
    } catch {
      // Judged on what is known; the final pass tries again.
    }
  };

  // The sandbox's half of the story, sent to the gateway, which knows which tool call was open.
  let outbox: Observation[] = [];
  const sendObservations = async () => {
    if (ownPort === null || outbox.length === 0) return;
    const batch = outbox;
    outbox = [];
    await fetch(`http://127.0.0.1:${ownPort}/__ogr/observe`, {
      method: "POST",
      headers: { "x-openguardrails-token": gatewayToken() },
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(2000),
    }).catch(() => undefined);
  };
  const observeTimer = setInterval(() => void sendObservations(), 250);

  const readModelRequest = async (request: Request, host: string, protocol: LlmProtocol, viaGateway: boolean) => {
    const harness = harnessFrom(request.headers.get("user-agent") ?? "");
    let body: any;
    try {
      const raw = Buffer.from(await new Response(request.body).arrayBuffer());
      body = JSON.parse(decode(raw, request.headers.get("content-encoding") ?? "").toString("utf8"));
    } catch (error) {
      recorder.write("model", { harness, host, protocol, unparsed: String(error) });
      return;
    }
    recorder.write("model", { harness, host, protocol, model: body?.model });
    for (const call of toolCallsIn(protocol, body)) {
      if (seenCalls.has(call.id)) continue;
      seenCalls.add(call.id);
      const hosts = hostsIn(call.args);
      correlator.noteDeclared(hosts);
      recorder.write("tool_call", { harness, name: call.name, hosts });
    }
    if (toolResultIdsIn(protocol, body).some((id) => !seenCalls.has(id))) blindTo.add(harness);
    flush();
    if (airs && !viaGateway) {
      report(airs, guardEvent(runId, harness, protocol, body, airs.agentId))
        .then((verdict) => recorder.write("verdict", verdict))
        .catch((error) => recorder.write("verdict", { decision: "unjudged", findings: 0, error: String(error) }));
    }
  };

  // Answers straight away and reads the body beside the forward, so recording never delays a request.
  const filterRequest: FilterRequestCallback = async (request, info) => {
    const url = new URL(request.url);
    const host = info?.target?.host ?? url.hostname;
    const bytes = Number(request.headers.get("content-length") ?? 0);
    const protocol = classifyModelRequest(request.method, url.pathname);
    const ownTraffic = ownPort !== null && host === "127.0.0.1" && info?.target?.port === ownPort;
    if (!protocol && !ownTraffic) outbox.push({ t: Date.now(), kind: "network", target: `${host}:${info?.target?.port ?? (url.protocol === "https:" ? 443 : 80)}`, action: request.method, ...(bytes ? { bytes } : {}) });
    if (protocol) {
      correlator.noteModelHost(host);
      void readModelRequest(request, host, protocol, ownPort !== null && host === "127.0.0.1" && info?.target?.port === ownPort);
    } else {
      correlator.noteConnection(host, request.method, bytes, Date.now());
      recorder.write("request", { method: request.method, host, path: safePath(url.pathname), bytes });
    }
    return { action: "allow" };
  };

  const config: SandboxRuntimeConfig = {
    ...buildPolicy({
      cwd: process.cwd(),
      allowHosts: [
        ...options.allowHosts,
        ...(settings.sandbox?.allowHosts ?? []),
        ...(ownPort !== null ? [`127.0.0.1:${ownPort}`] : []),
      ],
      denyHosts: [...options.denyHosts, ...(settings.sandbox?.denyHosts ?? [])],
      allowRead: [...options.allowRead, ...(settings.sandbox?.allowRead ?? [])],
      allowWrite: [...options.allowWrite, ...(settings.sandbox?.allowWrite ?? [])],
      allowLocalBinding: options.allowLocalBinding || settings.sandbox?.allowLocalBinding === true,
    }),
  };
  config.network = { ...config.network, tlsTerminate: {}, filterRequest } as typeof config.network;

  const deps = SandboxManager.checkDependencies();
  if (deps.errors.length > 0) {
    process.stderr.write(`[openguardrails] cannot start: ${deps.errors.join("; ")}\n`);
    return 127;
  }

  const ask = async ({ host, port }: { host: string; port?: number | undefined }) => {
    const local = isLocalTarget(host);
    recorder.write("connect", { host, port, allowed: !options.enforce && !local });
    if (local || options.enforce) outbox.push({ t: Date.now(), kind: "network", target: `${host}:${port}`, denied: true });
    if (local) return { allow: false as const, reason: `openguardrails: ${host} is this machine or a metadata endpoint. Allow it with --allow-host ${host}:${port}` };
    if (!options.enforce) return true;
    return { allow: false as const, reason: `openguardrails: ${host} is not allowed. Add it with --allow-host ${host}` };
  };
  // The third argument turns on the violation monitor; denied reads are not reported without it.
  await SandboxManager.initialize(config, ask, true);

  const seenViolations = new Set<string>();
  const unsubscribe = SandboxManager.getSandboxViolationStore().subscribe((violations) => {
    for (const violation of violations) {
      const key = `${violation.timestamp.getTime()}:${violation.line}`;
      if (seenViolations.has(key)) continue;
      seenViolations.add(key);
      // macOS reports every process's routine system probes; only files and network mean anything here.
      if (/deny\S* (sysctl|system-info|mach-|iokit|ipc-|process-info)/.test(violation.line)) continue;
      recorder.write("violation", { line: violation.line });
      const file = fileObservation(violation.line, violation.timestamp.getTime());
      if (file) outbox.push(file);
    }
  });

  recorder.write("start", { mode: options.enforce ? "enforce" : "observe", command: options.command[0], run: runId });
  // sandbox-runtime exempts loopback and private ranges from the proxy, and those clients then fail
  // inside the sandbox. A local vLLM is what this tool exists to see, so everything goes through it.
  // NODE_USE_ENV_PROXY makes Node's own fetch honour the proxy; the pinned release does not set it.
  let wrapped = await SandboxManager.wrapWithSandbox(`NO_PROXY= no_proxy= NODE_USE_ENV_PROXY=1 ${command}`, undefined, undefined, undefined, {
    commandId: runId,
    commandText: command,
  });
  if (ownPort !== null && process.platform === "darwin") wrapped = openLoopbackPort(wrapped, ownPort);
  const childEnv = { ...process.env };
  for (const name of keyEnvNames(settings)) delete childEnv[name];
  const child = spawn(wrapped, { shell: true, stdio: "inherit", env: childEnv });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
  await syncGateway();
  const syncTimer = setInterval(() => void syncGateway().then(() => flush()), 15_000);
  const code = await new Promise<number>((resolve) => {
    child.on("error", () => resolve(127));
    child.on("exit", (exitCode, signal) => resolve(exitCode ?? (signal ? 128 : 1)));
  });

  // The macOS violation monitor reads an asynchronous system log, and body reads may be in flight.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  clearInterval(syncTimer);
  clearInterval(observeTimer);
  await sendObservations();
  await syncGateway();
  flush(true);
  recorder.write("exit", { code });
  unsubscribe();
  await SandboxManager.reset();
  process.stderr.write(`[openguardrails] run ${runId} recorded. See: openguardrails log ${runId}\n`);
  return code;
}
