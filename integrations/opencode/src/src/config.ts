/**
 * Guardrails configuration for the opencode integration.
 *
 * The agent configures its OWN guardrails — text + regex rules (no model
 * needed), and optionally its own model as an LLM judge. Config resolution:
 *
 *   1. a sensible default policy (below)
 *   2. `.opencode/guardrails.json` in the project (agent-editable — this is how
 *      an agent gives itself guardrails)
 *   3. plugin `options` passed in opencode config (highest precedence)
 *
 * The policy IS an OGR policy.json (composition + config_rules), so the same
 * file format works across every OGR integration.
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

export interface GuardrailsOptions {
  /** Inline OGR policy (overrides the file + default). */
  policy?: Policy
  /** Path to a guardrails policy file (defaults to .opencode/guardrails.json). */
  policyPath?: string
  /** Enable the LLM-judge detector backed by your own model. */
  judge?: JudgeConfig
}

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
}

export function loadGuardrailsConfig(directory: string, options?: GuardrailsOptions): ResolvedConfig {
  let policy: Policy = DEFAULT_POLICY

  const path = options?.policyPath ?? join(directory, ".opencode", "guardrails.json")
  if (existsSync(path)) {
    try {
      policy = JSON.parse(readFileSync(path, "utf8")) as Policy
    } catch {
      // malformed file → keep the safe default rather than failing open silently
    }
  }
  if (options?.policy) policy = options.policy

  const judge = options?.judge ?? (policy["judge"] as JudgeConfig | undefined)
  return { policy, judge }
}
