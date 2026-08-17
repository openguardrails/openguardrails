/**
 * @openguardrails/opencode-auto-mode — OGR v0.8 for opencode.
 *
 * Auto mode for opencode: permission prompts answered by an OpenGuardrails
 * RUNTIME verdict instead of a human. v0.8 retired the SDK — and with it
 * this plugin's local policy engine (regex rules, bring-your-own-model
 * judge, taint) — so every decision now comes from `/v1/evaluate`, spoken
 * directly: one hand-rolled POST per held action, `Bearer` key, nine fields.
 *
 * THE VANTAGE, honestly: opencode's plugin surface exposes TOOL-CALL hooks,
 * not the model byte path — this plugin never holds a provider request or
 * response body, so the recipe's paired step/request + step/response per
 * model call cannot be implemented here (the README states the limitation).
 * What the plugin DOES hold, at the two refusable moments the host offers,
 * is a model-produced tool call the host is about to act on. Each becomes
 * ONE canonical `step/response` carrying exactly the `tool_calls` in hand —
 * nothing decomposed, nothing fabricated (no timing: this vantage observes
 * no byte path). A fresh `step_id` is minted per event; there is no request
 * half to pair it with, and the runtime derives session/turn/step itself.
 *
 *   tool.execute.before   the call, judged BEFORE it runs:
 *                         block → throw (deny-and-continue — the agent sees
 *                         a tool error and must find a safer path); the
 *                         verdict is recorded under the `callID`.
 *
 *   permission.ask        opencode's own permission prompt. Answered from
 *                         the recorded call's verdict when the ask carries a
 *                         known `callID`, else evaluated from the ask's own
 *                         metadata (opencode's bash asks put the command
 *                         there): allow → "allow", block → "deny",
 *                         nothing to judge → the human (default) or "deny"
 *                         under `auto.unresolved: "reject"`.
 *
 * An unanswered evaluate follows `failMode` (specification/degraded-mode.md):
 * open (default) proceeds loudly, closed refuses the call. Auto mode stays
 * restrict-only toward the agent — it automates the HUMAN's seat, never
 * overrides a verdict, and a block stays blocked everywhere.
 *
 * No opencode core changes required.
 */
import {
  resolveConfig,
  HEARTBEAT_INTERVAL_S,
  type GuardrailsOptions,
} from "./config.js"
import { INTEGRATION, mintStepId, OgrClient, type WireEvent, type WireVerdict } from "./wire.js"


// ---- the slice of opencode's plugin surface this integration touches -------
//
// Declared STRUCTURALLY (mirroring `@opencode-ai/plugin`) so the package
// builds and tests standalone, with no host SDK installed. opencode
// duck-types plugins — these shapes, not a nominal import, are the contract.

export interface ToolExecuteBeforeInput {
  tool: string
  sessionID: string
  callID: string
}
export interface ToolExecuteBeforeOutput {
  args: Record<string, unknown>
}
export interface PermissionAskInput {
  id?: string
  type: string
  pattern?: string
  sessionID?: string
  title?: string
  callID?: string
  metadata?: Record<string, unknown>
}
export interface PermissionAskOutput {
  status: "ask" | "deny" | "allow"
}
export interface Hooks {
  "tool.execute.before"?: (input: ToolExecuteBeforeInput, output: ToolExecuteBeforeOutput) => Promise<void>
  "tool.execute.after"?: (input: { tool: string; sessionID: string; callID: string }, output: unknown) => Promise<void>
  "permission.ask"?: (input: PermissionAskInput, output: PermissionAskOutput) => Promise<void>
}
export type Plugin = (input: { directory?: string }, options?: unknown) => Promise<Hooks>

/**
 * Bound on the per-call verdict table. Entries are removed on
 * `tool.execute.after`, which fires for every executed call; the cap is a
 * backstop against calls that never reach it (thrown denials included).
 */
const RECORDS_MAX = 4096

/** What the verdict said about one held call — the ask answers from this. */
type CallVerdict = { allow: true } | { allow: false; reason: string }

/** One-line human summary of a verdict for a denial reason. */
function brief(v: WireVerdict): string {
  const f = (v.findings ?? [])
    .map((x) => `${x.category}${x.severity ? `(${x.severity})` : ""}`)
    .join(", ")
  return f || v.decision
}

export const OpenGuardrailsPlugin: Plugin = async (_input, options) => {
  const cfg = resolveConfig(options as GuardrailsOptions | undefined)
  const warn = (message: string): void => console.warn(`[openguardrails] ${message}`)
  const client = new OgrClient(
    { info: () => {}, warn: (m) => console.warn(m) },
    () => (cfg.apiKey ? { url: cfg.url, apiKey: cfg.apiKey } : null),
    () => cfg.timeoutMs,
  )

  // Liveness from boot: the runtime must be able to tell "agent idle" from
  // "integration never came up", so the first beat goes out immediately and
  // the interval timer never holds the process open.
  if (client.enabled) {
    void client.heartbeat(INTEGRATION, cfg.identity.agent_id, HEARTBEAT_INTERVAL_S)
    const timer = setInterval(
      () => void client.heartbeat(INTEGRATION, cfg.identity.agent_id, HEARTBEAT_INTERVAL_S),
      HEARTBEAT_INTERVAL_S * 1000,
    )
    timer.unref?.()
  }

  /** The one held action → one canonical step/response, nine fields exactly. */
  const heldCallEvent = (callId: string, name: string, args: unknown): WireEvent => ({
    kind: "step/response",
    step_id: mintStepId(),
    ...cfg.identity,
    llm_protocol: "canonical",
    payload: { tool_calls: [{ id: callId, name, arguments: args }] },
  })

  const callVerdicts = new Map<string, CallVerdict>()
  function rememberCall(callId: string, verdict: CallVerdict): void {
    if (callVerdicts.size >= RECORDS_MAX) {
      const oldest = callVerdicts.keys().next()
      if (!oldest.done) callVerdicts.delete(oldest.value)
    }
    callVerdicts.set(callId, verdict)
  }

  let warnedNoRuntime = false
  let warnedSpans = false

  /**
   * Shared judgement of one held call. Returns the CallVerdict to enforce,
   * or null when nothing answered and fail-open lets it through undecided.
   */
  async function judge(callId: string, name: string, args: unknown): Promise<CallVerdict | null> {
    const verdict = await client.evaluate(heldCallEvent(callId, name, args))
    if (!verdict) {
      if (cfg.failMode === "closed") {
        return { allow: false, reason: "this call could not be judged and the deployment is fail-closed" }
      }
      warn(`${name} call got no verdict — proceeding (fail-open)`)
      return null
    }
    if (verdict.decision === "block") {
      return { allow: false, reason: brief(verdict) }
    }
    if (cfg.failMode === "closed" && (verdict.unjudged?.length ?? 0) > 0) {
      return {
        allow: false,
        reason: `parts of this call went unjudged (${verdict.unjudged!.join(", ")}) and the deployment is fail-closed`,
      }
    }
    if ((verdict.modifications?.spans?.length ?? 0) > 0 && !warnedSpans) {
      // Applying spans would mean splicing the host's own argument objects
      // from wire paths — not implemented yet (same stance as the dsh
      // reference). Stated ONCE rather than silently; the runtime's copy is
      // masked either way.
      warnedSpans = true
      warn("the verdict carried redaction spans, which this integration cannot apply yet — content proceeds unredacted")
    }
    return { allow: true }
  }

  const hooks: Hooks = {
    "tool.execute.before": async (input, output) => {
      if (!client.enabled) {
        // No runtime configured = the integration is off, loudly, once. This
        // is a deployment choice, not degraded mode — failMode governs a
        // runtime that IS configured and cannot answer.
        if (!warnedNoRuntime) {
          warnedNoRuntime = true
          warn("no runtime configured — set OGR_API_KEY (or plugin options). Running unguarded until then.")
        }
        return
      }
      const verdict = await judge(input.callID, input.tool, output.args)
      if (!verdict) return // fail-open, undecided: no record for the ask either
      rememberCall(input.callID, verdict)
      if (!verdict.allow) {
        throw new Error(`[OpenGuardrails] blocked this ${input.tool} call: ${verdict.reason}`)
      }
    },

    "tool.execute.after": async (input) => {
      callVerdicts.delete(input.callID)
    },
  }

  if (cfg.auto.enabled) {
    hooks["permission.ask"] = async (input, output) => {
      // Answer from the already-judged call when the ask correlates to one —
      // the same action must not earn two different answers.
      const recorded = input.callID !== undefined ? callVerdicts.get(input.callID) : undefined
      if (recorded) {
        output.status = recorded.allow ? "allow" : "deny"
        return
      }

      // `human` leaves the ask exactly as opencode raised it; `reject`
      // refuses it — the headless stance. A guard does not grant what it
      // cannot see, so an unjudged ask is never answered "allow".
      const undecided = (): void => {
        if (cfg.auto.unresolved === "reject") output.status = "deny"
      }
      if (!client.enabled) return undecided()

      const metadata = input.metadata ?? {}
      if (Object.keys(metadata).length === 0) return undecided()

      // An uncorrelated ask still describes a held would-run action —
      // opencode's bash asks carry the command in `metadata` — so judge it
      // as the one tool call this plugin actually holds.
      const verdict = await judge(input.callID ?? input.id ?? mintStepId(), input.type, metadata)
      if (!verdict) return undecided() // fail-open: the human still decides
      output.status = verdict.allow ? "allow" : "deny"
    }
  }

  return hooks
}

export default OpenGuardrailsPlugin
export {
  DEFAULT_AGENT_TYPE,
  DEFAULT_RUNTIME_URL,
  DEFAULT_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_S,
  type AutoModeConfig,
  type AutoUnresolved,
  type FailMode,
  type FiveTuple,
  type GuardrailsOptions,
  type RuntimeOptions,
} from "./config.js"
export type { WireEvent, WireFinding, WireToolCall, WireVerdict } from "./wire.js"
