/**
 * @openguardrails/opencode-auto-mode — OGR v1.0 (+1.4 local redaction) for opencode.
 *
 * Auto mode for opencode: permission prompts answered by an OpenGuardrails
 * RUNTIME verdict instead of a human. v0.8 retired the SDK — and with it
 * this plugin's local policy engine (regex rules, bring-your-own-model
 * judge, taint) — so every decision now comes from `/v1/evaluate`, spoken
 * directly: one hand-rolled POST per held action, `Bearer` key, eight fields.
 *
 * THE VANTAGE, honestly: opencode's plugin surface exposes TOOL-CALL hooks,
 * not the model byte path — this plugin's HOOKS never hold a provider
 * request or response body, so the recipe's paired step/request +
 * step/response per model call cannot be implemented from them (the README
 * states the limitation). What the hooks DO hold, at the two refusable
 * moments the host offers, is a model-produced tool call the host is about
 * to act on. Each becomes ONE canonical `step/response` carrying exactly the
 * `tool_calls` in hand — nothing decomposed, nothing fabricated (no timing:
 * this vantage observes no byte path). A fresh `step_id` is minted per
 * event; there is no request half to pair it with, and the runtime derives
 * session/turn/step itself.
 *
 *   tool.execute.before   the call, judged BEFORE it runs:
 *                         block → throw (deny-and-continue — the agent sees
 *                         a tool error and must find a safer path); the
 *                         verdict is recorded under the `callID`. THEN the
 *                         call's arguments are restored (local redaction):
 *                         the judge saw `${OGR_SECRET_n}`, the tool gets the
 *                         value. An unrestorable token throws the notice.
 *
 *   permission.ask        opencode's own permission prompt. Answered from
 *                         the recorded call's verdict when the ask carries a
 *                         known `callID`, else evaluated from the ask's own
 *                         metadata (opencode's bash asks put the command
 *                         there): allow → "allow", block → "deny",
 *                         nothing to judge → the human (default) or "deny"
 *                         under `auto.unresolved: "reject"`.
 *
 * LOCAL REDACTION masks at the layer every harness shares — the HTTP client.
 * `installHttpInterceptor` wraps this process's `fetch` (and undici's
 * dispatcher where undici is resolvable): every outbound model request is
 * masked whole — system prompt included — and every reply restored inside
 * tool-call arguments only. The hooks are the FALLBACK:
 *
 *   experimental.chat.messages.transform
 *                         masks the messages about to be sent, UNTIL the
 *                         interceptor has seen a model call go through —
 *                         then it steps aside (no double pass). Verified
 *                         against @opencode-ai/plugin 1.14.28.
 *
 *   tool.execute.after    a tool's output masked BEFORE it enters history,
 *                         on the same condition.
 *
 * Every event sent to the runtime passes the same value→token map first
 * (D6): the OGR client is an egress and is masked like the provider is. And
 * a step is reported as protected ONLY when something provably masked it —
 * the interceptor saw traffic, or the hook fallback engaged; a tool call
 * that arrives before either is warned about once and sends no `redaction`.
 *
 * An unanswered evaluate follows `failMode` (specification/degraded-mode.md):
 * open (default) proceeds loudly, closed refuses the call. Auto mode stays
 * restrict-only toward the agent — it automates the HUMAN's seat, never
 * overrides a verdict, and a block stays blocked everywhere.
 *
 * No opencode core changes required.
 */
import { installHttpInterceptor, LocalRedactor, UNRESTORABLE_NOTICE, type HttpInterceptorHandle } from "@openguardrails/local-redaction"

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
export interface ToolExecuteAfterInput {
  tool: string
  sessionID: string
  callID: string
  args?: unknown
}
/** `@opencode-ai/plugin` 1.14: `{ title, output, metadata }`, mutable. */
export interface ToolExecuteAfterOutput {
  title?: string
  output?: string
  metadata?: unknown
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
/**
 * `@opencode-ai/plugin` 1.14.28: `experimental.chat.messages.transform(input: {},
 * output: { messages: { info: Message; parts: Part[] }[] })`. `info.sessionID`
 * names the session; a part is a `text`/`reasoning` (`.text`), a `tool`
 * (`.state.input`/`.state.output`), a file, or a marker — the walk masks every
 * string leaf and leaves ids alone.
 */
export interface ChatMessage {
  info: { sessionID?: string; role?: string; [key: string]: unknown }
  parts: Array<Record<string, unknown>>
}
export interface ChatMessagesTransformOutput {
  messages: ChatMessage[]
}
export interface Hooks {
  "tool.execute.before"?: (input: ToolExecuteBeforeInput, output: ToolExecuteBeforeOutput) => Promise<void>
  "tool.execute.after"?: (input: ToolExecuteAfterInput, output: ToolExecuteAfterOutput) => Promise<void>
  "permission.ask"?: (input: PermissionAskInput, output: PermissionAskOutput) => Promise<void>
  "experimental.chat.messages.transform"?: (input: Record<string, never>, output: ChatMessagesTransformOutput) => Promise<void>
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
  const source = () => (cfg.apiKey ? { url: cfg.url, apiKey: cfg.apiKey } : null)

  /**
   * Local redaction needs the runtime (the ruleset is the org's, fetched
   * with the key), so it exists exactly when a runtime is configured.
   *
   * Two ways a step can be PROVABLY masked, and `masking()` is true under
   * either: the HTTP interceptor has seen a model call pass through
   * (`http.sawTraffic`), or the messages hook has fired and masked
   * (`hostTransforms`, mirrored into `redactor.fallbackActive`). Until one
   * of them holds, the plugin sends no `redaction` field: a report that said
   * "protected" over an unmasked request would be worse than none.
   */
  const redactor =
    cfg.localRedaction.enabled && cfg.apiKey
      ? new LocalRedactor({
          source: () => (cfg.apiKey ? { runtimeUrl: cfg.url, apiKey: cfg.apiKey } : null),
          ...(cfg.localRedaction.cachePath ? { cachePath: cfg.localRedaction.cachePath } : {}),
          tiers: cfg.localRedaction.tiers,
          timeoutMs: cfg.timeoutMs,
          log: { info: () => {}, warn: (m) => console.warn(m) },
        })
      : null
  let hostTransforms = false
  let http: HttpInterceptorHandle | null = null
  const masking = (): boolean => redactor !== null && (http ? redactor.masking : hostTransforms)
  /** The interceptor has proven itself: the hook path steps aside so nothing is masked twice. */
  const interceptorLive = (): boolean => http !== null && http.sawTraffic

  const client = new OgrClient(
    { info: () => {}, warn: (m) => console.warn(m) },
    source,
    () => cfg.timeoutMs,
    // D6: the OGR client is an egress. Known values → tokens on every event.
    (event) => (redactor && event.session_hint !== undefined ? redactor.maskKnown(event.session_hint, event).value : event),
  )

  // Cache first, one fetch when there is none — awaited so a fresh install's
  // first model call is masked rather than reported as unprotected.
  if (redactor) await redactor.start()

  // The primary path: the HTTP client. Installed on `globalThis.fetch` now,
  // and on undici's global dispatcher when the import resolves (best-effort,
  // in the background). The plugin's own runtime calls go through the same
  // wrapper and pass through untouched — an evaluate body is not a model call.
  if (redactor && cfg.localRedaction.http) {
    http = installHttpInterceptor({
      redactor,
      unprotected: cfg.failMode === "closed" ? "refuse" : "proceed",
      log: { info: () => {}, warn: (m) => console.warn(m) },
      onMiss: () =>
        warn(
          hostTransforms
            ? "model traffic is not passing through the HTTP interceptor (a fetch captured before this plugin loaded, or a non-fetch HTTP client) — masking rides the experimental messages hook instead"
            : "model traffic is not passing through the HTTP interceptor — nothing is masked",
        ),
    })
  }

  // Liveness from boot: the runtime must be able to tell "agent idle" from
  // "integration never came up", so the first beat goes out immediately and
  // the interval timer never holds the process open. The beat carries the
  // ruleset id this process is on, and its reply says whether that is current.
  if (client.enabled) {
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

  /**
   * The one held action → one canonical step/response: the eight required
   * fields, plus `session_hint` when the host names the session this call
   * belongs to (opencode's hooks carry `sessionID`, so this vantage holds the
   * fact the spec says to send), `integration`, stamped by the client, and
   * — while something provably masks — the `redaction` report for this step.
   */
  const heldCallEvent = (callId: string, name: string, args: unknown, sessionId?: string): WireEvent => {
    const report = masking() && sessionId ? redactor!.report(sessionId) : undefined
    return {
      kind: "step/response",
      step_id: mintStepId(),
      ...cfg.identity,
      llm_protocol: "canonical",
      payload: { tool_calls: [{ id: callId, name, arguments: args }] },
      ...(sessionId ? { session_hint: sessionId } : {}),
      ...(report ? { redaction: report } : {}),
    }
  }

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
  async function judge(callId: string, name: string, args: unknown, sessionId?: string): Promise<CallVerdict | null> {
    const verdict = await client.evaluate(heldCallEvent(callId, name, args, sessionId))
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

  /**
   * Restore — on the way INTO the tool, AFTER the judge (design D7): the
   * held call was judged with placeholders; the tool gets the values. The
   * restore consults the host session's map AND the interceptor's (the two
   * vantages mint into different maps) and is idempotent over a value with
   * no token in it. An unrestorable token refuses the call with a notice the
   * model can act on — the plugin's existing deny-and-continue shape —
   * because a shell would expand `${OGR_SECRET_7}` to nothing and fail
   * somewhere unnamed.
   */
  function restoreInto(output: ToolExecuteBeforeOutput, sessionId: string, tool: string): void {
    if (!redactor) return
    const r = redactor.restoreArgs(sessionId, output.args)
    if (r.unresolved.length > 0) {
      throw new Error(`[OpenGuardrails] blocked this ${tool} call: ${UNRESTORABLE_NOTICE(r.unresolved[0]!)}`)
    }
    if (r.changed) output.args = r.args
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
      // The self-check: a tool call is downstream of a model call, so by now
      // the interceptor must have seen one. If it has not, it is not on the
      // path — said once, and nothing is reported as protected on its account.
      http?.noteToolCall()
      const verdict = await judge(input.callID, input.tool, output.args, input.sessionID)
      if (verdict) {
        rememberCall(input.callID, verdict)
        if (!verdict.allow) {
          throw new Error(`[OpenGuardrails] blocked this ${input.tool} call: ${verdict.reason}`)
        }
      }
      // Judged (or fail-open, undecided) → the call proceeds → restore.
      restoreInto(output, input.sessionID, input.tool)
    },

    "tool.execute.after": async (input, output) => {
      callVerdicts.delete(input.callID)
      // Tokenise the tool's output BEFORE it enters history — the hook path,
      // taken only while the interceptor has not proven itself: once model
      // traffic passes through it, the outbound request is masked there and
      // this pass would be a second one over the same text.
      if (redactor && hostTransforms && !interceptorLive() && typeof output?.output === "string" && output.output !== "") {
        output.output = redactor.mask(input.sessionID, output.output).text
      }
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      if (!redactor) return
      if (interceptorLive()) return // the interceptor masks the request whole; no second pass
      hostTransforms = true
      redactor.fallbackActive = true
      if (!redactor.ready) {
        // §4.5: no ruleset anywhere. Open proceeds unmasked and says so on
        // every request; closed refuses the model call.
        if (cfg.failMode === "closed") {
          throw new Error("[OpenGuardrails] no local-redaction ruleset could be obtained and the deployment is fail-closed")
        }
        redactor.warnUnprotected("this model request")
        return
      }
      for (const message of output.messages ?? []) {
        const sessionId = message.info?.sessionID ?? ""
        const masked = redactor.maskValue(sessionId, message.parts)
        if (!masked.changed) continue
        // Replace in place — same array, same length, same indexes.
        masked.value.forEach((part, i) => {
          message.parts[i] = part
        })
      }
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
      const verdict = await judge(input.callID ?? input.id ?? mintStepId(), input.type, metadata, input.sessionID)
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
  type LocalRedactionConfig,
  type RedactionTier,
  type RuntimeOptions,
} from "./config.js"
export type { HeartbeatReply, WireEvent, WireFinding, WireRedaction, WireToolCall, WireVerdict } from "./wire.js"
