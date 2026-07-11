/**
 * Guardrails configuration for the OpenClaw integration.
 *
 * The assistant configures its OWN guardrails — text + regex rules (no model
 * needed), and optionally its own model as an LLM judge. Resolution order
 * (lowest → highest precedence):
 *
 *   1. a sensible default policy (below)
 *   2. `<workspace>/openguardrails.json` (agent-editable — this is how an
 *      assistant gives itself guardrails); path overridable via plugin config
 *      `policyPath` or the `OPENGUARDRAILS_POLICY` env var
 *   3. inline plugin config `policy` (set in OpenClaw config under
 *      `plugins.entries.openguardrails.config`)
 *
 * The policy IS an OGR policy.json (composition + config_rules), so the same
 * file format works across every OGR integration (opencode, hermes, python).
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
 * Channel-inbound tainting: once a session ingests untrusted content (an inbound
 * channel message, or a tool result from a web/fetch/search/browser/MCP tool),
 * subsequent tool calls in that session carry `untrusted` provenance so the OGR
 * judge can treat a privileged action as possible indirect prompt injection.
 */
export interface TaintConfig {
  /** Mark a session tainted when it receives an inbound channel message (default true). */
  inboundMessages?: boolean
  /** Mark a session tainted after an external-content tool result (default true). */
  toolResults?: boolean
  /** Regex (matched case-insensitively against the tool name) for external-content tools. */
  toolResultPattern?: string
}

/** Plugin config, delivered through OpenClaw `plugins.entries.openguardrails.config`. */
export interface GuardrailsOptions {
  /** Inline OGR policy (overrides the file + default). */
  policy?: Policy
  /** Path to a guardrails policy file (defaults to <workspace>/openguardrails.json). */
  policyPath?: string
  /** Enable the LLM-judge detector backed by your own model. */
  judge?: JudgeConfig
  /** Also evaluate inbound/outbound channel messages (default true). */
  guardMessages?: boolean
  /** Channel-inbound tainting controls (default: both on). */
  taint?: TaintConfig
}

/**
 * Default external-content tool matcher — tools whose results commonly carry
 * untrusted, possibly-injected content (web pages, search hits, MCP, email).
 */
export const DEFAULT_TAINT_TOOL_PATTERN =
  "(web|fetch|search|browse|browser|http|url|crawl|scrape|mcp|email|mail|gmail|document|extract|rss|feed)"

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
  guardMessages: boolean
  taint: Required<TaintConfig>
}

/**
 * Resolve the effective policy. `workspaceDir` is the OpenClaw workspace (known
 * at `gateway_start`); when absent we fall back to `process.cwd()` so the plugin
 * still resolves a file during early registration.
 */
export function loadGuardrailsConfig(workspaceDir: string | undefined, options?: GuardrailsOptions): ResolvedConfig {
  let policy: Policy = DEFAULT_POLICY

  const path =
    options?.policyPath ??
    process.env["OPENGUARDRAILS_POLICY"] ??
    join(workspaceDir ?? process.cwd(), "openguardrails.json")

  if (existsSync(path)) {
    try {
      policy = JSON.parse(readFileSync(path, "utf8")) as Policy
    } catch {
      // malformed file → keep the safe default rather than failing open silently
    }
  }
  if (options?.policy) policy = options.policy

  const judge = options?.judge ?? (policy["judge"] as JudgeConfig | undefined)
  const taintOpts = options?.taint ?? (policy["taint"] as TaintConfig | undefined) ?? {}
  const taint: Required<TaintConfig> = {
    inboundMessages: taintOpts.inboundMessages ?? true,
    toolResults: taintOpts.toolResults ?? true,
    toolResultPattern: taintOpts.toolResultPattern ?? DEFAULT_TAINT_TOOL_PATTERN,
  }
  return { policy, judge, guardMessages: options?.guardMessages ?? true, taint }
}
