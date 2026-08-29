/**
 * openguardrails-instrumentation-openclaw — OGR v1.0 (+1.4 local redaction) for OpenClaw.
 *
 * An OpenClaw plugin that guards an assistant through the OpenGuardrails
 * Runtime API. v0.8 retired the SDK — and with it this plugin's local policy
 * engine (regex rules, bring-your-own-model judge, taint tracker) and the
 * enrolled-key reporter — so every decision now comes from `/v1/evaluate`,
 * spoken directly: one hand-rolled POST per held action, `Bearer` key, ten
 * fields.
 *
 * THE VANTAGE, honestly: OpenClaw's plugin hooks expose TOOL CALLS and
 * CHANNEL MESSAGES, not the model byte path — this plugin's HOOKS never
 * hold a provider request or response body, so the recipe's paired
 * step/request + step/response per model call cannot be implemented from
 * them (the README states the limitation). What the hooks DO hold, at the
 * host's two refusable moments, is model-produced output the host is about
 * to act on. Each becomes ONE canonical `step/response` carrying exactly
 * what is in hand — nothing decomposed, nothing fabricated (no timing: this
 * vantage observes no byte path). A fresh `step_id` is minted per event;
 * there is no request half to pair it with, and the runtime derives
 * session/turn/step itself.
 *
 *   before_tool_call   canonical step/response {tool_calls: [the call]},
 *                      judged BEFORE the tool runs: block → `{ block }`.
 *                      A SECOND handler at a lower priority restores
 *                      `${OGR_SECRET_n}` placeholders in `params` — after
 *                      the judge, which saw the placeholder; the tool gets
 *                      the value. An unrestorable token → `{ block }` with
 *                      the notice.
 *
 *   message_sending    canonical step/response {text}, judged BEFORE the
 *                      outbound channel message leaves: block → `{ cancel }`.
 *
 * LOCAL REDACTION masks at the layer every harness shares — the HTTP
 * client. OpenClaw has no hook that rewrites the outbound provider request
 * (`llm_input` is `=> void`, observer-only — src/plugins/hook-types.ts) and
 * none that sees the system prompt; `installHttpInterceptor` wraps this
 * process's `fetch` (and undici's dispatcher where undici is resolvable),
 * so every outbound model request is masked whole and every reply restored
 * inside tool-call arguments only. The INGRESS hooks (`tool_result_persist`,
 * `before_message_write`) are the FALLBACK: they tokenise text as it enters
 * the session history until the interceptor has seen a model call go
 * through, then step aside — no second pass over the same text. Every event
 * this plugin sends passes the same value→token map first (D6), and a step
 * is reported as protected only when something provably masked it.
 *
 * An unanswered evaluate follows `failMode` (specification/degraded-mode.md):
 * open (default) proceeds loudly, closed refuses the action. This is a
 * restrict-only guard: it can stop a would-run tool call or a would-send
 * message, never loosen one. No OpenClaw core changes required.
 */
import { installHttpInterceptor, LocalRedactor, UNRESTORABLE_NOTICE, type HttpInterceptorHandle } from "@openguardrails/local-redaction"

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
  sessionId?: string
  channelId?: string
  messageProvider?: string
  workspaceDir?: string
  config?: unknown
}
/**
 * An OpenClaw `AgentMessage` (packages/llm-core: `content` is a string or
 * `text`/`thinking`/`toolCall`/`image` blocks). Walked as opaque JSON — every
 * string leaf masked, structural keys and image bytes left alone.
 */
export type AgentMessage = Record<string, unknown>
export interface ToolResultPersistEvent {
  toolName?: string
  toolCallId?: string
  message: AgentMessage
  isSynthetic?: boolean
}
export interface BeforeMessageWriteEvent {
  message: AgentMessage
  sessionKey?: string
  agentId?: string
}
export interface BeforePromptBuildEvent {
  prompt: string
  messages: unknown[]
}
export type BeforeToolCallResult =
  | { block: true; blockReason: string }
  | { params: Record<string, unknown> }
  | undefined
export type MessageSendingResult =
  | { cancel: true; cancelReason: string; metadata?: Record<string, unknown> }
  | undefined
export type ToolResultPersistResult = { message: AgentMessage } | undefined
export type BeforeMessageWriteResult = { message: AgentMessage } | { block: true } | undefined
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
  /** ⚠️ SYNCHRONOUS in the host (a Promise is ignored with a warning). */
  on(
    hook: "tool_result_persist",
    handler: (event: ToolResultPersistEvent, ctx: HookCtx) => ToolResultPersistResult,
    options?: { priority?: number },
  ): void
  /** ⚠️ SYNCHRONOUS in the host (a Promise is ignored with a warning). */
  on(
    hook: "before_message_write",
    handler: (event: BeforeMessageWriteEvent, ctx: HookCtx) => BeforeMessageWriteResult,
    options?: { priority?: number },
  ): void
  on(
    hook: "before_prompt_build",
    handler: (event: BeforePromptBuildEvent, ctx: HookCtx) => Promise<void>,
  ): void
}
export interface PluginEntry {
  id: string
  name: string
  description: string
  register(api: PluginApi): void
}

/** The guard's priority on `before_tool_call`; the restorer sits BELOW it, so it runs after. */
export const GUARD_PRIORITY = 50
export const RESTORE_PRIORITY = 10

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
    "Judge every tool call and outbound channel message through an OpenGuardrails runtime (OGR v1.0) — block enforced in place, fail-open by default; secrets masked on this host before they reach the model (OGR 1.4).",
  register(api) {
    const warn = (message: string): void => console.warn(`[openguardrails] ${message}`)

    // The workspace config tree only arrives at `gateway_start`; until then
    // the environment alone decides. `cfg` is re-resolved there, and the
    // client reads it through thunks so the late config lands without any
    // re-registration.
    let cfg: ResolvedConfig = resolveConfig(undefined)

    /**
     * Local redaction needs the runtime (the ruleset is the org's, fetched
     * with the key), so it comes up with the heartbeat: the moment a runtime
     * is configured. `register` is synchronous and so are two of the three
     * ingress hooks, so nothing here can await the first fetch — with no
     * cache, the first texts of a fresh install enter history unmasked and
     * are warned about, until the ruleset lands (§4.5).
     *
     * Two ways a step can be PROVABLY masked, and `masking()` is true under
     * either: the HTTP interceptor has seen a model call pass through, or an
     * ingress hook has masked (`redactor.fallbackActive`). Until one of them
     * holds, no `redaction` field goes out.
     */
    let redactor: LocalRedactor | null = null
    let http: HttpInterceptorHandle | null = null
    const sessionOf = (ctx: HookCtx): string => ctx.sessionKey ?? ctx.sessionId ?? ""
    const masking = (): boolean => redactor !== null && redactor.masking
    /** The interceptor has proven itself: the ingress hooks step aside so nothing is masked twice. */
    const interceptorLive = (): boolean => http !== null && http.sawTraffic

    const client = new OgrClient(
      { info: () => {}, warn: (m) => console.warn(m) },
      () => (cfg.apiKey ? { url: cfg.url, apiKey: cfg.apiKey } : null),
      () => cfg.timeoutMs,
      // D6: the OGR client is an egress. Known values → tokens on every event.
      (event) => (redactor && event.session_hint !== undefined ? redactor.maskKnown(event.session_hint, event).value : event),
    )

    // Liveness from the moment a runtime is configured: the first beat goes
    // out immediately (a live-but-idle assistant must register in fleet
    // coverage) and the interval timer never holds the process open. The
    // beat carries the ruleset id this process is on; its reply says
    // whether that is current.
    let heartbeatStarted = false
    const startHeartbeat = (): void => {
      if (heartbeatStarted || !client.enabled) return
      heartbeatStarted = true
      if (cfg.localRedaction.enabled) {
        redactor = new LocalRedactor({
          source: () => (cfg.apiKey ? { runtimeUrl: cfg.url, apiKey: cfg.apiKey } : null),
          ...(cfg.localRedaction.cachePath ? { cachePath: cfg.localRedaction.cachePath } : {}),
          tiers: cfg.localRedaction.tiers,
          timeoutMs: cfg.timeoutMs,
          log: { info: () => {}, warn: (m) => console.warn(m) },
        })
        void redactor.start()
        // The primary path: the HTTP client, wrapped now; undici's global
        // dispatcher composed when the import resolves (best-effort). The
        // plugin's own runtime calls go through the same wrapper untouched.
        if (cfg.localRedaction.http) {
          const r = redactor
          http = installHttpInterceptor({
            redactor: r,
            unprotected: cfg.failMode === "closed" ? "refuse" : "proceed",
            log: { info: () => {}, warn: (m) => console.warn(m) },
            onMiss: () =>
              warn(
                r.fallbackActive
                  ? "model traffic is not passing through the HTTP interceptor (a fetch captured before this plugin loaded, or a non-fetch HTTP client) — masking rides the ingress hooks instead; the system prompt is not covered"
                  : "model traffic is not passing through the HTTP interceptor — nothing is masked",
              ),
          })
        }
      }
      const beat = async (): Promise<void> => {
        const reply = await client.heartbeat(
          INTEGRATION,
          cfg.identity.agent_id,
          HEARTBEAT_INTERVAL_S,
          masking() ? { ruleset: redactor!.rulesetId } : {},
        )
        if (reply && redactor) redactor.onHeartbeat(reply)
      }
      void beat()
      const timer = setInterval(() => void beat(), HEARTBEAT_INTERVAL_S * 1000)
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

    /**
     * WHICH CONVERSATION this held action belongs to. OpenClaw hands every
     * hook its `sessionKey`, so this vantage holds the fact guard-event.md §
     * session_hint says to send: one opaque id per conversation, declared
     * rather than inferred from message prefixes. A host that names no
     * session sends no field — never `""`, which would assert a session
     * actually named "".
     */
    const sessionHint = (ctx: HookCtx): { session_hint?: string } =>
      ctx.sessionKey ? { session_hint: ctx.sessionKey } : {}

    /** The OGR 1.4 report for this step, while something provably masks. */
    const redaction = (ctx: HookCtx): { redaction?: WireEvent["redaction"] } => {
      const report = masking() ? redactor!.report(sessionOf(ctx)) : undefined
      return report ? { redaction: report } : {}
    }

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
    // of the action anyone can still refuse. The call is judged as the model
    // emitted it: with placeholders, never values.
    api.on(
      "before_tool_call",
      async (event, ctx) => {
        if (offline()) return undefined
        // The self-check: a tool call is downstream of a model call, so by
        // now the interceptor must have seen one. If it has not, it is not
        // on the path — said once, and nothing is reported as protected on
        // its account.
        http?.noteToolCall()
        const denial = await judge({
          kind: "step/response",
          step_id: mintStepId(),
          ...identity(ctx),
          llm_protocol: "canonical",
          ...sessionHint(ctx),
          ...redaction(ctx),
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
      { priority: GUARD_PRIORITY },
    )

    // Restore — on the way INTO the tool, AFTER the judge (D7). OpenClaw runs
    // `before_tool_call` handlers in priority order, higher first, and stops
    // at the first `{ block }` (src/plugins/hooks.ts, `runBeforeToolCall`),
    // so at a LOWER priority this only ever runs for a call the guard let
    // through, and its `params` replace the event's. The restore consults
    // the host session's map AND the interceptor's (the two vantages mint
    // into different maps) and is idempotent over a value with no token in
    // it. An unrestorable token blocks with the notice: a shell would expand
    // it to nothing.
    api.on(
      "before_tool_call",
      async (event, ctx) => {
        if (!redactor) return undefined
        const r = redactor.restoreArgs(sessionOf(ctx), event.params ?? {})
        if (r.unresolved.length > 0) {
          return { block: true, blockReason: `[OpenGuardrails] ${UNRESTORABLE_NOTICE(r.unresolved[0]!)}` }
        }
        return r.changed ? { params: r.args } : undefined
      },
      { priority: RESTORE_PRIORITY },
    )

    // INGRESS masking — the fallback: every text entering the session
    // history is tokenised here UNTIL the interceptor has seen a model call
    // go through; then the outbound request is masked whole at the HTTP
    // client and a second pass over the same text here would only mint a
    // second time. Both hooks are synchronous in the host.
    const maskMessage = (message: AgentMessage, ctx: HookCtx, what: string): AgentMessage | null => {
      if (!redactor || interceptorLive()) return null
      redactor.fallbackActive = true
      if (!redactor.ready) {
        redactor.warnUnprotected(what)
        return null
      }
      const r = redactor.maskValue(sessionOf(ctx), message)
      return r.changed ? r.value : null
    }
    api.on("tool_result_persist", (event, ctx) => {
      const masked = maskMessage(event.message, ctx, `this ${event.toolName ?? "tool"} result`)
      return masked ? { message: masked } : undefined
    })
    api.on("before_message_write", (event, ctx) => {
      const masked = maskMessage(event.message, ctx, "this message")
      return masked ? { message: masked } : undefined
    })

    // The one per-model-call hook this vantage has. Its event carries the
    // user prompt and the prepared history, NOT the system prompt, and its
    // `systemPrompt` result is an OVERRIDE rather than a rewrite
    // (src/plugins/hook-before-agent-start.types.ts) — so nothing can be
    // masked here; what the plugin can do is say, once per model call, that
    // the request is going out unprotected while no ruleset is in hand.
    api.on("before_prompt_build", async (_event, _ctx) => {
      if (redactor && !redactor.ready) redactor.warnUnprotected("this model request")
    })

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
        ...sessionHint(ctx),
        ...redaction(ctx),
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
  type LocalRedactionConfig,
  type RedactionTier,
  type ResolvedConfig,
  type RuntimeOptions,
} from "./config.js"
export type { HeartbeatReply, WireEvent, WireFinding, WireRedaction, WireToolCall, WireVerdict } from "./wire.js"
