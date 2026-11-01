/**
 * The deterministic gate: every shell command is judged locally first. `allow` means fully
 * understood, read-only and inside the workspace. `deny` means obviously fatal. `judge` is
 * everything else and goes to the model. It costs no model call and always fails toward `judge`.
 *
 * `judge` names who decides next, which is the model. It never means asking a person: a person
 * is asked only for a decision that is theirs to make, never to rule on whether something is safe.
 */
import { analyzeCommand, type SimpleCommand } from "./parser.js";

export type GateVerdict = "allow" | "deny" | "judge";

export interface GateDecision {
  verdict: GateVerdict;
  reason: string;
}

/**
 * Pure reads of local state. Not here on purpose: `env` and `printenv`, because keys live in the
 * environment and whatever a command prints goes to the model provider.
 */
const READONLY = new Set([
  "ls", "pwd", "whoami", "id", "date", "uname", "hostname", "df", "du", "free",
  "ps", "cat", "head", "tail", "wc", "file", "stat", "which", "type",
  "basename", "dirname", "realpath", "readlink", "md5sum",
  "sha1sum", "sha256sum", "sort", "uniq", "cut", "tr", "column", "diff",
  "grep", "rg", "ag", "fgrep", "egrep", "echo", "printf", "true", "false",
  "nproc", "arch", "uptime", "jq", "yq",
]);

/**
 * Arguments that turn a listed command into a write or into running another program. An allowlist
 * of names is not enough: `rg --pre ./x` and `sort --compress-program=./x` execute, `sort -o`
 * and `yq -i` write, `ps e` prints every process's environment.
 */
const UNSAFE_ARGS: Record<string, RegExp> = {
  rg: /^--(pre|hostname-bin|search-zip)|^-z/,
  sort: /^(-o|--output|--compress-program|-T|--temporary-directory)/,
  yq: /^(-i|--inplace)/,
  date: /^(-s|--set)/,
  ps: /^(e|[a-zA-Z]*e[a-zA-Z]*$|-[a-zA-Z]*E)/,
  printf: /^-v$/,
  tail: /^(-f|-F|--follow)/,
};

/** Commands where a positional argument can be an output file or a new value. */
const POSITIONAL_WRITES: Record<string, number> = { uniq: 1, hostname: 0, date: Infinity };

/** git subcommands that only read this machine. `ls-remote` and `remote show` reach the network. */
const GIT_READONLY = new Set([
  "status", "diff", "log", "show", "branch", "tag", "remote", "rev-parse",
  "describe", "blame", "shortlog", "ls-files", "config", "cherry", "reflog", "stash",
]);
const GIT_WRITE_ARGS: Record<string, RegExp> = {
  branch: /^(-d|-D|-m|-M|-c|-C|-u|--delete|--move|--copy|--force|--set-upstream|--unset-upstream|--edit-description)/,
  tag: /^(-d|--delete|-f|--force|-a|-s|-u|-m|-F)/,
  remote: /^(add|remove|rm|rename|set-url|set-head|set-branches|prune|show|update)$/,
  reflog: /^(expire|delete)$/,
};
/** On any git read: these write a file or start a program. */
const GIT_UNSAFE_ARGS = /^(--output|--ext-diff|--textconv|--open-files-in-pager|--paginate|-O)/;

const FIND_WRITE_ARGS = /^(-delete|-exec|-execdir|-ok|-okdir|-fprint|-fprintf|-fls)/;

/** Where a word is a command rather than an argument. */
const CMD_POS = String.raw`(?:^|[;&|(\n{'"]\s*|\b(?:sudo|doas|exec|nohup|then|do|else|time)\s+(?:-\S+\s+)*)`;

/** Obviously fatal, no ambiguity, no model consulted. Anything debatable is `judge`. */
const DENY_RAW: [RegExp, string][] = [
  [/\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*[rR][a-zA-Z]*)\s+\/(\s|$)/, "recursive force-delete of the filesystem root"],
  [/\brm\b[^|;&]*--no-preserve-root/, "rm --no-preserve-root"],
  [new RegExp(CMD_POS + String.raw`mkfs(\.[a-z0-9]+)?\b`), "formatting a filesystem"],
  [/\bdd\b[^|;&]*\bof=\/dev\/(sd|nvme|vd|hd|mmcblk)/, "raw write to a block device"],
  [/:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/, "fork bomb"],
  [new RegExp(CMD_POS + String.raw`(shutdown|poweroff|reboot|halt)\b`), "changing the host's power state"],
  [/\bsystemctl\s+(?:-\S+\s+)*(reboot|poweroff|halt|kexec)\b/, "changing the host's power state"],
  [/>\s*\/dev\/(sd|nvme|vd|hd|mmcblk)/, "redirect onto a block device"],
  [/\b169\.254\.169\.254\b|\bmetadata\.google\.internal\b|\b100\.100\.100\.200\b/, "reaching a cloud metadata endpoint"],
];

/** The quote after these runs rather than being carried: `sh -c '…'`, `eval "…"`, `ssh host '…'`. */
const EXECUTES_NEXT_QUOTE =
  /(?:\b(?:ba|z|da|k)?sh\s+(?:-\S+\s+)*-c|\bsu\s+(?:-\S+\s+)*-c|\beval|\bssh\b[^'"]*\s)\s*$/;
const HEREDOC = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n([\s\S]*?)\n\s*\2(?=\s*$|\s*\n)/gm;
const SEPARATORS = ";&|\n";

/**
 * The command line with its inert text removed: heredocs fed to non-shells, quoted strings and
 * comments. Matching the deny floor on the raw string refused `echo "kafka-4 reboot window"`. Text
 * that runs stays, recursively. Whatever the floor skips still goes to the model, never to `allow`.
 */
export function commandSkeleton(raw: string, depth = 0): string {
  const s = raw.replace(HEREDOC, (m, _q, _tag, body: string, off: number) => {
    const head = raw.slice(raw.lastIndexOf("\n", off) + 1, off);
    return /\b(?:ba|z|da|k)?sh\b|\bssh\b/.test(head) ? m : m.replace(body, "");
  });
  let out = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== ch) j += ch === '"' && s[j] === "\\" ? 2 : 1;
      if (j >= s.length) {
        out += s.slice(i); // Unbalanced: keep the rest, failing toward a match.
        break;
      }
      const seg = out.slice(Math.max(...[...SEPARATORS].map((c) => out.lastIndexOf(c))) + 1);
      const runs = depth < 3 && EXECUTES_NEXT_QUOTE.test(seg);
      out += ch + (runs ? commandSkeleton(s.slice(i + 1, j), depth + 1) : "") + ch;
      i = j + 1;
      continue;
    }
    if (ch === "#" && (i === 0 || /[\s;&|]/.test(s[i - 1] ?? ""))) {
      const nl = s.indexOf("\n", i);
      i = nl === -1 ? s.length : nl;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Launchers whose presence means the real command is somewhere else. */
const OPAQUE_LAUNCHERS = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "fish", "eval", "exec", "source", ".",
  "xargs", "env", "nohup", "setsid", "timeout", "watch", "sudo", "doas", "su",
  "nice", "ionice", "stdbuf", "script", "time", "command",
]);

const base = (name: string) => name.slice(name.lastIndexOf("/") + 1);

function commandReadOnly(c: SimpleCommand): boolean {
  const name = base(c.name);
  // `base` would let ./cat or /tmp/x/cat through as the real cat.
  if (name !== c.name) return false;
  if (name === "git") {
    // The subcommand must come first: `git --config-env=…`, `-c` and `-C` all change what runs.
    const sub = c.args[0];
    if (!sub || !GIT_READONLY.has(sub)) return false;
    const rest = c.args.slice(1);
    if (rest.some((a) => GIT_UNSAFE_ARGS.test(a))) return false;
    if (sub === "stash") return rest[0] === "list" || rest[0] === "show";
    if (sub === "config") return rest.some((a) => /^(--get(-all|-regexp)?|--list|-l|--show-origin)$/.test(a));
    const write = GIT_WRITE_ARGS[sub];
    return !(write && rest.some((a) => write.test(a)));
  }
  if (name === "find") return !c.args.some((a) => FIND_WRITE_ARGS.test(a));
  if (!READONLY.has(name)) return false;
  const unsafe = UNSAFE_ARGS[name];
  if (unsafe && c.args.some((a) => unsafe.test(a))) return false;
  const limit = POSITIONAL_WRITES[name];
  if (limit !== undefined && limit !== Infinity && c.args.filter((a) => !a.startsWith("-")).length > limit) return false;
  if (name === "date" && c.args.some((a) => !a.startsWith("+") && !a.startsWith("-"))) return false;
  return true;
}

/** Private keys and cloud credentials: no ordinary task reads these into a model's context. */
export const HARD_CREDENTIAL =
  /(^|[\s/'"=])\.ssh\/id_[a-z0-9]+(?![\w.]*\.pub)\b|\bid_(rsa|dsa|ecdsa|ed25519)(?![\w.]*\.pub)\b|\.aws\/credentials\b|\.config\/gcloud\/(application_default_credentials|credentials|legacy_credentials)|\.gnupg\/private-keys|\/etc\/shadow\b/;

/** Places secrets often live. Reading one may be fine, and the model decides. */
export const SENSITIVE_PATH =
  /\.(ssh|aws|gnupg|kube|azure|oci|docker\/config\.json|netrc|npmrc|pypirc|pgpass|git-credentials|boto|my\.cnf|vault-token|openguardrails)\b|\bconfig\/gcloud\b|\.(pem|key|p12|pfx|jks|keystore)(?=$|[\s"'])|\/etc\/(shadow|sudoers)|(^|[\s/"'])\.env(\.[\w.-]*)?(?=$|[\s"'/])|\b(secrets?|credentials?)\.(json|xml|ya?ml|toml|ini|env)\b|\bterraform\.tfstate\b|\bcookies(\.sqlite)?\b|Keychains\/|\.keychain/;

const READERS = new Set(["cat", "head", "tail", "less", "more", "strings", "xxd", "od", "base64", "cp", "mv", "scp", "rsync", "tar", "zip", "nl", "tac", "awk", "sed", "grep"]);

/** True when a word might name something outside the workspace. */
function leavesWorkspace(word: string, workspaces: readonly string[]): boolean {
  if (word.startsWith("-")) {
    const eq = word.indexOf("=");
    return eq !== -1 && leavesWorkspace(word.slice(eq + 1), workspaces);
  }
  if (word.startsWith("~")) return true;
  if (word.split("/").includes("..")) return true;
  if (!word.startsWith("/")) return false;
  if (word === "/dev/null") return false;
  return !workspaces.some((root) => word === root || word.startsWith(`${root.replace(/\/$/, "")}/`));
}

export interface GateOptions {
  /** Absolute paths a read-only command may name. Relative paths are taken as inside the workspace. */
  workspaces?: readonly string[];
}

export function gateCommand(raw: string, options: GateOptions = {}): GateDecision {
  const workspaces = options.workspaces ?? [];
  const skeleton = commandSkeleton(raw);
  for (const [re, why] of DENY_RAW) {
    if (re.test(skeleton)) return { verdict: "deny", reason: why };
  }
  const parsed = analyzeCommand(raw);
  if (parsed && HARD_CREDENTIAL.test(raw) && parsed.commands.some((c) => READERS.has(base(c.name)))) {
    return { verdict: "deny", reason: "reading a private key or cloud credential into the model's context" };
  }
  if (SENSITIVE_PATH.test(raw)) return { verdict: "judge", reason: "touches a path where secrets live" };
  if (!parsed) return { verdict: "judge", reason: "outside the confidently parsed subset of shell" };
  if (parsed.writesFile) return { verdict: "judge", reason: "redirects output into a file" };
  if (parsed.readsFile) return { verdict: "judge", reason: "reads a file through a redirect" };
  if (parsed.hasExpansion) return { verdict: "judge", reason: "an argument holds an expansion whose value is unknown" };
  for (const c of parsed.commands) {
    const name = base(c.name);
    if (OPAQUE_LAUNCHERS.has(name)) return { verdict: "judge", reason: `opaque launcher: ${name}` };
    if (!commandReadOnly(c)) return { verdict: "judge", reason: `not known to be read-only: ${c.name}` };
    if (c.args.some((a) => leavesWorkspace(a, workspaces))) return { verdict: "judge", reason: `${name} names a path outside the workspace` };
  }
  return { verdict: "allow", reason: "every command is read-only and stays in the workspace" };
}
