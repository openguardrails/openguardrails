/**
 * Configuration for the OpenGuardrails opencode integration (v0.8).
 *
 * v0.8 retired the SDK and with it this plugin's LOCAL policy engine — the
 * bundled regex rules, the bring-your-own-model judge, the policy file at
 * `.opencode/guardrails.json`. Every decision now comes from the runtime's
 * `/v1/evaluate`; what a deployment configures here is the CONNECTION, the
 * identity claims, the degraded-mode posture, and auto mode. Resolution per
 * field: plugin options → environment → default.
 */

/** Where an unset runtime URL points: the OpenGuardrails cloud. */
export const DEFAULT_RUNTIME_URL = "https://openguardrails.com"

/** Evaluate budget per call; strictly inside the host's patience. */
export const DEFAULT_TIMEOUT_MS = 5000

/** Heartbeat cadence — also reported to the runtime as `interval_s`. */
export const HEARTBEAT_INTERVAL_S = 60

/** `agent_type` claim when the deployment asserts nothing: the harness name. */
export const DEFAULT_AGENT_TYPE = "opencode"

/**
 * What the plugin does when it CANNOT KNOW — the runtime unreachable, an
 * evaluate timeout or 429, or a verdict whose `unjudged` names the very
 * content being enforced (specification/degraded-mode.md):
 *
 * - `open` (default) — proceed, loudly. The harness keeps working through an
 *   outage; the heartbeat's `evaluate_errors` counter shows the gap.
 * - `closed` — treat "could not look" as block. The stance for deployments
 *   where an unjudged action is worse than a stopped agent.
 */
export type FailMode = "open" | "closed"

/**
 * What auto mode does with a permission ask no verdict resolves — an ask
 * with nothing to judge, or (under fail-open) an evaluate that failed:
 *
 * - `human` (default) — leave the ask untouched, so opencode's own prompt
 *   still reaches the user.
 * - `reject` — deny it. The strict stance for headless runs where no human
 *   will ever answer.
 */
export type AutoUnresolved = "human" | "reject"

/**
 * Auto mode: answer opencode's permission prompts (`permission.ask`) with the
 * runtime's verdict instead of a human. On by default — it is the point of
 * this package; the prompts it answers are the ones YOUR opencode
 * `permission` config raises.
 */
export interface AutoModeConfig {
  /** Answer permission asks at all (default true). */
  enabled?: boolean
  /** Disposal of an ask nothing resolves (default `"human"`). */
  unresolved?: AutoUnresolved
}

/**
 * The runtime connection plus the identity claims every event carries.
 * Every claim is a four-tuple field on the wire; unset resolves to the
 * environment (`OGR_RUNTIME_URL`, `OGR_API_KEY`, `OGR_AGENT_ID`,
 * `OGR_AGENT_WORKSPACE`, `OGR_AGENT_USER`) and then to
 * `""` — the explicit "no assertion", which the runtime resolves from the
 * API key (the identity floor). Only the API key has no default — get one
 * at https://openguardrails.com.
 */
export interface RuntimeOptions {
  /** Runtime base URL (default {@link DEFAULT_RUNTIME_URL}). A mounted prefix belongs in it. */
  url?: string
  /** API key; unset disables the runtime connection (and with it every guard). */
  apiKey?: string
  /** `agent_id` claim — WHICH agent, unique in the organization. Empty = derived from the key. */
  agentId?: string
  /** `agent_type` claim — what KIND of agent (default {@link DEFAULT_AGENT_TYPE}). */
  agentType?: string
  /** `agent_workspace` claim — the platform policy group, NOT a directory. Empty = the key's workspace. */
  workspace?: string
  /** `agent_user` claim — who is using the agent. Empty = every session is one user. */
  user?: string
}

export interface GuardrailsOptions {
  /** The OpenGuardrails runtime connection and identity claims. */
  runtime?: RuntimeOptions
  /** Degraded-mode posture (default `"open"`). */
  failMode?: FailMode
  /** Per-call evaluate budget in milliseconds (default {@link DEFAULT_TIMEOUT_MS}). */
  timeoutMs?: number
  /** Auto mode: answer permission prompts with the verdict. */
  auto?: AutoModeConfig
}

/** The five identity claims exactly as every event carries them. */
export interface FiveTuple {
  agent_id: string
  agent_type: string
  agent_workspace: string
  agent_user: string
}

export interface ResolvedConfig {
  url: string
  apiKey: string
  identity: FiveTuple
  failMode: FailMode
  timeoutMs: number
  auto: Required<AutoModeConfig>
}

/** Options → environment → default, per field. */
export function resolveConfig(options?: GuardrailsOptions): ResolvedConfig {
  const r = options?.runtime
  return {
    url: r?.url || process.env["OGR_RUNTIME_URL"] || DEFAULT_RUNTIME_URL,
    apiKey: r?.apiKey || process.env["OGR_API_KEY"] || "",
    identity: {
      agent_id: r?.agentId || process.env["OGR_AGENT_ID"] || "",
      agent_type: r?.agentType || DEFAULT_AGENT_TYPE,
      agent_workspace: r?.workspace || process.env["OGR_AGENT_WORKSPACE"] || "",
      agent_user: r?.user || process.env["OGR_AGENT_USER"] || "",
    },
    failMode: options?.failMode ?? "open",
    timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    auto: {
      enabled: options?.auto?.enabled ?? true,
      unresolved: options?.auto?.unresolved ?? "human",
    },
  }
}
