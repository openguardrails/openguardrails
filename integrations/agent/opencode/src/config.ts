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

/**
 * Local secrets redaction (OGR 1.4, specification/local-redaction.md): mask
 * every credential in the messages sent to the model with `${OGR_SECRET_n}`,
 * judge the tool call on the placeholder, restore the value into the tool's
 * arguments on this host after judgement. ON by default — it is what makes
 * "secrets never leave the host" true on the agent path. The ruleset is the
 * org's, fetched from the runtime with the API key; the plugin ships none.
 */
export interface LocalRedactionConfig {
  /** Mask at all (default true; env `OGR_LOCAL_REDACTION=0|false|off` turns it off). */
  enabled?: boolean
  /** Where the fetched ruleset is cached (default `~/.openguardrails/rules-<hash>.json`; env `OGR_RULES_CACHE`). */
  cachePath?: string
  /** Which tiers to mask (default both; env `OGR_LOCAL_REDACTION_TIERS=strong,heuristic`). */
  tiers?: RedactionTier[]
  /**
   * Mask at the HTTP client — the in-process interceptor on `fetch` (and
   * undici's dispatcher where undici is resolvable), the primary path
   * (default true; env `OGR_LOCAL_REDACTION_HTTP=0|false|off` turns it off,
   * leaving the hook-based masking alone).
   */
  http?: boolean
}

export type RedactionTier = "strong" | "heuristic"

export interface GuardrailsOptions {
  /** The OpenGuardrails runtime connection and identity claims. */
  runtime?: RuntimeOptions
  /** Degraded-mode posture (default `"open"`). */
  failMode?: FailMode
  /** Per-call evaluate budget in milliseconds (default {@link DEFAULT_TIMEOUT_MS}). */
  timeoutMs?: number
  /** Auto mode: answer permission prompts with the verdict. */
  auto?: AutoModeConfig
  /** Local secrets redaction (default on). */
  localRedaction?: LocalRedactionConfig
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
  localRedaction: { enabled: boolean; cachePath: string | undefined; tiers: RedactionTier[]; http: boolean }
}

/** `OGR_LOCAL_REDACTION`: unset or anything but `0`/`false`/`off` means on. */
export function envFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback
  return !["0", "false", "off", "no"].includes(value.trim().toLowerCase())
}

/** `OGR_LOCAL_REDACTION_TIERS`: a comma list; unknown words are dropped, an empty result means both. */
export function envTiers(value: string | undefined): RedactionTier[] | undefined {
  if (value === undefined || value.trim() === "") return undefined
  const tiers = value
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t): t is RedactionTier => t === "strong" || t === "heuristic")
  return tiers.length > 0 ? tiers : undefined
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
    localRedaction: {
      enabled: options?.localRedaction?.enabled ?? envFlag(process.env["OGR_LOCAL_REDACTION"], true),
      cachePath: options?.localRedaction?.cachePath || process.env["OGR_RULES_CACHE"] || undefined,
      tiers: options?.localRedaction?.tiers ?? envTiers(process.env["OGR_LOCAL_REDACTION_TIERS"]) ?? ["strong", "heuristic"],
      http: options?.localRedaction?.http ?? envFlag(process.env["OGR_LOCAL_REDACTION_HTTP"], true),
    },
  }
}
