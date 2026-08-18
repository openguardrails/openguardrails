/**
 * Configuration for the OpenGuardrails dsh integration (v0.8, the minimum API).
 *
 * v0.7 retired the SDK and this plugin's LOCAL policy engine; v0.8 shrank the
 * wire itself — every decision comes from the runtime's `/v1/evaluate`, and
 * the only things a deployment configures here are the CONNECTION, the
 * identity claims, the degraded-mode posture, the streaming tail hold, the
 * heartbeat cadence, and auto mode.
 */

/** Where an unset runtime URL points: the OpenGuardrails cloud. */
export const DEFAULT_RUNTIME_URL = "https://openguardrails.com"

/** The permission-preset name auto mode answers for unless configured otherwise. */
export const DEFAULT_AUTO_PRESET = "auto-mode"

/** Evaluate budget per call; strictly inside a PEP's patience, see the spec's budget note. */
export const DEFAULT_TIMEOUT_MS = 5000

/**
 * How many trailing characters of a streamed answer are withheld until the
 * verdict — the spec's reference default. Streaming is judged EXACTLY ONCE,
 * whole, at stream end; enforcement comes from this held-back tail (`allow`
 * releases it, `block` cuts the stream). A deployment that cannot accept
 * content ahead of the tail being seen sets this huge, which degenerates to
 * buffering the whole answer.
 */
export const DEFAULT_STREAM_TAIL_CHARS = 200

/** Heartbeat cadence in seconds — how often the runtime hears "still alive". */
export const DEFAULT_HEARTBEAT_S = 60

/**
 * What the plugin does when it CANNOT KNOW — the runtime unreachable, an
 * evaluate timeout or 429, a verdict whose `unjudged` names the very content
 * being enforced, or a tool call that reached execution with no verdict
 * recorded at all (specification/degraded-mode.md):
 *
 * - `open` (the spec's default and this plugin's) — proceed, loudly. The
 *   harness keeps working through an outage; the heartbeat's
 *   `evaluate_errors` counter is what makes the gap visible to the runtime.
 * - `closed` — treat "could not look" as block. The stance for deployments
 *   where an unjudged action is worse than a stopped agent.
 */
export type FailMode = "open" | "closed"

/**
 * What the auto-mode answerer does with an approval ask it cannot resolve —
 * a call the step verdict never covered, or no runtime configured:
 *
 * - `human` (default) — delegate to the next answerer, the chat UI's human gate.
 * - `reject` — refuse it. The strict stance for headless deployments.
 */
export type AutoUnresolved = "human" | "reject"

/**
 * Auto mode: answer dsh approval asks with the step verdict instead of a
 * human, for sessions whose permission preset is {@link preset}. The preset
 * itself is deployment config on `@deepseek-ai/dsh-permission-presets`; this
 * block configures the ANSWERER that gives the preset its meaning.
 */
export interface AutoApprovalConfig {
  /** Register the answerer at all (default true — inert until a session selects the preset). */
  enabled?: boolean
  /** The permission-preset name whose sessions this plugin answers for (default `"auto-mode"`). */
  preset?: string
  /** Disposal of an ask the verdict cannot resolve (default `"human"`). */
  unresolved?: AutoUnresolved
}

/**
 * The OpenGuardrails runtime connection, plus the identity claims events
 * carry. Every field resolves Settings (the dsh web form) → this config →
 * environment (`OGR_RUNTIME_URL`, `OGR_API_KEY`, `OGR_AGENT_WORKSPACE`,
 * `OGR_AGENT_USER`) → default. Only the API key has no
 * default — get one at https://openguardrails.com.
 *
 * v0.8 makes the four-tuple REQUIRED on every event with `""` as the
 * explicit "no assertion": whatever stays unresolved here is sent as the
 * empty string, never omitted, and the runtime falls back to the API-key
 * identity floor.
 */
export interface RuntimeOptions {
  /** Runtime base URL (default {@link DEFAULT_RUNTIME_URL}). A mounted prefix belongs in it. */
  url?: string
  /** API key; unset disables the runtime connection (and with it every guard). */
  apiKey?: string
  /**
   * `agent_workspace` claim — the named policy/resource group this agent
   * belongs to on the platform, NOT a directory. Unset → sent as `""`
   * (the API key's workspace).
   */
  workspace?: string
  /** `agent_user` claim. Unset → the OS account the harness runs as, else `""`. */
  user?: string
}

export interface GuardrailsOptions {
  /** The OpenGuardrails runtime connection and identity claims. */
  runtime?: RuntimeOptions
  /** Degraded-mode posture (default `"open"`). */
  failMode?: FailMode
  /** Per-call evaluate budget in milliseconds (default {@link DEFAULT_TIMEOUT_MS}). */
  timeoutMs?: number
  /** Trailing characters of a streamed answer withheld until the verdict (default {@link DEFAULT_STREAM_TAIL_CHARS}). */
  streamTailChars?: number
  /** Heartbeat cadence in seconds (default {@link DEFAULT_HEARTBEAT_S}). */
  heartbeatS?: number
  /** Auto mode: answer approval asks with the step verdict for auto-preset sessions. */
  auto?: AutoApprovalConfig
}
