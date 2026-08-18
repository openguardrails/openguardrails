/**
 * openguardrails-instrumentation-openclaw — OGR v0.8 for OpenClaw.
 *
 * An OpenClaw plugin that guards an assistant through the OpenGuardrails
 * Runtime API. v0.8 retired the SDK — and with it this plugin's local policy
 * engine (regex rules, bring-your-own-model judge, taint tracker) and the
 * enrolled-key reporter — so every decision now comes from `/v1/evaluate`,
 * spoken directly: one hand-rolled POST per held action, `Bearer` key, ten
 * fields.
 *
 * THE VANTAGE, honestly: OpenClaw's plugin hooks expose TOOL CALLS and
 * CHANNEL MESSAGES, not the model byte path — this plugin never holds a
 * provider request or response body, so the recipe's paired step/request +
 * step/response per model call cannot be implemented here (the README
 * states the limitation). What the plugin DOES hold, at the host's two
 * refusable moments, is model-produced output the host is about to act on.
 * Each becomes ONE canonical `step/response` carrying exactly what is in
 * hand — nothing decomposed, nothing fabricated (no timing: this vantage
 * observes no byte path). A fresh `step_id` is minted per event; there is
 * no request half to pair it with, and the runtime derives
 * session/turn/step itself.
 *
 *   before_tool_call   canonical step/response {tool_calls: [the call]},
 *                      judged BEFORE the tool runs: block → `{ block }`.
 *
 *   message_sending    canonical step/response {text}, judged BEFORE the
 *                      outbound channel message leaves: block → `{ cancel }`.
 *
 * An unanswered evaluate follows `failMode` (specification/degraded-mode.md):
 * open (default) proceeds loudly, closed refuses the action. This is a
 * restrict-only guard: it can stop a would-run tool call or a would-send
 * message, never loosen one. No OpenClaw core changes required.
 */
import {
  resolveConfig,
  HEARTBEAT_INTERVAL_S,
  type GuardrailsOptions,
  type ResolvedConfig,
} from "./config.js"
import { INTEGRATION, mintStepId, OgrClient, type WireEvent, type WireVerdict } from "./wire.js"


// ---- the slice of OpenClaw's plugin surface this integration touches -------
//
// Declared STRUCTURALLY (mirroring the openclaw plugin-sdk hook payloads)
// so the package builds and tests standalone, with no host SDK installed.
// OpenClaw duck-types the hook handlers — these shapes, not a nominal
// import, are the contract. The exported entry is the same plain
// {id, name, description, register} object `definePluginEntry` used to brand.

export interface BeforeToolCallEvent {
  toolName: string
  toolCallId?: string
  params?: Record<string, unknown>
}
export interface MessageSendingEvent {
  content?: string
}
export interface HookCtx {
  agentId?: string
  sessionKey?: string
  channelId?: string
  messageProvider?: string
  workspaceDir?: string
  config?: unknown
}
export type BeforeToolCallResult = { block: true; blockReason: string } | undefined
export type MessageSendingResult =
  | { cancel: true; cancelReason: string; metadata?: Record<string, unknown> }
  | undefined
export interface PluginApi {
  on(
    hook: "gateway_start",
    handler: (event: unknown, ctx: HookCtx) => void,
  ): void
  on(
    hook: "before_tool_call",
    handler: (event: BeforeToolCallEvent, ctx: HookCtx) => Promise<BeforeToolCallResult>,
    options?: { priority?: number },
  ): void
  on(
    hook: "message_sending",
    handler: (event: MessageSendingEvent, ctx: HookCtx) => Promise<MessageSendingResult>,
  ): void
}
export interface PluginEntry {
  id: string
  name: string
  description: string
  register(api: PluginApi): void
}

/** One-line human summary of a verdict for a denial reason. */
function brief(v: WireVerdict): string {
  const f = (v.findings ?? [])
    .map((x) => `${x.category}${x.severity ? `(${x.severity})` : ""}`)
    .join(", ")
  return f || v.decision
}

/** Best-effort read of this plugin's config out of the OpenClaw config tree. */
function readOptions(config: unknown): GuardrailsOptions | undefined {
  const entries = (config as { plugins?: { entries?: Record<string, { config?: unknown }> } })?.plugins?.entries
  return entries?.["openguardrails"]?.config as GuardrailsOptions | undefined
}

const plugin: PluginEntry = {
  id: "openguardrails",
  name: "OpenGuardrails",
  description:
    "Judge every tool call and outbound channel message through an OpenGuardrails runtime (OGR v0.8) — block enforced in place, fail-open by default.",
  register(api) {
    const warn = (message: string): void => console.warn(`[openguardrails] ${message}`)

    // The workspace config tree only arrives at `gateway_start`; until then
    // the environment alone decides. `cfg` is re-resolved there, and the
    // client reads it through thunks so the late config lands without any
    // re-registration.
    let cfg: ResolvedConfig = resolveConfig(undefined)
    const client = new OgrClient(
      { info: () => {}, warn: (m) => console.warn(m) },
      () => (cfg.apiKey ? { url: cfg.url, apiKey: cfg.apiKey } : null),
      () => cfg.timeoutMs,
    )

    // Liveness from the moment a runtime is configured: the first beat goes
    // out immediately (a live-but-idle assistant must register in fleet
    // coverage) and the interval timer never holds the process open.
    let heartbeatStarted = false
    const startHeartbeat = (): void => {
      if (heartbeatStarted || !client.enabled) return
      heartbeatStarted = true
      const beat = (): void => void client.heartbeat(INTEGRATION, cfg.identity.agent_id, HEARTBEAT_INTERVAL_S)
      beat()
      const timer = setInterval(beat, HEARTBEAT_INTERVAL_S * 1000)
      timer.unref?.()
    }

    api.on("gateway_start", (_event, ctx) => {
      cfg = resolveConfig(readOptions(ctx.config))
      startHeartbeat()
    })
    startHeartbeat() // env-only deployments never see a gateway_start config

    /**
     * The four-tuple for one event. Config wins; an unasserted `agent_id`
     * falls back to the host's own agent id for this hook — a fact the host
     * supplies, not one this plugin invents — and then to `""`, the explicit
     * no-assertion the runtime resolves from the API key.
     */
    const identity = (ctx: HookCtx): ResolvedConfig["identity"] => ({
      ...cfg.identity,
      agent_id: cfg.identity.agent_id || ctx.agentId || "",
    })

    let warnedNoRuntime = false
    let warnedSpans = false

    /** Whether an unguarded pass-through is a deployment choice (no key), said once. */
    const offline = (): boolean => {
      if (client.enabled) return false
      if (!warnedNoRuntime) {
        warnedNoRuntime = true
        warn("no runtime configured — set OGR_API_KEY (or plugins.entries.openguardrails.config). Running unguarded until then.")
      }
      return true
    }

    /**
     * Judge one held action. Returns a denial reason, or null to proceed —
     * folding in the degraded-mode posture: no verdict (or a verdict that
     * could not look at what is being enforced) denies only under
     * `failMode: "closed"`.
     */
    async function judge(event: WireEvent, what: string): Promise<string | null> {
      const verdict = await client.evaluate(event)
      if (!verdict) {
        if (cfg.failMode === "closed") {
          return `this ${what} could not be judged and the deployment is fail-closed`
        }
        warn(`${what} got no verdict — proceeding (fail-open)`)
        return null
      }
      if (verdict.decision === "block") return brief(verdict)
      if (cfg.failMode === "closed" && (verdict.unjudged?.length ?? 0) > 0) {
        return `parts of this ${what} went unjudged (${verdict.unjudged!.join(", ")}) and the deployment is fail-closed`
      }
      if ((verdict.modifications?.spans?.length ?? 0) > 0 && !warnedSpans) {
        // Applying spans would mean splicing the host's own params/content
        // from wire paths — not implemented yet (same stance as the dsh
        // reference). Stated ONCE rather than silently; the runtime's copy
        // is masked either way.
        warnedSpans = true
        warn("the verdict carried redaction spans, which this integration cannot apply yet — content proceeds unredacted")
      }
      return null
    }

    // Core enforcement: every tool call, held BEFORE it runs — the one copy
    // of the action anyone can still refuse.
    api.on(
      "before_tool_call",
      async (event, ctx) => {
        if (offline()) return undefined
        const denial = await judge({
          kind: "step/response",
          step_id: mintStepId(),
          ...identity(ctx),
          llm_protocol: "canonical",
          payload: {
            tool_calls: [{
              id: event.toolCallId ?? mintStepId(),
              name: event.toolName,
              arguments: event.params ?? {},
            }],
          },
        }, `${event.toolName} call`)
        return denial ? { block: true, blockReason: `[OpenGuardrails] ${denial}` } : undefined
      },
      { priority: 50 },
    )

    // Outbound guard: the assistant's reply, held BEFORE the channel sends it.
    api.on("message_sending", async (event, ctx) => {
      if (!cfg.guardMessages || offline()) return undefined
      const text = event.content ?? ""
      if (text === "") return undefined // nothing held, nothing to judge
      const denial = await judge({
        kind: "step/response",
        step_id: mintStepId(),
        ...identity(ctx),
        llm_protocol: "canonical",
        payload: { text },
      }, "outbound message")
      return denial
        ? { cancel: true, cancelReason: "openguardrails:block", metadata: { reason: denial } }
        : undefined
    })
  },
}

export default plugin

export {
  DEFAULT_AGENT_TYPE,
  DEFAULT_RUNTIME_URL,
  DEFAULT_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_S,
  resolveConfig,
  type FailMode,
  type FiveTuple,
  type GuardrailsOptions,
  type ResolvedConfig,
  type RuntimeOptions,
} from "./config.js"
export type { WireEvent, WireFinding, WireToolCall, WireVerdict } from "./wire.js"
