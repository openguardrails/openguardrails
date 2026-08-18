/**
 * @openguardrails/dsh — the OGR v0.8 reference agent-direct integration.
 *
 * dsh OWNS its loop, and this plugin sits on the loop's documented seams as an
 * ordinary Cordis plugin (no core changes), speaking the Runtime API directly
 * — one decision endpoint, no SDK. The recipe, from
 * specification/runtime-api.md:
 *
 *   1. MINT `step_id`  one fresh random id per model call, the same value on
 *                      the call's two events — the ONE coordinate v0.8 kept,
 *                      because concurrent calls make pairing underivable.
 *   2. PRE-MODEL       `llm/stream` waterfall → evaluate `step/request`
 *                      (the assembled request, openai.chat projection).
 *                      block ⇒ the model is never called; the step yields an
 *                      error finish and the loop closes the turn.
 *   3. POST-MODEL      the reassembled answer → evaluate `step/response`
 *                      (canonical {text, reasoning?, tool_calls, model,
 *                      usage?, timing}), judged EXACTLY ONCE, whole, at
 *                      stream end while the TAIL is still held back. allow ⇒
 *                      release the tail; block ⇒ drop it — or, when every
 *                      blocking finding names a `payload.tool_calls.N` path,
 *                      refuse ONLY those calls: the prose reaches the user
 *                      and each offending call is denied at the tool
 *                      registry, which feeds the model an error result.
 *   4. TOOL RESULTS    are judged in the NEXT step's request (they travel
 *                      there) — no third call site exists, by design.
 *   5. HEARTBEAT       `/v1/heartbeat` carries the build id and the
 *                      degraded-mode counters, so the runtime can tell
 *                      "agent idle" from "integration went dark".
 *
 * Nothing else is on the wire. v0.8 removed every declared coordinate —
 * session, turn, step numbering, parent links, timestamps, `turn/end` marks,
 * `/v1/ingest` — the runtime derives all of it from the stateless, repetitive
 * requests themselves. What only the producer can know became REQUIRED: the
 * identity four-tuple rides on every event, with `""` as the explicit "no
 * assertion" (the API key is the identity floor).
 *
 * Enforcement at the tool registry is a CONSEQUENCE of the step verdict, not
 * a separate judgement: `tools/pre-execute` denies the calls the
 * `step/response` verdict refused, the monotonic `ctx.tools.guard` re-asserts
 * it against waterfall reordering, and under `failMode: "closed"` a call that
 * reached execution with NO verdict at all is refused — that is the signature
 * of a short-circuited waterfall or an unjudged step, and "could not look" is
 * not "found nothing". The DEFAULT is open, per the degraded-mode spec: an
 * instrument that can halt the agent it observes would never be adopted, so
 * blocking on outage is an explicit deployment choice.
 *
 * Auto mode survives unchanged in spirit: for sessions on the `auto-mode`
 * permission preset, approval asks are answered from the step verdict —
 * an allowed call grants once, a refused one rejects, and anything the
 * verdict never covered falls to the human gate (or is rejected, per config).
 *
 * @module @openguardrails/dsh
 */
import { randomUUID } from "node:crypto"
import type { Context } from "@deepseek-ai/cordis"
import z from "@deepseek-ai/schemastery"
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm"
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
  DEFAULT_HEARTBEAT_S,
  DEFAULT_RUNTIME_URL,
  DEFAULT_STREAM_TAIL_CHARS,
  DEFAULT_TIMEOUT_MS,
  type AutoApprovalConfig,
  type AutoUnresolved,
  type FailMode,
  type GuardrailsOptions,
  type RuntimeOptions,
} from "./config.js"
import { LLM_PROTOCOL, RESPONSE_PROTOCOL, requestBody, ResponseAccumulator, TailGate } from "./llm-wire.js"
import { hostAgentId, osUser } from "./platform.js"
import { INTEGRATION, OgrClient, type WireEvent, type WireFinding, type WireVerdict } from "./wire.js"

/** Cordis plugin name; the `id:` in `cordis.yml` is the deployment's own label. */
export const name = "openguardrails"

/** Settings namespace: the "openguardrails" card in the dsh Settings page. */
export const OGR_SETTINGS_NAMESPACE = settingsNamespace("openguardrails")

/** What kind of agent this integration instruments (`agent_type` claim). */
const AGENT_TYPE = "dsh"

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
    z.const("open").description("proceed loudly when the runtime cannot answer — the spec's default"),
    z.const("closed").description("treat \"could not look\" as block"),
  ]).default("open")
    .description("Degraded-mode posture (specification/degraded-mode.md)"),
  timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS)
    .description("Per-call evaluate budget in milliseconds"),
  streamTailChars: z.number().default(DEFAULT_STREAM_TAIL_CHARS)
    .description("Trailing characters of a streamed answer withheld until the step/response verdict"),
  heartbeatS: z.number().default(DEFAULT_HEARTBEAT_S)
    .description("Heartbeat cadence in seconds (build id + degraded-mode counters)"),
  auto: AutoSchema.description("Auto mode: answer approval asks with the step verdict for auto-preset sessions"),
})

/** Bound on the per-call verdict table; released on `tools/result`, capped as a backstop. */
const CALLS_MAX = 4096

/** What the step verdict said about one tool call. */
type CallVerdict = { allow: true } | { allow: false; reason: string }

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
  const tailChars = config.streamTailChars ?? DEFAULT_STREAM_TAIL_CHARS

  // ---- the runtime connection: Settings → cordis config → env → default ----
  const runtimeDefaults: RuntimeOptions = {
    url: config.runtime?.url || process.env.OGR_RUNTIME_URL || DEFAULT_RUNTIME_URL,
    apiKey: config.runtime?.apiKey || process.env.OGR_API_KEY || "",
    workspace: config.runtime?.workspace || process.env.OGR_AGENT_WORKSPACE || "",
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

  /**
   * The identity four-tuple every event carries — ALL four, always, read live
   * so a Settings edit lands immediately. `""` is the explicit "no
   * assertion", never an omission: v0.8 makes every integrator answer the
   * identity question, and the runtime's API-key floor catches what stays
   * empty. `agent_user` defaults to the OS account because a local
   * single-user harness genuinely knows it; workspace stays `""` unless the
   * deployment names one.
   */
  const identity = (): Pick<
    WireEvent,
    "agent_id" | "agent_type" | "agent_workspace" | "agent_user"
  > => {
    const s = runtimeSettings()
    return {
      agent_id: agentId,
      agent_type: AGENT_TYPE,
      agent_workspace: s.workspace || "",
      agent_user: s.user || accountUser || "",
    }
  }

  // ---- degraded-mode counters, reported on the heartbeat -------------------
  //
  // v0.8 has no replay channel: an event unobserved during an outage is a
  // lost observation, and these counters are what keep the gap visible
  // instead of silent (degraded-mode spec, "loud signaling").
  const counters = { events_sent: 0, evaluate_errors: 0, unresolved_spans: 0 }

  /** One evaluate, counted. A `null` verdict is the caller's fail-mode decision. */
  const judge = async (event: WireEvent): Promise<WireVerdict | null> => {
    counters.events_sent += 1
    const verdict = await client.evaluate(event)
    if (!verdict) counters.evaluate_errors += 1
    return verdict
  }

  // ---- per-call verdicts ---------------------------------------------------
  const callVerdicts = new Map<string, CallVerdict>()

  function rememberCall(callId: string, verdict: CallVerdict): void {
    if (callVerdicts.size >= CALLS_MAX) {
      const oldest = callVerdicts.keys().next()
      if (!oldest.done) callVerdicts.delete(oldest.value)
    }
    callVerdicts.set(callId, verdict)
  }

  /**
   * The chunk a blocked step yields instead of (the rest of) the model's
   * answer. `error` is the honest finish kind: the step did not stop because
   * the model stopped, and the loop's own error handling is what should see
   * it — the response never completes, so nothing downstream acts on it.
   */
  const blockedChunk = (detail: string): StreamChunk => ({
    type: "finish",
    reason: {
      kind: "error",
      failure: { message: `[OpenGuardrails] ${detail}`, code: "ogr_blocked" },
    },
  })

  /** Redaction spans this integration cannot apply — warned once, counted always. */
  let warnedSpans = false
  const noteSpans = (verdict: WireVerdict): void => {
    const spans = verdict.modifications?.spans?.length ?? 0
    if (spans === 0) return
    counters.unresolved_spans += spans
    if (!warnedSpans) {
      // Applying spans would mean splicing dsh's own message objects from
      // wire paths — not implemented yet. Stated ONCE, in the log and the
      // README, rather than silently: the runtime's copy is masked either
      // way; what is not masked is what this process handles locally.
      warnedSpans = true
      warn("the verdict carried redaction spans, which this integration cannot apply yet — content passed unredacted")
    }
  }

  // ---- recipe steps 1–4: the two halves of every model call ----------------
  let warnedNoRuntime = false
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

      // One fresh id binds this call's two events; a local variable IS the
      // bookkeeping — v0.8 left the producer nothing else to track.
      const stepId = randomUUID()

      // -- step/request: judged before the model sees it --
      const reqVerdict = await judge({
        kind: "step/request",
        step_id: stepId,
        ...identity(),
        llm_protocol: LLM_PROTOCOL,
        payload: requestBody(options),
      })
      if (!reqVerdict) {
        if (failMode === "closed") {
          yield blockedChunk("this model call could not be judged and the deployment is fail-closed")
          return
        }
        warn("step/request got no verdict — proceeding (fail-open)")
      } else {
        if (reqVerdict.decision === "block") {
          yield blockedChunk(`this model call was blocked: ${brief(reqVerdict)}`)
          return
        }
        if (failMode === "closed" && (reqVerdict.unjudged?.length ?? 0) > 0) {
          yield blockedChunk(
            `parts of this model call went unjudged (${reqVerdict.unjudged!.join(", ")}) and the deployment is fail-closed`,
          )
          return
        }
        noteSpans(reqVerdict)
      }

      // -- the model call, streamed through the tail gate --
      //
      // Chunks are forwarded as they arrive; the final `tailChars` characters
      // stay held. That is the v0.8 enforcement point for streams: the
      // verdict decides the TAIL's fate, tool calls complete only at stream
      // end, and the `finish` chunk is never released early — so nothing is
      // acted on before the verdict, while the user still sees the answer
      // stream in.
      const accumulator = new ResponseAccumulator(options.model)
      const gate = new TailGate(tailChars)
      for await (const chunk of next()) {
        accumulator.push(chunk)
        yield* gate.feed(chunk)
      }

      // An aborted or empty stream has no complete answer to judge.
      if (!accumulator.complete || accumulator.empty) {
        yield* gate.flush()
        return
      }

      // -- step/response: the whole reassembled answer, judged once --
      const resVerdict = await judge({
        kind: "step/response",
        step_id: stepId,
        ...identity(),
        llm_protocol: RESPONSE_PROTOCOL,
        payload: accumulator.body(),
      })
      const calls = accumulator.toolCalls

      if (!resVerdict) {
        if (failMode === "closed") {
          yield blockedChunk("the model's answer could not be judged and the deployment is fail-closed")
          return
        }
        warn("step/response got no verdict — releasing the answer (fail-open); its tool calls carry no verdict")
        yield* gate.flush()
        return
      }

      if (failMode === "closed" && (resVerdict.unjudged?.length ?? 0) > 0) {
        yield blockedChunk(
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
          yield* gate.flush()
          return
        }
        // The held tail is dropped and the stream ends in an error finish:
        // the response never completes and no tool call runs.
        yield blockedChunk(`the model's answer was blocked: ${brief(resVerdict)}`)
        return
      }

      // allow — release the tail; every call in this step is cleared.
      noteSpans(resVerdict)
      for (const call of calls) rememberCall(call.id, { allow: true })
      yield* gate.flush()
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
  // the NEXT step/request, where they travel (recipe step 4). The
  // post-execute waterfall is left to other policy layers.

  // ---- recipe step 5: the heartbeat ----------------------------------------
  //
  // Liveness over the authenticated channel — one beat on connect (a
  // heartbeat registers a live-but-idle agent before its first event) and
  // one per interval after that. The build id and the degraded-mode counters
  // travel here and nowhere else; the timer is unref'd so it never keeps the
  // process alive, and disposed with the plugin.
  const heartbeatS = config.heartbeatS ?? DEFAULT_HEARTBEAT_S
  ctx.effect(() => {
    const beat = (): void => {
      if (!client.enabled) return
      void client.heartbeat({
        integration: INTEGRATION,
        agent_id: agentId,
        interval_s: heartbeatS,
        counters: { ...counters },
      })
    }
    beat()
    const timer = setInterval(beat, heartbeatS * 1000)
    timer.unref?.()
    return () => clearInterval(timer)
  }, "openguardrails: heartbeat")

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
  DEFAULT_HEARTBEAT_S,
  DEFAULT_RUNTIME_URL,
  DEFAULT_STREAM_TAIL_CHARS,
  DEFAULT_TIMEOUT_MS,
} from "./config.js"
export type {
  AutoApprovalConfig,
  AutoUnresolved,
  FailMode,
  GuardrailsOptions,
  RuntimeOptions,
} from "./config.js"
export type { WireEvent, WireFinding, WireHeartbeat, WireVerdict } from "./wire.js"
