/**
 * Guardrails configuration for the DeepSeek Harness (dsh) integration.
 *
 * The agent configures its OWN guardrails — text + regex rules (no model
 * needed), and optionally its own model as an LLM judge. Resolution order,
 * lowest precedence first:
 *
 *   1. a sensible default policy (below)
 *   2. `.dsh/guardrails.json` in the agent's session workspace
 *      (agent-editable — this is how an agent gives itself guardrails)
 *   3. the plugin's `cordis.yml` config (highest precedence)
 *
 * The policy IS an OGR policy.json (composition + config_rules), so the same
 * file works unchanged across every OGR integration.
 *
 * Resolution is per-workspace, not per-process: dsh sessions each carry their
 * own `session.header.cwd`, and one dsh process serves many of them.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import type { Policy } from "@openguardrails/core"

/** "Use your own model as the guardrail" — any OpenAI-compatible chat endpoint. */
export interface JudgeConfig {
  baseURL: string
  model: string
  apiKey?: string
  headers?: Record<string, string>
}

/**
 * Which tool results carry untrusted external content, and whether the plugin
 * treats them as a taint source at all.
 */
export interface TaintConfig {
  /** Taint the calling agent from matching tool results (default true). */
  toolResults?: boolean
  /**
   * Case-insensitive regex over the tool NAME. A match means "this tool's
   * result is content someone else wrote" — the indirect prompt-injection
   * vector. Defaults to {@link DEFAULT_TAINT_TOOL_PATTERN}.
   */
  toolResultPattern?: string
}

export interface GuardrailsOptions {
  /** Inline OGR policy; overrides both the workspace file and the default. */
  policy?: Policy
  /** Path to a policy file. Relative paths resolve against the session workspace. */
  policyPath?: string
  /** Enable the LLM-judge detector backed by your own model. */
  judge?: JudgeConfig
  /** Also evaluate tool RESULTS, not just tool calls (default true). */
  guardToolResults?: boolean
  /** Per-agent taint propagation from untrusted tool results. */
  taint?: TaintConfig
  /**
   * Re-assert an OGR `block` as a monotonic tool-registry guard, and deny any
   * call that reached the guard without an OGR verdict (default false).
   *
   * `tools/pre-execute` is dsh's deliberately reorderable policy layer: a
   * listener ahead of this plugin that returns `allow` without delegating
   * short-circuits the waterfall, and OGR never sees the call. With
   * `failClosed`, the monotonic guard — which cannot be reordered away —
   * refuses the un-evaluated call instead of letting it dispatch.
   */
  failClosed?: boolean
}

/**
 * Tools whose results are content the agent did not author. Deliberately a
 * name pattern, not a hard-coded list: dsh names MCP tools after their server
 * and a deployment renames its own tools freely.
 */
export const DEFAULT_TAINT_TOOL_PATTERN = "web|fetch|search|browser|curl|http|^mcp_|_mcp_"

/** Default text/regex guardrails — deterministic, no model required. */
export const DEFAULT_POLICY: Policy = {
  composition: {
    "security.*": { strategy: "deny-wins", on_all_failed: "block" },
    default: { strategy: "deny-wins" },
  },
  config_rules: {
    secret_env_markers: ["SECRET", "TOKEN", "KEY", "PASSWORD", "AWS_", "PRIVATE", "CREDENTIAL"],
    command_rules: [
      {
        id: "pipe-to-shell",
        regex: "(curl|wget)\\b.*\\|\\s*(ba)?sh",
        category: "security.malicious_command",
        decision: "require_approval",
        score: 0.85,
        why: "remote script fetched and piped directly into a shell",
      },
      {
        id: "rm-rf-root",
        regex: "rm\\s+-rf\\s+/(\\s|$)",
        category: "security.malicious_command",
        decision: "block",
        score: 1.0,
        why: "destructive recursive delete of the filesystem root",
      },
      {
        id: "secret-file-access",
        regex: "(\\.env\\b|/\\.aws/credentials|/\\.ssh/id_|/\\.ssh/|auth\\.json|\\.netrc)",
        category: "security.secret_leak",
        decision: "block",
        score: 0.9,
        why: "command references a credential file — independent of the reader",
      },
      {
        id: "pipe-to-sudo",
        regex: "\\|\\s*sudo\\b",
        category: "security.privilege_escalation",
        decision: "require_approval",
        score: 0.7,
        why: "output piped into sudo",
      },
    ],
  },
}

export interface ResolvedConfig {
  policy: Policy
  judge?: JudgeConfig
  guardToolResults: boolean
  taint: Required<TaintConfig>
  failClosed: boolean
}

/** Where the workspace-local, agent-editable policy lives. */
export const WORKSPACE_POLICY_PATH = join(".dsh", "guardrails.json")

/**
 * Resolve the effective guardrails for one session workspace.
 *
 * @param workspaceDir - the agent's `session.header.cwd`, or undefined for a
 *   session created without one (then only inline config and an absolute
 *   `policyPath` can contribute a file).
 * @param options - the plugin's validated cordis config.
 * @param onWarn - reporter for a policy file that exists but does not parse;
 *   the safe default is kept rather than failing the call open.
 */
export function loadGuardrailsConfig(
  workspaceDir: string | undefined,
  options?: GuardrailsOptions,
  onWarn?: (message: string) => void,
): ResolvedConfig {
  let policy: Policy = DEFAULT_POLICY

  const configured = options?.policyPath
  // An explicit relative path resolves against the workspace, exactly like the
  // default location does; without a workspace only an absolute path resolves.
  const path = configured
    ? (workspaceDir ? join(workspaceDir, configured) : configured)
    : (workspaceDir ? join(workspaceDir, WORKSPACE_POLICY_PATH) : undefined)

  if (path && existsSync(path)) {
    try {
      policy = JSON.parse(readFileSync(path, "utf8")) as Policy
    } catch (error: unknown) {
      // Malformed file → keep the safe default rather than failing open silently.
      onWarn?.(`could not parse guardrails policy "${path}": ${String(error)} — using the default policy`)
    }
  }
  if (options?.policy) policy = options.policy

  // A judge needs both an endpoint and a model. Config validation cannot
  // require them (an optional block whose fields are required can never be
  // omitted), and a policy file may carry a half-written one, so the pair is
  // checked here: anything short of both is "no judge configured", which
  // falls back to the deterministic HeuristicBackend rather than to a
  // guaranteed-failing fetch on every call.
  const candidate = options?.judge ?? (policy["judge"] as JudgeConfig | undefined)
  const judge = candidate?.baseURL && candidate.model ? candidate : undefined
  // Only a HALF-written judge is a misconfiguration. Config validation
  // materializes an empty `judge` block (its `headers` dict defaults to `{}`),
  // and that means "no judge", not a mistake worth a warning on every call.
  if (!judge && (candidate?.baseURL || candidate?.model)) {
    onWarn?.("`judge` needs both `baseURL` and `model` — ignoring it and judging with the built-in heuristic backend")
  }

  return {
    policy,
    ...judge ? { judge } : {},
    guardToolResults: options?.guardToolResults ?? true,
    taint: {
      toolResults: options?.taint?.toolResults ?? true,
      toolResultPattern: options?.taint?.toolResultPattern ?? DEFAULT_TAINT_TOOL_PATTERN,
    },
    failClosed: options?.failClosed ?? false,
  }
}
