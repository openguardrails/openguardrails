/** What a run may touch, as sandbox-runtime configuration. */
import { realpathSync } from "node:fs";
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
