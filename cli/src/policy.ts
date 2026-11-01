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
