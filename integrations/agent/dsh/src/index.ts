/**
 * @openguardrails/dsh — the OGR v0.7 Recipe A reference integration.
 *
 * dsh OWNS its loop, and this plugin sits on the loop's documented seams as an
 * ordinary Cordis plugin (no core changes), speaking the Runtime API directly
 * (two POSTs, no SDK). Recipe A, from specification/runtime-api.md:
 *
 *   1. PRE-MODEL     `llm/stream` waterfall → evaluate `step/request`
 *                    (the assembled request, openai.chat projection).
 *                    block ⇒ the model is never called; the step yields an
 *                    error finish and the loop closes the turn.
 *   2. POST-MODEL    the buffered answer → evaluate `step/response`
 *                    (canonical {text, reasoning?, tool_calls, model, usage,
 *                    timing}). block ⇒ refuse the step — or, when every
 *                    blocking finding names a `payload.tool_calls.N` path,
 *                    refuse ONLY those calls: the prose still reaches the
 *                    user and each offending call is denied at the tool
 *                    registry, which feeds the model an error result.
 *   3. TOOL RESULTS  are judged in the NEXT step's request (they travel
 *                    there) — no third call site exists, by design.
 *   4. TURN CLOSE    `session/event` → ingest `turn/end` with the loop's OWN
 *                    close reason; a turn this plugin blocked reports
 *                    `blocked` rather than the error the abort surfaced as.
 *
 * Every event DECLARES its coordinates — session_id (the dsh session), turn
 * and step (the loop's own 1-based numbers, tracked off the `agent/request`
 * dispatch), parent_session_id for subagent children — so the runtime never
 * derives; the verdict echoes them back with `attribution: "declared"`.
 *
 * Enforcement at the tool registry is a CONSEQUENCE of the step verdict, not
 * a separate judgement: `tools/pre-execute` denies the calls the
 * `step/response` verdict refused, the monotonic `ctx.tools.guard` re-asserts
 * it against waterfall reordering, and under `failMode: "closed"` a call that
 * reached execution with NO verdict at all is refused — that is the signature
 * of a short-circuited waterfall or an unjudged step, and "could not look" is
 * not "found nothing".
 *
 * Auto mode survives unchanged in spirit: for sessions on the `auto-mode`
 * permission preset, approval asks are answered from the step verdict —
 * an allowed call grants once, a refused one rejects, and anything the
 * verdict never covered falls to the human gate (or is rejected, per config).
 *
 * @module @openguardrails/dsh
 */
import type { Context } from "@deepseek-ai/cordis"
import z from "@deepseek-ai/schemastery"
import type { Agent } from "@deepseek-ai/dsh-agent"
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm"
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session"
import type {
  PreToolDecision,
  ToolExecution,
  ToolExecutionResult,
} from "@deepseek-ai/dsh-tools"
// Type-only: declaration-merges the `approval/request` event onto the Events
// table. Never a value import — a composition without the approval service
// simply never dispatches the event, and this plugin must load fine there.
import type { ApprovalRequest } from "@deepseek-ai/dsh-user-approval"
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings"
import {
  DEFAULT_AUTO_PRESET,
  DEFAULT_RUNTIME_URL,
  DEFAULT_TIMEOUT_MS,
  type AutoApprovalConfig,
  type AutoUnresolved,
  type FailMode,
  type GuardrailsOptions,
  type RuntimeOptions,
} from "./config.js"
import { LLM_PROTOCOL, requestBody, ResponseAccumulator } from "./llm-wire.js"
import { hostAgentId, osUser } from "./platform.js"
import { OgrClient, type WireEvent, type WireFinding, type WireVerdict } from "./wire.js"

/** Cordis plugin name; the `id:` in `cordis.yml` is the deployment's own label. */
export const name = "openguardrails"

/** Settings namespace: the "openguardrails" card in the dsh Settings page. */
export const OGR_SETTINGS_NAMESPACE = settingsNamespace("openguardrails")

/** What kind of agent this integration instruments (`agent_type` claim). */
const AGENT_TYPE = "dsh"

/** `integration` field on every event: which build observed it. */
export const INTEGRATION = "ogr-dsh/0.2.0"

/**
 * The tool registry is the enforcement surface: without it this plugin has
 * nothing to guard, so it waits for the service rather than registering
 * listeners that would silently never fire. Everything else — the agent-loop
 * events, the session log, `ctx.approval` — is read opportunistically.
 */
// ⚠️ An ARRAY, and only `tools`. This Cordis's `Inject` object form maps
// service name → intercept config, NOT `{required, optional}`.
export const inject = ["tools"]

export interface Config extends GuardrailsOptions {}

// `url` deliberately has NO schema default: schemastery materializes defaults
// into the resolved config, which would shadow an OGR_RUNTIME_URL from the
// environment. The built-in cloud URL is applied at the END of the resolution
// chain instead (Settings → config → env → DEFAULT_RUNTIME_URL).
const RuntimeSchema: z<RuntimeOptions> = z.object({
  url: z.string()
    .description(`OpenGuardrails runtime base URL (empty = ${DEFAULT_RUNTIME_URL})`),
  apiKey: z.string().role("secret")
    .description("API key — get one at https://openguardrails.com"),
  workspace: z.string()
    .description("agent_workspace claim: the platform policy/resource group this agent belongs to (NOT a directory); empty = the API key's workspace"),
  owner: z.string()
    .description("agent_owner claim; empty = the OS account the harness runs as"),
  user: z.string()
    .description("agent_user claim; empty = the OS account the harness runs as"),
})

const AutoSchema: z<AutoApprovalConfig> = z.object({
  enabled: z.boolean().default(true)
    .description("Register the answerer (inert until a session selects the preset)"),
  preset: z.string().default(DEFAULT_AUTO_PRESET)
    .description("Permission-preset name whose sessions this plugin answers for"),
  unresolved: z.union([
    z.const("human").description("delegate to the next answerer — the human gate"),
    z.const("reject").description("refuse the ask (strict headless stance)"),
  ]).default("human")
    .description("What happens to an ask the step verdict never covered"),
})

export const Config: z<Config> = z.object({
  runtime: RuntimeSchema.description("OpenGuardrails runtime connection and identity claims (also editable in Settings; environment fills gaps)"),
  failMode: z.union([
    z.const("open").description("proceed loudly when the runtime cannot answer"),
    z.const("closed").description("treat \"could not look\" as block"),
  ]).default("open")
    .description("Degraded-mode posture (specification/degraded-mode.md)"),
  timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS)
    .description("Per-call evaluate budget in milliseconds"),
  auto: AutoSchema.description("Auto mode: answer approval asks with the step verdict for auto-preset sessions"),
})

/** Bound on the per-call verdict table; released on `tools/result`, capped as a backstop. */
const CALLS_MAX = 4096

/** What the step verdict said about one tool call. */
type CallVerdict = { allow: true } | { allow: false; reason: string }

/** DSH's turn-end kinds → the v0.7 close-reason vocabulary (1:1, one spelling change). */
const TURN_END_REASON: Record<string, "completed" | "max_tokens" | "blocked" | "aborted" | "error"> = {
  "completed": "completed",
  "max-tokens": "max_tokens",
  "blocked": "blocked",
  "aborted": "aborted",
  "error": "error",
}

/** One-line human summary of a verdict for a denial reason. */
function brief(v: WireVerdict): string {
  const f = (v.findings ?? [])
    .map((x) => `${x.category}${x.severity ? `(${x.severity})` : ""}`)
    .join(", ")
  return f || v.decision
}

/**
 * The block-justifying findings that name a specific tool call, by index.
 * `payload.tool_calls.3.arguments.command` and `payload.tool_calls.3` both
 * attribute to call 3 — the path grammar is dotted, and the index is the
 * second segment.
 */
function callTargets(findings: readonly WireFinding[]): Map<number, WireFinding> {
  const out = new Map<number, WireFinding>()
  for (const f of findings) {
    const m = /^payload\.tool_calls\.(\d+)(?:\.|$)/.exec(f.path ?? "")
    if (m) out.set(Number(m[1]), out.get(Number(m[1])) ?? f)
  }
  return out
}

/**
 * The session's effective permission preset: the last `permission/preset`
 * event in the log — re-folded over the raw event shape so a deployment
 * without `dsh-permission-presets` costs neither a dependency nor a load
 * failure.
 */
function effectivePreset(events: readonly unknown[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as { type?: string; data?: { preset?: unknown } } | undefined
    if (event?.type === "permission/preset") {
      return typeof event.data?.preset === "string" ? event.data.preset : undefined
    }
  }
  return undefined
}

/**
 * Install the guard's listeners.
 * @param ctx - plugin context; every registration is scoped to it and unwinds
 *   with it, so a hot reload leaves nothing behind.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const warn = (message: string): void => ctx.logger.warn(`openguardrails: ${message}`)
  const failMode: FailMode = config.failMode ?? "open"

  // ---- the runtime connection: Settings → cordis config → env → default ----
  const runtimeDefaults: RuntimeOptions = {
    url: config.runtime?.url || process.env.OGR_RUNTIME_URL || DEFAULT_RUNTIME_URL,
    apiKey: config.runtime?.apiKey || process.env.OGR_API_KEY || "",
    workspace: config.runtime?.workspace || process.env.OGR_AGENT_WORKSPACE || "",
    owner: config.runtime?.owner || process.env.OGR_AGENT_OWNER || "",
    user: config.runtime?.user || process.env.OGR_AGENT_USER || "",
  }
  let runtimeSettings: () => RuntimeOptions = () => runtimeDefaults
  installSettingsSection(ctx, OGR_SETTINGS_NAMESPACE, RuntimeSchema, runtimeDefaults, {
    setSource: (current: () => RuntimeOptions) => {
      runtimeSettings = current
    },
    onChange: () => {},
  })

  const client = new OgrClient(
    { info: (m) => ctx.logger.info(m), warn: (m) => ctx.logger.warn(m) },
    () => {
      const s = runtimeSettings()
      return s.apiKey ? { url: s.url || DEFAULT_RUNTIME_URL, apiKey: s.apiKey } : null
    },
    () => config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  )

  // One harness process per machine → machine-scoped identity, resolved once.
  const agentId = hostAgentId()
  const accountUser = osUser()

  /** The identity claims every event carries, read live so a Settings edit lands immediately. */
  const claims = (): Pick<WireEvent, "agent_workspace" | "agent_owner" | "agent_user"> => {
    const s = runtimeSettings()
    const owner = s.owner || accountUser
    const user = s.user || accountUser
    return {
      ...s.workspace ? { agent_workspace: s.workspace } : {},
      ...owner ? { agent_owner: owner } : {},
      ...user ? { agent_user: user } : {},
    }
  }

  // ---- the loop's own coordinates ------------------------------------------
  //
  // `agent/request` fires once per step with the loop's {turn, step} — the
  // very numbers the session log stamps into its own events. Recorded here,
  // read by the `llm/stream` guard moments later in the same step. A
  // pass-through waterfall listener: this plugin only watches.
  interface Coords {
    turn: number
    step: number
    parentSession?: string
  }
  const coordsBySession = new Map<string, Coords>()
  ctx.on("agent/request", (payload, next) => {
    const parent = payload.agent.session.header.parentSession
    coordsBySession.set(payload.agent.id, {
      turn: payload.turn,
      step: payload.step,
      ...parent ? { parentSession: String(parent) } : {},
    })
    return next()
  })

  /** Base fields shared by every event of one session. */
  const baseEvent = (sessionId: string | undefined): Omit<WireEvent, "kind" | "payload"> => {
    const coords = sessionId ? coordsBySession.get(sessionId) : undefined
    return {
      ogr_version: "0.7",
      timestamp: new Date().toISOString(),
      agent_id: agentId,
      agent_type: AGENT_TYPE,
      integration: INTEGRATION,
      ...claims(),
      ...sessionId ? { session_id: sessionId } : {},
      ...coords ? { turn: coords.turn, step: coords.step } : {},
      ...coords?.parentSession ? { parent_session_id: coords.parentSession } : {},
    }
  }

  // ---- per-call verdicts, and the turns this plugin itself blocked ---------
  const callVerdicts = new Map<string, CallVerdict>()
  const ogrBlockedTurns = new Set<string>()

  function rememberCall(callId: string, verdict: CallVerdict): void {
    if (callVerdicts.size >= CALLS_MAX) {
      const oldest = callVerdicts.keys().next()
      if (!oldest.done) callVerdicts.delete(oldest.value)
    }
    callVerdicts.set(callId, verdict)
  }

  /**
   * The chunk a blocked step yields instead of the model's answer. `error` is
   * the honest finish kind: the step did not stop because the model stopped,
   * and the loop's own error handling is what should see it. The turn is
   * marked so its `turn/end` reports `blocked` rather than `error`.
   */
  const blockedChunk = (sessionId: string | undefined, detail: string): StreamChunk => {
    const coords = sessionId ? coordsBySession.get(sessionId) : undefined
    if (sessionId && coords) ogrBlockedTurns.add(`${sessionId}#${coords.turn}`)
    return {
      type: "finish",
      reason: {
        kind: "error",
        failure: { message: `[OpenGuardrails] ${detail}`, code: "ogr_blocked" },
      },
    }
  }

  // ---- Recipe A steps 1 + 2: the two halves of every model call ------------
  let warnedNoRuntime = false
  let warnedSpans = false
  ctx.on("llm/stream", (options: GenerateOptions, next): AsyncIterable<StreamChunk> => {
    // An auxiliary call (compaction, session titling) is machinery, not the
    // agent's conversation; judging it would bill a round trip for a summary
    // of history the runtime has already seen.
    if (options.purpose !== undefined) return next()

    return (async function* guarded(): AsyncIterable<StreamChunk> {
      if (!client.enabled) {
        // No runtime configured = the integration is off, loudly, once. This
        // is a deployment choice, not degraded mode — failMode governs a
        // runtime that IS configured and cannot answer.
        if (!warnedNoRuntime) {
          warnedNoRuntime = true
          warn(
            "no runtime configured — set OGR_API_KEY in ~/.dsh/.env (or the Settings card). "
            + "Streaming through unguarded until then.",
          )
        }
        yield* next()
        return
      }

      const sessionId = options.sessionId ? String(options.sessionId) : undefined

      // -- step/request: judged before the model sees it --
      const reqVerdict = await client.evaluate({
        ...baseEvent(sessionId),
        kind: "step/request",
        llm_protocol: LLM_PROTOCOL,
        payload: requestBody(options),
      })
      if (!reqVerdict) {
        if (failMode === "closed") {
          yield blockedChunk(sessionId, "this model call could not be judged and the deployment is fail-closed")
          return
        }
        warn("step/request got no verdict — proceeding (fail-open)")
      } else {
        if (reqVerdict.decision === "block") {
          yield blockedChunk(sessionId, `this model call was blocked: ${brief(reqVerdict)}`)
          return
        }
        if (failMode === "closed" && (reqVerdict.unjudged?.length ?? 0) > 0) {
          yield blockedChunk(
            sessionId,
            `parts of this model call went unjudged (${reqVerdict.unjudged!.join(", ")}) and the deployment is fail-closed`,
          )
          return
        }
        if ((reqVerdict.modifications?.spans?.length ?? 0) > 0 && !warnedSpans) {
          // Applying spans would mean splicing dsh's own message objects from
          // wire paths — not implemented yet. Stated ONCE, in the log and the
          // README, rather than silently: the runtime's copy is masked either
          // way; what is not masked is what this process sends the provider.
          warnedSpans = true
          warn("the verdict carried redaction spans, which this integration cannot apply yet — content sent unredacted")
        }
      }

      // -- the model call, buffered --
      //
      // `enforce` semantics require buffering: "before the agent acts on it"
      // is literally true only if no chunk escapes while the verdict is in
      // flight. The loop consumes block-ends, so re-yielding the buffered
      // chunks afterwards reproduces the stream exactly.
      const accumulator = new ResponseAccumulator(options.model)
      const buffered: StreamChunk[] = []
      for await (const chunk of next()) {
        accumulator.push(chunk)
        buffered.push(chunk)
      }

      // An aborted or empty stream has no complete answer to judge.
      if (!accumulator.complete || accumulator.empty) {
        yield* buffered
        return
      }

      // -- step/response: judged before the agent acts on it --
      const resVerdict = await client.evaluate({
        ...baseEvent(sessionId),
        kind: "step/response",
        payload: accumulator.body(),
      })
      const calls = accumulator.toolCalls

      if (!resVerdict) {
        if (failMode === "closed") {
          yield blockedChunk(sessionId, "the model's answer could not be judged and the deployment is fail-closed")
          return
        }
        warn("step/response got no verdict — releasing the answer (fail-open); its tool calls carry no verdict")
        yield* buffered
        return
      }

      if (failMode === "closed" && (resVerdict.unjudged?.length ?? 0) > 0) {
        yield blockedChunk(
          sessionId,
          `parts of the model's answer went unjudged (${resVerdict.unjudged!.join(", ")}) and the deployment is fail-closed`,
        )
        return
      }

      if (resVerdict.decision === "block") {
        const targets = callTargets(resVerdict.findings ?? [])
        const everyBlockNamesACall = (resVerdict.findings ?? [])
          .filter((f) => f.action === "block" || f.action === undefined)
          .every((f) => /^payload\.tool_calls\./.test(f.path ?? ""))
        if (targets.size > 0 && everyBlockNamesACall) {
          // Per-call refusal (the spec's sanctioned narrowing): the prose
          // reaches the user, the offending calls are denied at the registry
          // and the model reads an error result for each.
          calls.forEach((call, index) => {
            const hit = targets.get(index)
            rememberCall(call.id, hit
              ? { allow: false, reason: `${hit.category}${hit.severity ? ` (${hit.severity})` : ""}` }
              : { allow: true })
          })
          yield* buffered
          return
        }
        yield blockedChunk(sessionId, `the model's answer was blocked: ${brief(resVerdict)}`)
        return
      }

      // allow — every call in this step is cleared by the step verdict.
      for (const call of calls) rememberCall(call.id, { allow: true })
      yield* buffered
    })()
  })

  // ---- enforcement at the registry: the step verdict's consequences --------
  //
  // Prepended: `tools/pre-execute` is dsh's reorderable policy layer, and a
  // permissive listener that returns `allow` without delegating short-circuits
  // the waterfall. The monotonic guard below covers reordering regardless.
  ctx.on("tools/pre-execute", async (exec: ToolExecution, next): Promise<PreToolDecision> => {
    const verdict = callVerdicts.get(String(exec.callId))
    if (verdict && !verdict.allow) {
      return { kind: "deny", reason: `[OpenGuardrails] ${verdict.reason}` }
    }
    if (!verdict && client.enabled && failMode === "closed") {
      return {
        kind: "deny",
        reason: `[OpenGuardrails] this ${exec.name} call carries no step verdict and the deployment is fail-closed`,
      }
    }
    return next()
  }, { prepend: true })

  // The one denial that cannot be reordered away.
  ctx.tools.guard((exec): string | undefined => {
    const verdict = callVerdicts.get(String(exec.callId))
    if (verdict) return verdict.allow ? undefined : `[OpenGuardrails] ${verdict.reason}`
    if (client.enabled && failMode === "closed") {
      return `[OpenGuardrails] this ${exec.name} call was never covered by a step verdict and the deployment is fail-closed`
    }
    return undefined
  })

  // Release the call verdict on the registry's authoritative final outcome.
  ctx.on("tools/result", (exec: Readonly<ToolExecution>, _result: Readonly<ToolExecutionResult>) => {
    callVerdicts.delete(String(exec.callId))
  })

  // Tool RESULTS are deliberately not evaluated here: they are judged inside
  // the NEXT step/request, where they travel (Recipe A step 3). The
  // post-execute waterfall is left to other policy layers.

  // ---- Recipe A step 4: the turn's close, with its reason ------------------
  ctx.on("session/event", (session: Session, event: SessionEvent) => {
    if (event.type !== "turn/end" || !client.enabled) return
    const data = event.data as { turn?: number; reason?: { kind?: string } }
    const turn = typeof data.turn === "number" ? data.turn : undefined
    const kind = data.reason?.kind ?? "completed"
    const blockedByUs = turn !== undefined && ogrBlockedTurns.delete(`${session.id}#${turn}`)
    const reason = blockedByUs ? "blocked" : (TURN_END_REASON[kind] ?? "error")
    const parent = session.header.parentSession
    void client.ingest([{
      ogr_version: "0.7",
      kind: "turn/end",
      timestamp: new Date().toISOString(),
      agent_id: agentId,
      agent_type: AGENT_TYPE,
      integration: INTEGRATION,
      ...claims(),
      session_id: String(session.id),
      ...turn !== undefined ? { turn } : {},
      ...parent ? { parent_session_id: String(parent) } : {},
      payload: { reason },
    }])
  })

  // ---- auto mode: the step verdict answers the approval seam ---------------
  //
  // For sessions on the auto preset, asks that would reach a human — a
  // sandbox-escalation retry, a tool whose policy layer said `ask` — resolve
  // from the verdict the step already earned. Same claim-or-delegate shape as
  // dsh's own ACP bridge, prepended so it runs before the chat UI's answerer;
  // every other session delegates untouched.
  const auto = config.auto ?? {}
  if (auto.enabled !== false) {
    const autoPreset = auto.preset ?? DEFAULT_AUTO_PRESET
    const unresolved: AutoUnresolved = auto.unresolved ?? "human"

    let onboarded = false
    ctx.on("approval/request", async (req: ApprovalRequest, next) => {
      if (effectivePreset(req.agent.session.events) !== autoPreset) return next()

      if (!client.enabled && !onboarded) {
        onboarded = true
        warn(
          "Auto Mode has no runtime to answer from. Register at https://openguardrails.com for an API key "
          + "and set OGR_API_KEY in ~/.dsh/.env to connect one.",
        )
      }

      const undecided = () => (unresolved === "reject" ? Promise.resolve("rejected" as const) : next())
      if (req.callId === undefined) return undecided()
      const verdict = callVerdicts.get(String(req.callId))
      if (!verdict) return undecided()
      return verdict.allow ? "allowed-once" : "rejected"
    }, { prepend: true })
  }
}

export default { name, inject, Config, apply }

export {
  DEFAULT_AUTO_PRESET,
  DEFAULT_RUNTIME_URL,
  DEFAULT_TIMEOUT_MS,
} from "./config.js"
export type {
  AutoApprovalConfig,
  AutoUnresolved,
  FailMode,
  GuardrailsOptions,
  RuntimeOptions,
} from "./config.js"
export type { WireEvent, WireFinding, WireVerdict } from "./wire.js"
