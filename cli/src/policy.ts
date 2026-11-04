/** What a run may touch, as sandbox-runtime configuration. */
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

export interface PolicyOptions {
  cwd: string;
  allowHosts: string[];
  denyHosts: string[];
  allowRead: string[];
  allowWrite: string[];
  allowLocalBinding?: boolean;
}

/** Where credentials live. A starting point rather than a boundary: an unlisted path stays readable. */
const CREDENTIAL_PATHS = [
  // Its own keys, and shell startup files, where people export theirs.
  ".openguardrails", ".zshrc", ".zshenv", ".zprofile", ".bashrc", ".bash_profile", ".profile",
  ".ssh", ".aws", ".azure", ".oci", ".kube", ".gnupg", ".config/gcloud", ".config/gh",
  ".docker/config.json", ".netrc", ".npmrc", ".pypirc", ".pgpass", ".git-credentials", ".boto", ".my.cnf",
];

/** Where the agents this is built for keep their own state; without these they fail to start. */
const AGENT_STATE_PATHS = [
  ".claude", ".claude.json", ".codex", ".gemini", ".pi", ".dsh", ".hermes", ".openclaw", ".aider",
  ".config/opencode", ".local/share/opencode", ".local/state", ".cache", ".npm", ".bun", "Library/Caches",
];

/** macOS /tmp is a symlink, and sandbox-runtime silently drops a symlink that short as out of bounds. */
const real = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/**
 * This machine and the cloud metadata endpoints: what a poisoned model probes first, and never a
 * destination an agent found by itself. Allow one by name with --allow-host. Private LAN ranges
 * are not on this list, because intranet services are ordinary work.
 */
export function isLocalTarget(host: string): boolean {
  const name = host.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  if (name === "::1" || name === "::" || name.startsWith("fe80:") || name.startsWith("fd00:ec2:")) return true;
  if (name.startsWith("::ffff:")) return isLocalTarget(name.slice(7));
  return /^(127|0|169\.254)\.[\d.]+$/.test(name) || ["100.100.100.200", "168.63.129.16", "192.0.0.192", "metadata.google.internal"].includes(name);
}

/**
 * Opens one loopback port on macOS. Agents commonly refuse to proxy loopback addresses (dsh does,
 * by design), so the gateway must be reachable directly, and sandbox-runtime's only switch for
 * that opens every local port, browser debugging ports included.
 */
export function openLoopbackPort(wrapped: string, port: number): string {
  const rule = /\(allow network-outbound \(remote ip "localhost:\d+"\)\)/;
  if (!rule.test(wrapped)) throw new Error("this sandbox-runtime version has an unexpected profile; openguardrails cannot open the gateway port");
  return wrapped.replace(rule, (match) => `${match}\n(allow network-outbound (remote ip "localhost:${port}"))`);
}

/**
 * The Linux counterpart of openLoopbackPort. bubblewrap gives the sandbox its own network namespace,
 * so its 127.0.0.1 is not this machine's, and an agent that will not proxy loopback (dsh) cannot
 * reach the gateway. One socat on this machine turns a Unix socket into the gateway port; one inside
 * the sandbox listens on 127.0.0.1:<port> and dials that socket. Only the gateway port is bridged.
 *
 * The inner relay has to start where sandbox-runtime starts its own, before seccomp, which forbids
 * creating a Unix socket afterwards. So it goes right after their SOCKS relay in the wrapped script.
 */
export function bridgeGatewayPort(wrapped: string, port: number, socket: string): string {
  return insertRelay(wrapped, `socat TCP4-LISTEN:${port},bind=127.0.0.1,fork,reuseaddr,backlog=4096 UNIX-CONNECT:${socket}`, socket);
}

/**
 * The other direction, for an agent with a web UI: a server it starts inside the sandbox listens
 * in the sandbox's own namespace, out of the machine's sight. The relay inside turns that port into
 * a Unix socket, and `run` listens on 127.0.0.1:<port> on this machine and dials it.
 */
export function exposePort(wrapped: string, port: number, socket: string): string {
  return insertRelay(wrapped, `socat UNIX-LISTEN:${socket},fork,reuseaddr TCP4:127.0.0.1:${port}`, socket);
}

/**
 * An agent that names its own proxy (yt-dlp --proxy http://127.0.0.1:20171) must still go out only
 * through this tool. Inside the sandbox that port is relayed to a socket on which `run` adds
 * sandbox-runtime's per-run credentials and hands the request to its proxy, so the agent's requests
 * are filtered and written down like any other, then leave through the real proxy as the upstream.
 */
export function aliasProxyPort(wrapped: string, port: number, socket: string): string {
  return insertRelay(wrapped, `socat TCP4-LISTEN:${port},bind=127.0.0.1,fork,reuseaddr,backlog=4096 UNIX-CONNECT:${socket}`, socket);
}

/** The proxy credentials sandbox-runtime gave the command, which name it in what the proxy records. */
export function proxyCredentials(wrapped: string): { user: string; token: string } | null {
  const match = /HTTP_PROXY=http:\/\/([^:@\s'"]+):([^@\s'"]+)@localhost:\d+/.exec(wrapped);
  return match ? { user: decodeURIComponent(match[1]!), token: decodeURIComponent(match[2]!) } : null;
}

/** The NVIDIA devices CUDA needs: one per GPU, plus the control, memory and capability nodes. */
export function gpuDevices(list: (dir: string) => string[] = (dir) => readdirSync(dir)): string[] {
  let names: string[] = [];
  try {
    names = list("/dev").filter((name) => /^nvidia(\d+|ctl|-uvm|-uvm-tools|-modeset)$/.test(name)).map((name) => `/dev/${name}`);
    if (names.length > 0) names.push(...list("/dev/nvidia-caps").map((name) => `/dev/nvidia-caps/${name}`));
  } catch {
    // No GPU, or no capability nodes.
  }
  return names;
}

/**
 * CUDA cannot start without creating Unix sockets (one in the abstract namespace for its memory
 * manager), and the sandbox's seccomp filter forbids creating them. With a GPU that rule is lifted,
 * so a socket file becomes a way out: the Docker socket is root on this machine, the systemd user bus
 * starts any program outside the sandbox, an ssh-agent signs as you, an X server takes keystrokes and
 * a browser's singleton socket drives a signed-in browser. These are hidden from the sandbox instead:
 * every socket found under the places sockets live, the directory of each per-program socket in /tmp,
 * and the runtime directories as a whole. Abstract sockets need nothing: the sandbox has its own
 * network namespace, so it cannot reach this machine's.
 */
export function socketsToHide(uid = process.getuid?.() ?? 0, find: (root: string, depth: number) => string[] = findSockets): string[] {
  const hidden = new Set<string>([
    `/run/user/${uid}`, "/run/dbus", "/var/run/dbus", "/run/docker.sock", "/var/run/docker.sock", "/run/containerd",
    "/run/podman", "/run/snapd.socket", "/tmp/.X11-unix", "/tmp/.ICE-unix",
  ]);
  for (const socket of [...find("/tmp", 3), ...find("/run", 4), ...find("/var/run", 4), ...find(homedir(), 4)]) {
    // /tmp/ssh-XXXX/agent.1: hide its directory, where the next one will appear too.
    const tmpDir = /^(\/tmp\/[^/]+)\//.exec(socket)?.[1];
    hidden.add(tmpDir ?? socket);
  }
  return [...hidden];
}

function findSockets(root: string, depth: number): string[] {
  const found: string[] = [];
  const visit = (path: string, left: number) => {
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      return;
    }
    if (stat.isSocket()) found.push(path);
    if (!stat.isDirectory() || left === 0) return;
    let names: string[] = [];
    try {
      names = readdirSync(path);
    } catch {
      return;
    }
    for (const name of names) if (name !== "node_modules" && name !== ".git") visit(join(path, name), left - 1);
  };
  visit(root, depth);
  return found;
}

/**
 * Hands devices to a Linux sandbox. sandbox-runtime gives it a minimal /dev of its own, without a
 * GPU, so ASR, TTS or a local model cannot run. Each device named here is bound in after it.
 */
export function passDevices(wrapped: string, devices: string[]): string {
  if (devices.length === 0) return wrapped;
  const anchor = " --dev /dev ";
  if (wrapped.split(anchor).length !== 2) throw new Error("this sandbox-runtime version has an unexpected command; openguardrails cannot pass devices to it");
  for (const device of devices) if (!/^\/dev\/[\w./-]+$/.test(device) || device.includes("..")) throw new Error(`${device} is not a device path`);
  return wrapped.replace(anchor, `${anchor}${devices.map((device) => `--dev-bind ${device} ${device}`).join(" ")} `);
}

function insertRelay(wrapped: string, relay: string, socket: string): string {
  const anchor = "_srt_socks=$!\n";
  if (wrapped.split(anchor).length !== 2 || /['"$\\\s]/.test(socket)) {
    throw new Error("this sandbox-runtime version has an unexpected script; openguardrails cannot bridge a port");
  }
  return wrapped.replace(anchor, `${anchor}{ ${relay}; } >/dev/null 2>&1 &\n`);
}

export function buildPolicy(options: PolicyOptions): SandboxRuntimeConfig {
  const home = homedir();
  const inHome = (path: string) => join(home, path);
  return {
    network: {
      // Empty on purpose: every other host reaches the ask callback, which is where a run in
      // observe mode lets it through and writes it down.
      allowedDomains: options.allowHosts,
      deniedDomains: options.denyHosts,
      ...(options.allowLocalBinding ? { allowLocalBinding: true } : {}),
    },
    filesystem: {
      denyRead: [
        ...CREDENTIAL_PATHS.map(inHome),
        join(options.cwd, "**/.env"),
        join(options.cwd, "**/.env.*"),
      ],
      allowRead: options.allowRead,
      allowWrite: [options.cwd, real(tmpdir()), real("/tmp"), ...AGENT_STATE_PATHS.map(inHome), ...options.allowWrite],
      denyWrite: [],
    },
  };
}
