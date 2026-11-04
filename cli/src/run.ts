/** `openguardrails run`: start a command in the sandbox and record what its whole process tree does. */
import { spawn } from "node:child_process";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";
import { SandboxManager, type FilterRequestCallback, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { airsTarget, guardEvent, report } from "./airs.js";
import { keyEnvNames, loadConfig, looseConfigWarning } from "./config.js";
import { Correlator } from "./correlate.js";
import { fileObservation, type Observation } from "./exec.js";
import { classifyModelRequest, harnessFrom, hostsIn, toolCallsIn, toolResultIdsIn, type LlmProtocol } from "./model.js";
import { aliasProxyPort, bridgeGatewayPort, buildPolicy, exposePort, reportAllowed, gpuDevices, passDevices, socketsToHide, isLocalTarget, openLoopbackPort, proxyCredentials, type PolicyOptions } from "./policy.js";
import { Recorder, safePath } from "./record.js";
import { ensureGateway, gatewayPort, gatewayToken, hydrateEnv } from "./serve.js";
import { notify } from "./notify.js";
import { BROKER_PORT, startBroker, unitMatcher, writeShims } from "./broker.js";
import { Deduper, isRoutineRead, ObserveLog, parseSeatbeltReport, preloadLibrary, type FileEvent } from "./observe.js";
import { describeActivity, isBusy, newestChange, processTreeCpu, StallWatch, type Activity } from "./watch.js";
import { isUpstreamAddress, NO_PROXY, parseUpstreamProxy, startProxyAuthBridge, startUpstreamRelay, upstreamFromEnv, type Relay } from "./upstream.js";

export interface RunOptions extends Omit<PolicyOptions, "cwd"> {
  enforce: boolean;
  allowLocalBinding?: boolean;
  /** Ports a server inside the sandbox listens on, to reach from this machine's 127.0.0.1. */
  /** Servers the command starts, reachable on this machine at host:port (127.0.0.1 unless given). */
  expose?: Array<{ host: string; port: number }>;
  /** This machine's loopback ports the command may connect to directly, without the proxy. */
  bridge?: number[];
  /** systemd user units the command may manage with systemctl and journalctl, by pattern. */
  units?: string[];
  upstreamProxy?: string | undefined;
  /** How the run is named in its record and matched by rules; the command line by default. */
  label?: string;
  /** The named sandbox this run holds; its units may be managed from inside it. */
  sandboxName?: string;
  /** Called once the sandbox is started; may return how to measure the CPU of everything in it. */
  onStarted?: (childPid: number) => Promise<(() => number) | undefined>;
  devices?: string[];
  command: string[];
}

/** Where a Linux sandbox finds the proxy when the machine has no local upstream proxy to stand in for. */
const INNER_PROXY_PORT = 3129;

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
  // What a stall rule counts as being busy. The gateway's numbers cover every agent that uses it.
  let networkEvents = 0;
  let openConnections = 0;
  let modelServed = 0;
  let modelWaiting = 0;
  const syncGateway = async () => {
    if (ownPort === null) return;
    try {
      const response = await fetch(`http://127.0.0.1:${ownPort}/__ogr/activity?since=${lastActivity}`, { headers: { "x-openguardrails-token": gatewayToken() }, signal: AbortSignal.timeout(2000) });
      const seen = (await response.json()) as { served: number; inflight?: number; blind_to: string[]; calls: Array<{ t: number; agent: string; name: string; hosts: string[] }> };
      servedAtStart ??= seen.served;
      modelServed = seen.served;
      modelWaiting = seen.inflight ?? 0;
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

  // Each path once per run in the log; each action on it once per ten seconds to the gateway.
  const recordedPaths = new Set<string>();
  const deduper = new Deduper();
  let observeLog: ObserveLog | null = null;
  const handleFileEvents = (events: FileEvent[]) => {
    for (const event of events) {
      if (event.action === "read" && isRoutineRead(event.path)) continue;
      // A terminal, /dev/null and the like are where every program writes; they say nothing.
      if (event.path.startsWith("/dev/")) continue;
      if (!deduper.fresh(event)) continue;
      outbox.push({ t: event.t, kind: "file", target: event.path, action: event.action, process: event.process });
      const key = `${event.action}\t${event.path}`;
      if (!recordedPaths.has(key)) {
        recordedPaths.add(key);
        recorder.write("file", { action: event.action, path: event.path, process: event.process });
      }
    }
  };
  const readObserveLog = () => handleFileEvents(observeLog?.read() ?? []);
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
  const observeTimer = setInterval(() => {
    readObserveLog();
    void sendObservations();
  }, 250);

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
    if (!ownTraffic) networkEvents += 1;
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
        networkEvents += 1;
        openConnections += 1;
        // A tunnel is not decrypted on this route, so its connection is all there is to record.
        if (method === "CONNECT") {
          outbox.push({ t: now, kind: "network", target: `${host}:${port}`, action: method });
          correlator.noteConnection(host, method, 0, now);
        }
      },
      ({ method, host, port }, bytesUp, bytesDown) => {
        openConnections -= 1;
        if (method === "CONNECT") recorder.write("request", { method, host, port, bytes: bytesUp, bytes_down: bytesDown, via: "upstream" });
      },
    );
    process.stderr.write(`[openguardrails] out through the upstream proxy ${upstream.host}:${upstream.port}\n`);
  }

  const expose = [...(options.expose ?? []), ...(settings.sandbox?.expose ?? []).map(parseExpose)];
  const bridgePorts = [...new Set([...(options.bridge ?? []), ...(settings.sandbox?.bridge ?? [])])].filter((port) => port !== ownPort);
  if (upstream && ["127.0.0.1", "localhost", "::1"].includes(upstream.host) && bridgePorts.includes(upstream.port)) {
    process.stderr.write(`[openguardrails] cannot start: port ${upstream.port} is the upstream proxy. Commands reach it through openguardrails, so it must not be bridged\n`);
    relay?.close();
    return 2;
  }
  const units = [...(options.units ?? []), ...(settings.sandbox?.units ?? [])];
  // Where the Linux relays' sockets live. The sandbox creates the exposed ones, so it may write here.
  // On Linux the sandbox has its own 127.0.0.1, so the proxy port an agent names can be this tool's.
  // On macOS it is this machine's, where the real proxy listens, and the sandbox refuses it.
  const named = upstream && process.platform === "linux" && ["127.0.0.1", "localhost", "::1"].includes(upstream.host) ? upstream.port : null;
  // sandbox-runtime's proxy wants per-run credentials, which a client that speaks to a proxy by hand
  // does not send (voicego's health probe did not, saw 407 and went around the proxy). On Linux the
  // proxy the sandbox is told about is a port where this tool adds them: the upstream's port when
  // that is local, so an agent naming it needs no change, or 3129.
  const aliasPort = process.platform === "linux" ? (named ?? INNER_PROXY_PORT) : null;
  // What the sandbox allows it does not report on Linux; a preloaded library writes it down instead.
  const preload = preloadLibrary();
  if (process.platform === "linux" && !preload) process.stderr.write("[openguardrails] this install has no file and exec telemetry for Linux; allowed reads, writes and commands are not recorded\n");
  const bridgeDir = process.platform === "linux" ? mkdtempSync(join(tmpdir(), "openguardrails-")) : null;
  if (process.platform !== "linux" && (bridgePorts.length > 0 || units.length > 0)) process.stderr.write("[openguardrails] --bridge and --units are for Linux; on macOS the command shares this machine's ports and systemd is not there\n");
  const shims = bridgeDir && units.length > 0 ? writeShims(bridgeDir, BROKER_PORT) : null;
  observeLog = preload && bridgeDir ? new ObserveLog(join(bridgeDir, "observe.log")) : null;
  const config: SandboxRuntimeConfig = {
    ...buildPolicy({
      cwd: process.cwd(),
      // A bridged service is meant to be reached; clients that send it through the proxy reach it too.
      allowHosts: [...allowHosts, ...(ownPort !== null ? [`127.0.0.1:${ownPort}`] : []), ...bridgePorts.map((port) => `127.0.0.1:${port}`)],
      denyHosts: [...options.denyHosts, ...(settings.sandbox?.denyHosts ?? [])],
      allowRead: [...options.allowRead, ...(settings.sandbox?.allowRead ?? [])],
      allowWrite: [...options.allowWrite, ...(settings.sandbox?.allowWrite ?? []), ...(bridgeDir && (expose.length > 0 || observeLog) ? [bridgeDir] : [])],
      allowLocalBinding: options.allowLocalBinding || expose.length > 0 || settings.sandbox?.allowLocalBinding === true,
    }),
  };
  // sandbox-runtime does not send a connection it decrypts to a parent proxy. Behind an upstream,
  // HTTPS therefore stays opaque, and the relay records where each tunnel went.
  // The GPU needs Unix sockets; the socket files on this machine are hidden instead (see socketsToHide).
  const wantsGpu = process.platform === "linux" && [...(options.devices ?? []), ...(settings.sandbox?.devices ?? [])].some((device) => device === "gpu" || /^\/dev\/nvidia/.test(device));
  if (wantsGpu) {
    const hidden = socketsToHide().filter((path) => !bridgeDir || !path.startsWith(bridgeDir));
    config.filesystem = { ...config.filesystem, denyRead: [...(config.filesystem?.denyRead ?? []), ...hidden] } as typeof config.filesystem;
    recorder.write("gpu", { unix_sockets: "allowed", hidden });
    process.stderr.write(`[openguardrails] --gpu: the command may create Unix sockets, which CUDA needs; ${hidden.length} socket paths on this machine are hidden from it\n`);
  }
  config.network = {
    ...(wantsGpu ? { allowAllUnixSockets: true } : {}),
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
    networkEvents += 1;
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

  recorder.write("start", { mode: options.enforce ? "enforce" : "observe", command: options.label ?? options.command[0], run: runId });
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
  const telemetry = observeLog ? `LD_PRELOAD=${quote([preload!, process.env.LD_PRELOAD].filter(Boolean).join(":"))} OGR_OBSERVE_LOG=${quote(observeLog.path)} ` : "";
  const proxyEnv = aliasPort !== null ? ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"].map((name) => `${name}=http://127.0.0.1:${aliasPort} `).join("") : "";
  const brokered = shims ? `OGR_SANDBOX_BIN=${quote(shims)} PATH=${quote(shims)}:"$PATH" ` : "";
  let wrapped = await SandboxManager.wrapWithSandbox(`${telemetry}${brokered}${proxyEnv}NO_PROXY= no_proxy= NODE_USE_ENV_PROXY=1 ${command}`, undefined, undefined, undefined, {
    commandId: runId,
    commandText: command,
  });
  if (ownPort !== null && process.platform === "darwin") wrapped = openLoopbackPort(wrapped, ownPort);
  // macOS: what Seatbelt allows is reported to the unified log under this run's tag, and read here.
  let stopReports = () => undefined as void;
  if (process.platform === "darwin") {
    try {
      const reported = reportAllowed(wrapped);
      wrapped = reported.wrapped;
      stopReports = streamSeatbeltReports(reported.tag, handleFileEvents);
      // The stream takes a moment to attach; what the command does first would otherwise be missed.
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (error) {
      process.stderr.write(`[openguardrails] ${(error as Error).message}\n`);
    }
  }
  const wanted = [...(options.devices ?? []), ...(settings.sandbox?.devices ?? [])];
  const devices = wanted.flatMap((device) => (device === "gpu" ? gpuDevices() : [device]));
  if (process.platform === "linux" && wanted.includes("gpu") && !devices.some((device) => /nvidia\d/.test(device))) process.stderr.write("[openguardrails] --gpu: this machine has no NVIDIA device in /dev\n");
  if (devices.length > 0) {
    if (process.platform !== "linux") process.stderr.write("[openguardrails] devices are passed to the sandbox on Linux only; on macOS the command already sees them\n");
    else {
      wrapped = passDevices(wrapped, [...new Set(devices)]);
      recorder.write("devices", { devices: [...new Set(devices)] });
    }
  }
  if (ownPort !== null && bridgeDir) {
    const socket = join(bridgeDir, "gateway.sock");
    wrapped = bridgeGatewayPort(wrapped, ownPort, socket);
    relays.push(await pipe({ path: socket }, () => net.connect(ownPort, "127.0.0.1")));
  }
  if (bridgeDir) for (const { port } of expose) wrapped = exposePort(wrapped, port, join(bridgeDir, `expose-${port}.sock`));
  // Clients that connect to a local service directly, without the proxy, find it at the same port.
  for (const port of bridgeDir ? bridgePorts : []) {
    const socket = join(bridgeDir!, `bridge-${port}.sock`);
    wrapped = bridgeGatewayPort(wrapped, port, socket);
    relays.push(
      await pipe({ path: socket }, () => {
        networkEvents += 1;
        recorder.write("connect", { host: "127.0.0.1", port, allowed: true, via: "bridge" });
        return net.connect(port, "127.0.0.1");
      }),
    );
  }
  if (shims && bridgeDir) {
    const socket = join(bridgeDir, "broker.sock");
    wrapped = bridgeGatewayPort(wrapped, BROKER_PORT, socket);
    const unitAllowed = unitMatcher(units);
    relays.push(await startBroker(socket, options.sandboxName ?? null, unitAllowed, (tool, args, refused) => recorder.write("broker", { tool, args, refused })));
  }
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
    for (const { host, port } of expose) {
      const socket = join(bridgeDir, `expose-${port}.sock`);
      void (async () => {
        for (let i = 0; i < 200 && !existsSync(socket); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
        if (!existsSync(socket)) return void process.stderr.write(`[openguardrails] could not expose port ${port}: the sandbox did not start its relay\n`);
        try {
          relays.push(await pipe({ port, host }, () => net.connect(socket)));
        } catch (error) {
          process.stderr.write(`[openguardrails] could not expose port ${port} on this machine: ${String(error)}\n`);
        }
      })();
    }
  }
  await syncGateway();
  const syncTimer = setInterval(() => void syncGateway().then(() => flush()), 15_000);
  const cpuOf = child.pid !== undefined && options.onStarted ? await options.onStarted(child.pid) : undefined;
  const stopWatching = watchForStalls(settings, options.label ?? command, runId, child.pid, recorder, () => ({ networkEvents, openConnections, modelServed, modelWaiting }), cpuOf);
  const code = await new Promise<number>((resolve) => {
    child.on("error", () => resolve(127));
    child.on("exit", (exitCode, signal) => resolve(exitCode ?? (signal ? 128 : 1)));
  });

  // The macOS violation monitor reads an asynchronous system log, and body reads may be in flight.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  clearInterval(syncTimer);
  clearInterval(observeTimer);
  readObserveLog();
  stopReports();
  stopWatching();
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

interface Counters {
  networkEvents: number;
  openConnections: number;
  modelServed: number;
  modelWaiting: number;
}

/**
 * The person's stall rules that apply to this command. Each is checked every quarter of its quiet
 * window, at most once a minute, and sends one message when the command gets stuck and one when it
 * moves again.
 */
function watchForStalls(settings: ReturnType<typeof loadConfig>, command: string, runId: string, pid: number | undefined, recorder: Recorder, counters: () => Counters, cpuOf?: () => number): () => void {
  const rules = (settings.watches ?? []).filter((rule) => !rule.command || command.includes(rule.command));
  if (rules.length === 0 || pid === undefined) return () => undefined;
  const startedAt = Date.now();
  const watches = rules.map((rule) => new StallWatch(rule, startedAt));
  const pollMs = Math.max(5_000, Math.min(60_000, (Math.min(...rules.map((rule) => rule.idleMinutes)) * 60_000) / 4));
  const cpuNow = cpuOf ?? (() => processTreeCpu(pid));
  let last = { t: startedAt, cpu: cpuNow(), ...counters() };
  const send = (channels: string[], subject: string, lines: string[]) =>
    void notify(settings, channels, { subject, text: lines.join("\n") }).then((failures) => {
      recorder.write("notify", { subject, channels, failures });
      for (const failure of failures) process.stderr.write(`[openguardrails] could not send "${subject}": ${failure}\n`);
    });
  const timer = setInterval(() => {
    const now = Date.now();
    const cpu = cpuNow();
    const current = counters();
    const activity: Activity = {
      // Processes that ended since the last look take their CPU time with them, so this never goes negative.
      cpuPercent: Math.max(0, ((cpu - last.cpu) * 100_000) / Math.max(1, now - last.t)),
      networkEvents: current.networkEvents - last.networkEvents,
      openConnections: current.openConnections,
      modelCalls: current.modelServed - last.modelServed,
      modelWaiting: current.modelWaiting,
    };
    last = { t: now, cpu, ...current };
    const busy = isBusy(activity);
    for (const watch of watches) {
      const progress = newestChange(watch.rule.progress);
      const change = watch.step({ t: now, busy, activity }, progress.t);
      if (!change) continue;
      const minutes = (ms: number) => Math.round(ms / 60_000);
      if (change.kind === "stalled") {
        recorder.write("stalled", { rule: watch.rule.name, idle_ms: change.idleMs, activity: change.busyWith, last_output: progress.path });
        send(watch.rule.notify, `[OpenGuardrails] stuck: ${watch.rule.name}`, [
          watch.rule.name,
          "",
          `Busy for ${minutes(change.idleMs)} minutes without new output.`,
          "",
          `Command: ${command}`,
          `Run: ${runId} on ${hostname()}`,
          `Last output: ${progress.path ?? "none"}${progress.t ? ` at ${new Date(progress.t).toISOString()}` : ""}`,
          `Busy with: ${describeActivity(change.busyWith)}`,
          "",
          `What it did: openguardrails log ${runId}`,
        ]);
      } else {
        recorder.write("recovered", { rule: watch.rule.name, stalled_ms: change.stalledMs, output: progress.path });
        send(watch.rule.notify, `[OpenGuardrails] moving again: ${watch.rule.name}`, [
          watch.rule.name,
          "",
          `New output after ${minutes(change.stalledMs)} minutes stuck: ${progress.path}`,
          "",
          `Run: ${runId} on ${hostname()}`,
        ]);
      }
    }
  }, pollMs);
  return () => clearInterval(timer);
}

/** `8765`, `0.0.0.0:8765` or `192.168.0.10:8766`: where on this machine a server in the sandbox is reached. */
export function parseExpose(spec: string | number): { host: string; port: number } {
  const text = String(spec);
  const at = text.lastIndexOf(":");
  const host = at === -1 ? "127.0.0.1" : text.slice(0, at).replace(/^\[|\]$/g, "");
  const port = Number(at === -1 ? text : text.slice(at + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !host) throw new Error(`--expose needs [address:]port, not ${text}`);
  return { host, port };
}

/** Follows the unified log for Seatbelt's reports under `tag` and hands each allowed operation on. */
function streamSeatbeltReports(tag: string, onEvents: (events: FileEvent[]) => void): () => void {
  const log = spawn("/usr/bin/log", ["stream", "--style", "ndjson", "--predicate", `eventMessage ENDSWITH "${tag}" AND eventMessage CONTAINS " allow "`], { stdio: ["ignore", "pipe", "ignore"] });
  let rest = "";
  log.stdout.on("data", (chunk: Buffer) => {
    const lines = (rest + chunk.toString("utf8")).split("\n");
    rest = lines.pop() ?? "";
    const events: FileEvent[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as { eventMessage?: string; timestamp?: string };
        // "2026-11-04 04:17:07.993-0800": ISO wants a T and a colon in the offset.
        const t = entry.timestamp ? Date.parse(entry.timestamp.replace(" ", "T").replace(/([+-]\d\d)(\d\d)$/, "$1:$2")) : NaN;
        const event = entry.eventMessage ? parseSeatbeltReport(entry.eventMessage, Number.isFinite(t) ? t : Date.now()) : null;
        if (event) events.push(event);
      } catch {
        // The header line, or a partial one.
      }
    }
    if (events.length > 0) onEvents(events);
  });
  log.on("error", () => undefined);
  return () => void log.kill();
}
