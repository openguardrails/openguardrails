/**
 * The local layer: one tool call in, one of three answers out, no network and no model.
 *
 *   allow  It runs. The action is read-only or stays inside the workspace.
 *   deny   It does not run, and no model or agent can change that.
 *   judge  The model decides, because a rule cannot.
 */
import { resolve, sep } from "node:path";
import { gateCommand, HARD_CREDENTIAL, SENSITIVE_PATH, type GateDecision } from "./gate/gate.js";
import { pathOf, shellLine, toolKind } from "./tools.js";

export interface DecideOptions {
  /** Absolute directories the agent works in. Relative paths are taken as inside. */
  workspaces?: readonly string[];
}

export interface ToolCallInput {
  name: string;
  args: Record<string, unknown>;
}

/**
 * Inside a workspace, but what is written here runs later or changes the rules: hooks, CI, build
 * scripts, agent configuration and shell startup files. So "inside the workspace" is not enough.
 */
const PROTECTED_WRITE =
  /(^|\/)(\.git|\.husky|\.github\/workflows|\.gitlab-ci\.yml|\.claude|\.codex|\.hermes|\.openclaw|\.dsh|\.openguardrails|\.vscode|\.idea|\.mcp\.json|\.envrc|\.npmrc|\.bashrc|\.zshrc|\.zshenv|\.zprofile|\.profile|\.bash_profile|package\.json|Makefile|makefile|justfile|Dockerfile|setup\.py|pyproject\.toml|conftest\.py|CLAUDE\.md|AGENTS\.md|SOUL\.md)(\/|$)/;

function inWorkspace(path: string, workspaces: readonly string[]): boolean {
  if (path.startsWith("~")) return false;
  if (!path.startsWith("/")) return !path.split("/").includes("..");
  const target = resolve(path);
  return workspaces.some((root) => target === resolve(root) || target.startsWith(resolve(root) + sep));
}

export function decideTool(call: ToolCallInput, options: DecideOptions = {}): GateDecision {
  const workspaces = options.workspaces ?? [];
  const kind = toolKind(call.name);
  if (kind === "internal") return { verdict: "allow", reason: "the agent's own bookkeeping" };

  if (kind === "shell") {
    const line = shellLine(call.args);
    if (!line) return { verdict: "judge", reason: "a shell tool with no readable command" };
    return gateCommand(line, { workspaces });
  }

  if (kind === "read" || kind === "search" || kind === "write") {
    const path = pathOf(call.args) ?? (kind === "search" ? "." : null);
    if (!path) return { verdict: "judge", reason: `${call.name} names no path` };
    if (/\.openguardrails(\/|$)/.test(path)) {
      return kind === "write" ? { verdict: "deny", reason: "changing OpenGuardrails' own configuration" } : { verdict: "judge", reason: "reading OpenGuardrails' own configuration" };
    }
    if (kind !== "search" && HARD_CREDENTIAL.test(path)) return { verdict: "deny", reason: "reading or changing a private key or cloud credential" };
    if (SENSITIVE_PATH.test(path)) return { verdict: "judge", reason: "a path where secrets live" };
    if (!inWorkspace(path, workspaces)) return { verdict: "judge", reason: "a path outside the workspace" };
    if (kind === "write" && PROTECTED_WRITE.test(path)) return { verdict: "judge", reason: "a file that runs later or changes the rules" };
    return { verdict: "allow", reason: kind === "write" ? "a change inside the workspace" : "a read inside the workspace" };
  }

  return { verdict: "judge", reason: `${call.name} is not a tool the rules understand` };
}
