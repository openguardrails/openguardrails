/** `openguardrails run`: start a command in the sandbox and record what its whole process tree does. */
import { spawn } from "node:child_process";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";
import { SandboxManager, type FilterRequestCallback, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { airsTarget, guardEvent, report } from "./airs.js";
import { keyEnvNames, loadConfig, looseConfigWarning } from "./config.js";
import { Correlator } from "./correlate.js";
import { fileObservation, type Observation } from "./exec.js";
import { classifyModelRequest, harnessFrom, hostsIn, toolCallsIn, toolResultIdsIn, type LlmProtocol } from "./model.js";
import { aliasProxyPort, bridgeGatewayPort, buildPolicy, exposePort, isLocalTarget, openLoopbackPort, proxyCredentials, type PolicyOptions } from "./policy.js";
import { Recorder, safePath } from "./record.js";
import { ensureGateway, gatewayPort, gatewayToken, hydrateEnv } from "./serve.js";
import { isUpstreamAddress, NO_PROXY, parseUpstreamProxy, startProxyAuthBridge, startUpstreamRelay, upstreamFromEnv, type Relay } from "./upstream.js";

export interface RunOptions extends Omit<PolicyOptions, "cwd"> {
  enforce: boolean;
  allowLocalBinding?: boolean;
  /** Ports a server inside the sandbox listens on, to reach from this machine's 127.0.0.1. */
  expose?: number[];
  upstreamProxy?: string | undefined;
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

  const allowHosts = [...options.allowHosts, ...(settings.sandbox?.allowHosts ?? [])];
  let upstream;
  try {
    upstream = parseUpstreamProxy(options.upstreamProxy ?? settings.sandbox?.upstreamProxy ?? upstreamFromEnv(process.env));
  } catch (error) {
    process.stderr.write(`[openguardrails] cannot start: ${(error as Error).message}\n`);
    return 2;
  }
  // Reaching the upstream proxy directly is a way out that this tool would see as one host.
  const around = upstream ? allowHosts.find((pattern) => isUpstreamAddress(upstream!, pattern)) : undefined;
  if (around) {
    process.stderr.write(`[openguardrails] cannot start: ${around} is the upstream proxy. Commands reach it through openguardrails, so it must not be allowed directly\n`);
    return 2;
  }
  let relay: Relay | null = null;
  if (upstream) {
    relay = await startUpstreamRelay(
      upstream,
      ({ method, host, port }) => {
        const now = Date.now();
        // A tunnel is not decrypted on this route, so its connection is all there is to record.
        if (method === "CONNECT") {
          outbox.push({ t: now, kind: "network", target: `${host}:${port}`, action: method });
          correlator.noteConnection(host, method, 0, now);
        }
      },
      ({ method, host, port }, bytesUp, bytesDown) => {
        if (method === "CONNECT") recorder.write("request", { method, host, port, bytes: bytesUp, bytes_down: bytesDown, via: "upstream" });
      },
    );
    process.stderr.write(`[openguardrails] out through the upstream proxy ${upstream.host}:${upstream.port}\n`);
  }

  const expose = options.expose ?? [];
  // Where the Linux relays' sockets live. The sandbox creates the exposed ones, so it may write here.
  // On Linux the sandbox has its own 127.0.0.1, so the proxy port an agent names can be this tool's.
  // On macOS it is this machine's, where the real proxy listens, and the sandbox refuses it.
  const aliasPort = upstream && process.platform === "linux" && ["127.0.0.1", "localhost", "::1"].includes(upstream.host) ? upstream.port : null;
  const bridgeDir = process.platform === "linux" && (ownPort !== null || expose.length > 0 || aliasPort !== null) ? mkdtempSync(join(tmpdir(), "openguardrails-")) : null;
  const config: SandboxRuntimeConfig = {
    ...buildPolicy({
      cwd: process.cwd(),
      allowHosts: [...allowHosts, ...(ownPort !== null ? [`127.0.0.1:${ownPort}`] : [])],
      denyHosts: [...options.denyHosts, ...(settings.sandbox?.denyHosts ?? [])],
      allowRead: [...options.allowRead, ...(settings.sandbox?.allowRead ?? [])],
      allowWrite: [...options.allowWrite, ...(settings.sandbox?.allowWrite ?? []), ...(bridgeDir && expose.length > 0 ? [bridgeDir] : [])],
      allowLocalBinding: options.allowLocalBinding || expose.length > 0 || settings.sandbox?.allowLocalBinding === true,
    }),
  };
  // sandbox-runtime does not send a connection it decrypts to a parent proxy. Behind an upstream,
  // HTTPS therefore stays opaque, and the relay records where each tunnel went.
  config.network = {
    ...config.network,
    ...(relay ? { parentProxy: { http: `http://127.0.0.1:${relay.port}`, https: `http://127.0.0.1:${relay.port}`, noProxy: NO_PROXY } } : { tlsTerminate: {} }),
    filterRequest,
  } as typeof config.network;

  const deps = SandboxManager.checkDependencies();
  if (deps.errors.length > 0) {
    process.stderr.write(`[openguardrails] cannot start: ${deps.errors.join("; ")}\n`);
    relay?.close();
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
  // This machine's side of each Linux relay runs in this process, so it ends with the run however
  // the run ends. The sandbox's side ends with the sandbox's namespace.
  const relays: net.Server[] = [];
  const pipe = (listen: net.ListenOptions, dial: () => net.Socket): Promise<net.Server> =>
    new Promise((resolve, reject) => {
      const server = net.createServer((inbound) => {
        const outbound = dial();
        inbound.pipe(outbound).pipe(inbound);
        const close = () => {
          inbound.destroy();
          outbound.destroy();
        };
        inbound.on("error", close);
        outbound.on("error", close);
      });
      server.once("error", reject);
      server.listen(listen, () => resolve(server));
    });
  let wrapped = await SandboxManager.wrapWithSandbox(`NO_PROXY= no_proxy= NODE_USE_ENV_PROXY=1 ${command}`, undefined, undefined, undefined, {
    commandId: runId,
    commandText: command,
  });
  if (ownPort !== null && process.platform === "darwin") wrapped = openLoopbackPort(wrapped, ownPort);
  if (ownPort !== null && bridgeDir) {
    const socket = join(bridgeDir, "gateway.sock");
    wrapped = bridgeGatewayPort(wrapped, ownPort, socket);
    relays.push(await pipe({ path: socket }, () => net.connect(ownPort, "127.0.0.1")));
  }
  if (bridgeDir) for (const port of expose) wrapped = exposePort(wrapped, port, join(bridgeDir, `expose-${port}.sock`));
  const proxyPort = SandboxManager.getProxyPort();
  if (aliasPort !== null && bridgeDir && proxyPort) {
    const socket = join(bridgeDir, "proxy.sock");
    const credentials = proxyCredentials(wrapped) ?? { user: "openguardrails", token: SandboxManager.getProxyAuthToken() ?? "" };
    wrapped = aliasProxyPort(wrapped, aliasPort, socket);
    relays.push(await startProxyAuthBridge(socket, proxyPort, credentials.user, credentials.token));
  }
  const childEnv = { ...process.env };
  for (const name of keyEnvNames(settings)) delete childEnv[name];
  // `exec`, so the sandbox (bwrap or sandbox-exec) is this process's own child rather than a shell's.
  // bwrap's --die-with-parent then ends the whole sandbox when this run ends, even by SIGKILL; behind
  // a shell it would outlive a run killed without a chance to clean up.
  const child = spawn(`exec ${wrapped}`, { shell: true, stdio: "inherit", env: childEnv });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => child.kill(signal));
  // The inner relay creates each exposed socket once the sandbox is up; then this machine listens.
  if (bridgeDir) {
    for (const port of expose) {
      const socket = join(bridgeDir, `expose-${port}.sock`);
      void (async () => {
        for (let i = 0; i < 200 && !existsSync(socket); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
        if (!existsSync(socket)) return void process.stderr.write(`[openguardrails] could not expose port ${port}: the sandbox did not start its relay\n`);
        try {
          relays.push(await pipe({ port, host: "127.0.0.1" }, () => net.connect(socket)));
        } catch (error) {
          process.stderr.write(`[openguardrails] could not expose port ${port} on this machine: ${String(error)}\n`);
        }
      })();
    }
  }
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
  for (const relay of relays) relay.close();
  if (bridgeDir) rmSync(bridgeDir, { recursive: true, force: true });
  relay?.close();
  await SandboxManager.reset();
  process.stderr.write(`[openguardrails] run ${runId} recorded. See: openguardrails log ${runId}\n`);
  return code;
}
