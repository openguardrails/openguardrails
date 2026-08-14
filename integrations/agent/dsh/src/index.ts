/**
 * @openguardrails/dsh-auto-mode
 *
 * Auto mode for DeepSeek Harness (dsh): an `auto-mode` entry in the chat client's
 * Permissions selector whose approval prompts are answered by OpenGuardrails
 * (OGR) policy instead of a human — built on the full OGR guard engine, as an
 * ordinary Cordis plugin on dsh's documented interception points. No core
 * changes, no external hook protocol.
 *
 * It turns harness events into OGR `GuardEvent`s, runs them through a
 * `Runtime` built from the deployment's own guardrails policy (text/regex
 * rules, plus optionally its own model as an LLM judge), and maps the
 * `Verdict` onto the pipeline's typed decisions:
 *
 *   tools/pre-execute   allow | modify | redact → next()   (delegate)
 *   (invocation)        block                   → { kind: 'deny' }
 *                       require_approval        → { kind: 'ask' }  (human gate
 *                                                  via ctx.approval; a
 *                                                  deployment without an
 *                                                  approval service denies)
 *
 *   tools/post-execute  allow | modify | redact → the downstream decision
 *   (invocation)        block | require_approval → { kind: 'block', feedback }
 *
 *   ctx.tools.guard()   monotonic re-assertion of a block, and — under
 *                       `failClosed` — denial of any call that reached the
 *                       guard with no OGR verdict at all.
 *
 * This is a restrict-only guard: it can stop a would-run call or a
 * would-be-returned result, never loosen one. Enforcement and the human gate
 * stay privilege-separated: the plugin decides, the user approves through
 * `ctx.approval`, the registry enforces.
 *
 * Auto mode inverts one seam of that separation on explicit user request: for
 * sessions whose permission preset is `auto-mode` (a deployment-configured entry in
 * dsh's Permissions selector), an `approval/request` answerer resolves asks
 * with the OGR verdict instead of a human — allow grants once, block rejects,
 * and anything the runtime cannot decide falls back to the human gate (or is
 * rejected, per config). Sessions on any other preset are never claimed.
 *
 * @module @openguardrails/dsh-auto-mode
 */
import type { Context } from "@deepseek-ai/cordis"
import z from "@deepseek-ai/schemastery"
import type { Agent } from "@deepseek-ai/dsh-agent"
import type { ContentBlock, GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm"
import type {
  PostToolDecision,
  PreToolDecision,
  ToolExecution,
  ToolExecutionResult,
} from "@deepseek-ai/dsh-tools"
// Type-only: declaration-merges the `approval/request` event (and its
// ApprovalRequest/ApprovalOutcome vocabulary) onto the Events table. Never a
// value import — a composition without the approval service simply never
// dispatches the event, and this plugin must load fine there.
import type { ApprovalRequest } from "@deepseek-ai/dsh-user-approval"
import {
  Runtime,
  ConfigRulesDetector,
  LLMJudgeDetector,
  HeuristicBackend,
  severity,
  type Detector,
  type GuardEvent,
  type Provenance,
  type Verdict,
} from "@openguardrails/core"
import {
  DEFAULT_AUTO_PRESET,
  DEFAULT_TAINT_TOOL_PATTERN,
  loadGuardrailsConfig,
  type AutoApprovalConfig,
  type AutoUnresolved,
  type GuardrailsOptions,
  type JudgeConfig,
  type LlmMode,
  type ResolvedConfig,
  type TaintConfig,
} from "./config.js"
import { LLM_PROTOCOL, requestBody, ResponseAccumulator } from "./llm-wire.js"
import { openAICompatibleBackend } from "./own-model.js"
import { hostAgentId, osUser, PlatformReporter } from "./platform.js"

/** Cordis plugin name; the `id:` in `cordis.yml` is the deployment's own label. */
export const name = "openguardrails"

/**
 * The tool registry is the enforcement surface: without it this plugin has
 * nothing to guard, so it waits for the service rather than registering
 * listeners that would silently never fire. Everything else — the agent-loop
 * events, `ctx.approval` — is read opportunistically, so a composition without
 * them still gets tool-call enforcement.
 */
// ⚠️ An ARRAY, and only `tools`. This Cordis's `Inject` object form maps
// service name → intercept config, NOT `{required, optional}` — writing the
// latter silently declares dependencies on services literally named "required"
// and "optional", which never resolve, and the plugin never applies at all.
// There is no optional-inject syntax; `llm` is read opportunistically with
// `ctx.get("llm")` instead, the same way the in-tree hook bridges do it.
export const inject = ["tools"]

/** Plugin config: an OGR policy plus the two axes a deployment tunes. */
export interface Config extends GuardrailsOptions {}

// `baseURL`/`model` are NOT declared required: schemastery resolves a nested
// object even when the parent key is absent, so a required inner field would
// make the optional `judge` block impossible to omit. Both are checked
// together in `loadGuardrailsConfig`, which has to police a judge that came
// from the policy file too.
const JudgeSchema: z<JudgeConfig> = z.object({
  baseURL: z.string().description("OpenAI-compatible base URL, e.g. https://api.deepseek.com/v1"),
  model: z.string().description("Model id used as the guardrail judge"),
  apiKey: z.string().role("secret").description("Bearer token for the judge endpoint"),
  headers: z.dict(z.string()).description("Extra headers sent with every judge request"),
})

const TaintSchema: z<TaintConfig> = z.object({
  toolResults: z.boolean().default(true)
    .description("Mark the calling agent untrusted once it ingests an external tool result"),
  toolResultPattern: z.string().default(DEFAULT_TAINT_TOOL_PATTERN)
    .description("Case-insensitive regex over the tool name selecting untrusted-content tools"),
})

// No observe mode: an agent integration's user is a CONSUMER of the runtime,
// so a switched-on kind is evaluated and enforced. Fire-and-forget observation
// is a gateway posture, not this plugin's.
const LlmModeSchema = z.union([
  z.const("off").description("do not emit"),
  z.const("enforce").description("evaluate, wait for the Verdict, act on it"),
]).default("off")

const AutoSchema: z<AutoApprovalConfig> = z.object({
  enabled: z.boolean().default(true)
    .description("Register the answerer (inert until a session selects the preset)"),
  preset: z.string().default(DEFAULT_AUTO_PRESET)
    .description("Permission-preset name whose sessions this plugin answers for"),
  unresolved: z.union([
    z.const("human").description("delegate to the next answerer — the human gate"),
    z.const("reject").description("refuse the ask (strict headless stance)"),
  ]).default("human")
    .description("What happens to an ask the runtime cannot decide"),
})

export const Config: z<Config> = z.object({
  policy: z.any().description("Inline OGR policy; overrides the workspace file and the default"),
  policyPath: z.string().description("Policy file; relative paths resolve against the session workspace"),
  judge: JudgeSchema.description("Use your own model as an LLM judge (optional)"),
  guardToolResults: z.boolean().default(true).description("Also evaluate tool results, not just tool calls"),
  taint: TaintSchema.description("Per-agent taint propagation from untrusted tool results"),
  auto: AutoSchema.description("Auto mode: answer approval asks with the runtime's verdict for auto-preset sessions"),
  failClosed: z.boolean().default(false)
    .description("Deny any call that reached the monotonic guard without an OGR verdict"),
  llmRequest: LlmModeSchema.description("Emit llm_request (the assembled provider request body) before each model call"),
  llmResponse: LlmModeSchema.description("Emit llm_response (the provider response body) after the model answers"),
})

/**
 * Bound on the pending-verdict table. Every entry is removed on `tools/result`,
 * which the registry fires for every execution including denials, so the cap is
 * a backstop against an unforeseen path, not the normal release mechanism.
 */
const PENDING_MAX = 4096

/**
 * The tighter of the local verdict and the runtime's. A configured runtime
 * participates in every decision — its user is a consumer, not an observer —
 * but restrict-only cuts both ways: remotely it can escalate a decision,
 * never relax one. `null` (not configured, unreachable) leaves the local
 * decision standing.
 */
function tighter(local: Verdict, remote: Verdict | null): Verdict {
  if (!remote || severity(remote.decision) >= severity(local.decision)) return local
  return {
    ...remote,
    reasons: [...remote.reasons, "[runtime] the OpenGuardrails runtime tightened the local decision"],
  }
}

/** One-line human summary of a verdict for a denial reason or corrective feedback. */
function brief(v: Verdict): string {
  const cats = v.categories.map((c) => `${c.id}(${c.score})`).join(", ")
  const why = v.reasons.filter((r) => !r.startsWith("[")).join("; ")
  return [cats, why].filter(Boolean).join(" — ") || v.decision
}

/**
 * The session's effective permission preset: the last `permission/preset`
 * event in the log — the same fold `@deepseek-ai/dsh-permission-presets`
 * ships as `effectivePermissionPreset`, re-folded here over the raw event
 * shape so a deployment without that package costs this plugin neither a
 * dependency nor a load failure. The preset service pins the default preset
 * into every new session as knob events, so a session that never switched
 * still resolves.
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

/** The model-facing text of a tool result, which is what an injection rides in on. */
function resultText(content: readonly ContentBlock[]): string {
  return content
    .map((block) => (block.type === "text" ? block.text : `[${block.type}]`))
    .join("\n")
}

/**
 * Per-agent taint: once an agent ingests untrusted content (a web/fetch/search/
 * browser/MCP tool result), its later tool calls carry `untrusted` provenance
 * so the judge escalates a privileged action that may be injection-influenced.
 *
 * Keyed by the live `Agent` object exactly like dsh's own per-agent guards: the
 * tool registry is context-level and subagents interleave through the same
 * waterfall, so one agent's taint must never leak into another's calls, and
 * object lifetime bounds the entry without a disposal listener.
 */
interface TaintMark {
  sources: Set<string>
  tags: Set<string>
}

class TaintTracker {
  private readonly byAgent = new WeakMap<Agent, TaintMark>()

  mark(agent: Agent | undefined, source: string, tag: string): void {
    if (!agent) return
    const m = this.byAgent.get(agent) ?? { sources: new Set<string>(), tags: new Set<string>() }
    m.sources.add(source)
    m.tags.add(tag)
    this.byAgent.set(agent, m)
  }

  get(agent: Agent | undefined): TaintMark | undefined {
    return agent ? this.byAgent.get(agent) : undefined
  }

  clear(agent: Agent | undefined): void {
    if (agent) this.byAgent.delete(agent)
  }
}

/**
 * Lazily builds and caches one OGR runtime per session workspace. dsh sessions
 * each carry their own `cwd` and one harness process serves many of them, so a
 * workspace-local `.dsh/guardrails.json` has to resolve per call, not once at
 * load. The `Runtime` is also the correlation store for `guardId`, so agents
 * sharing a workspace deliberately share one.
 */
class GuardManager {
  private readonly byWorkspace = new Map<string, { runtime: Runtime; resolved: ResolvedConfig; toolResultRe: RegExp | undefined }>()

  constructor(
    private readonly options: Config,
    private readonly warn: (message: string) => void,
  ) {}

  for(workspaceDir: string | undefined): { runtime: Runtime; resolved: ResolvedConfig; toolResultRe: RegExp | undefined } {
    const key = workspaceDir ?? ""
    const hit = this.byWorkspace.get(key)
    if (hit) return hit

    const resolved = loadGuardrailsConfig(workspaceDir, this.options, this.warn)
    // ConfigRulesDetector enforces the deterministic regex rules; the judge
    // weighs provenance, so an untrusted-derived privileged action escalates.
    // Use the operator's own model when configured, else the deterministic
    // HeuristicBackend — tainting keeps its teeth with no external model.
    const judgeBackend = resolved.judge ? openAICompatibleBackend(resolved.judge) : new HeuristicBackend()
    const detectors: Detector[] = [
      new ConfigRulesDetector(resolved.policy.config_rules ?? {}),
      new LLMJudgeDetector(judgeBackend),
    ]
    let toolResultRe: RegExp | undefined
    if (resolved.taint.toolResults && resolved.taint.toolResultPattern) {
      try {
        toolResultRe = new RegExp(resolved.taint.toolResultPattern, "i")
      } catch (error: unknown) {
        // A bad pattern must not silently disable tainting without a word.
        this.warn(`invalid taint.toolResultPattern: ${String(error)} — tool-result tainting is off for ${key || "the default workspace"}`)
      }
    }
    const entry = { runtime: new Runtime(detectors, resolved.policy), resolved, toolResultRe }
    this.byWorkspace.set(key, entry)
    return entry
  }
}

/**
 * Install the guard's listeners.
 * @param ctx - plugin context; every registration is scoped to it and unwinds
 *   with it, so a hot reload leaves nothing behind.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const warn = (message: string): void => ctx.logger.warn(`openguardrails: ${message}`)
  const guard = new GuardManager(config, warn)
  const taint = new TaintTracker()
  const reporter = new PlatformReporter({ info: (m) => ctx.logger.info(m), warn: (m) => ctx.logger.warn(m) })
  ctx.effect(() => () => void reporter.dispose(), "openguardrails: drain the platform reporter")

  /**
   * Verdicts from `tools/pre-execute`, keyed by the registry's per-execution
   * token, read by the monotonic guard and released on `tools/result`.
   */
  const pending = new Map<symbol, Verdict>()

  /**
   * The payload of each live call, keyed by callId, for the auto-mode
   * approval answerer: an `ApprovalRequest` carries no arguments, so its
   * `callId` is how an ask gets its payload back. Same lifetime and backstop
   * cap as `pending`.
   */
  const records = new Map<string, { name: string; arguments: unknown }>()

  function remember(exec: ToolExecution, verdict: Verdict): void {
    if (pending.size >= PENDING_MAX) {
      const oldest = pending.keys().next()
      if (!oldest.done) pending.delete(oldest.value)
    }
    pending.set(exec.token, verdict)
    if (records.size >= PENDING_MAX) {
      const oldest = records.keys().next()
      if (!oldest.done) records.delete(oldest.value)
    }
    records.set(String(exec.callId), { name: exec.name, arguments: exec.arguments })
  }

  /** The agent's workspace — the `session/new` cwd, not the host process's launch dir. */
  function workspaceOf(exec: ToolExecution): string | undefined {
    return exec.agent?.session.header.cwd
  }

  // One harness process per machine → machine-scoped identity (identity design
  // §7); resolved once, because it is a property of the host, not of the call.
  const agentId = hostAgentId()
  const accountUser = osUser()

  /**
   * The identity five-tuple every event this plugin emits shares:
   * agent_id / agent_type / agent_workspace / agent_owner / agent_user.
   * Workspace is the session's working tree; owner and user are the OS
   * account the harness runs as — the best a local single-user harness can
   * assert, and the runtime clamps every claim to what the attestation
   * supports. Flat identity fields (OGR v0.6).
   */
  function identity(
    exec: ToolExecution,
  ): Pick<GuardEvent, "agentId" | "agentType" | "agentWorkspace" | "agentOwner" | "agentUser" | "attestation" | "sessionId"> {
    const workspace = workspaceOf(exec)
    return {
      agentId,
      agentType: "dsh",
      attestation: "client_key",
      ...workspace ? { agentWorkspace: workspace } : {},
      ...accountUser ? { agentOwner: accountUser, agentUser: accountUser } : {},
      ...exec.agent ? { sessionId: exec.agent.id } : {},
    }
  }

  /**
   * The call's provenance. The model's own request is unverified content; an
   * agent that has ingested an external tool result adds an `untrusted` entry
   * naming the source, which is what makes an injection-influenced privileged
   * action legible to the judge.
   */
  function provenanceFor(agent: Agent | undefined): Provenance[] {
    const provenance: Provenance[] = [{ source: "model", trust: "unverified" }]
    const mark = taint.get(agent)
    if (mark) {
      provenance.push({
        source: [...mark.sources][0] ?? "tainted",
        trust: "untrusted",
        taintTags: [...mark.tags],
      })
    }
    return provenance
  }

  // ---- invocation altitude: every tool call, before it runs ----------------
  //
  // Prepended: `tools/pre-execute` is dsh's reorderable policy layer, and a
  // permissive listener that returns `allow` without delegating short-circuits
  // the waterfall. Running first means OGR sees the call; `failClosed` covers
  // the case where a later-registered prepending listener still preempts it.
  ctx.on("tools/pre-execute", async (exec, next): Promise<PreToolDecision> => {
    const { runtime, resolved } = guard.for(workspaceOf(exec))
    const ev: GuardEvent = {
      kind: "tool_call",
      observationPoint: "invocation",
      ...identity(exec),
      // Guard-context propagation: the call and its result are one logical
      // action, so both events carry the call id and the runtime correlates
      // the two altitudes — a later observation can only tighten the earlier
      // decision, never loosen it. Event identity itself is born at the
      // runtime (OGR v0.6), so this plugin never mints an `eventId`.
      guardId: exec.callId,
      payload: { name: exec.name, arguments: exec.arguments },
      timestamp: new Date().toISOString(),
      provenance: provenanceFor(exec.agent),
    }

    // The configured runtime is evaluated in PARALLEL with the local chain —
    // its user is a consumer, not an observer, so the call goes through
    // /v1/evaluate and the verdict participates: it can tighten the local
    // decision, never loosen it. Unconfigured or unreachable → local stands.
    const remote = reporter.evaluate(ev)
    let verdict: Verdict
    try {
      verdict = await runtime.evaluate(ev)
    } catch (error: unknown) {
      // A detector failure (an unreachable judge endpoint, a malformed rule)
      // must not decide policy by accident. `failClosed` is the deployment's
      // stated posture, so honor it here too.
      warn(`evaluation of ${exec.name} failed: ${String(error)}`)
      if (resolved.failClosed) {
        return { kind: "deny", reason: `[OpenGuardrails] could not evaluate this ${exec.name} call and the deployment is fail-closed` }
      }
      return next()
    }
    verdict = tighter(verdict, await remote)
    remember(exec, verdict)

    if (verdict.decision === "block") {
      return { kind: "deny", reason: `[OpenGuardrails] ${brief(verdict)}` }
    }
    if (verdict.decision === "require_approval") {
      // `ask` resolves through ctx.approval before the monotonic guards; a
      // composition with no approval service turns it into a denial, which is
      // the correct direction for a restrict-only guard.
      return { kind: "ask", reason: `[OpenGuardrails] ${brief(verdict)}` }
    }
    // allow | modify | redact → delegate, so a later policy layer still decides.
    return next()
  }, { prepend: true })

  // ---- monotonic re-assertion ---------------------------------------------
  //
  // A registered guard is the one denial that cannot be reordered away. It
  // repeats an OGR `block` (belt and braces against a pipeline that reached
  // dispatch anyway) and, under `failClosed`, refuses a call that arrived here
  // with no verdict at all — the signature of a waterfall that short-circuited
  // before this plugin ran.
  ctx.tools.guard((exec): string | undefined => {
    const verdict = pending.get(exec.token)
    if (verdict) {
      return verdict.decision === "block" ? `[OpenGuardrails] ${brief(verdict)}` : undefined
    }
    const { resolved } = guard.for(workspaceOf(exec))
    if (!resolved.failClosed) return undefined
    return `[OpenGuardrails] this ${exec.name} call was never evaluated (the pre-execute waterfall short-circuited) and the deployment is fail-closed`
  })

  // ---- the untrusted-content boundary, and the result altitude -------------
  ctx.on("tools/post-execute", async (exec, result, next): Promise<PostToolDecision> => {
    const { runtime, resolved, toolResultRe } = guard.for(workspaceOf(exec))

    // Taint first, so the mark is set before any downstream listener runs and
    // before the NEXT call in this agent's turn is evaluated. A failed fetch
    // produced no content to distrust.
    if (toolResultRe && !result.isError && toolResultRe.test(exec.name)) {
      taint.mark(exec.agent, `tool_result:${exec.name}`, "untrusted_tool_result")
    }

    const downstream = await next()
    if (!resolved.guardToolResults) return downstream
    // Already blocked downstream — nothing left for this plugin to restrict.
    if (downstream.kind === "block") return downstream
    // This plugin already refused the call at the invocation altitude, so the
    // tool body never ran and the "result" is the registry's own denial
    // notice. Re-judging it would only overwrite an accurate denial reason
    // with a vaguer one — and the guard-context correlation guarantees the
    // verdict, being for the same `guardId`, comes back blocked regardless.
    const priorDecision = pending.get(exec.token)?.decision
    if (priorDecision === "block" || priorDecision === "require_approval") return downstream

    // Guard what actually reaches the model: a downstream listener's
    // replacement content when it supplied one, else the dispatch result.
    const content = downstream.content ?? result.content
    const text = resultText(content)
    if (text.length === 0) return downstream

    const ev: GuardEvent = {
      kind: "tool_result",
      observationPoint: "invocation",
      ...identity(exec),
      guardId: exec.callId,
      // The `{ name, result }` shape the GuardEvent spec gives `tool_result`,
      // plus the status field the other OGR agent integrations carry so a
      // failed call reads as an error rather than a generic result.
      payload: { name: exec.name, result: text, status: result.isError ? "error" : "ok" },
      timestamp: new Date().toISOString(),
      // The result is content this agent did not author. Whether it is
      // *externally* sourced is the taint pattern's judgement, above; every
      // result is at best unverified.
      provenance: [{
        source: "tool_result",
        trust: toolResultRe?.test(exec.name) ? "untrusted" : "unverified",
        ref: exec.name,
      }],
    }

    const remote = reporter.evaluate(ev)
    let verdict: Verdict
    try {
      verdict = await runtime.evaluate(ev)
    } catch (error: unknown) {
      warn(`evaluation of the ${exec.name} result failed: ${String(error)}`)
      return downstream
    }
    verdict = tighter(verdict, await remote)

    // There is no human gate after dispatch — the side effect already
    // happened — so `require_approval` at this altitude blocks the result from
    // reaching the model and says why.
    if (verdict.decision === "block" || verdict.decision === "require_approval") {
      const detail = verdict.decision === "require_approval"
        ? `${brief(verdict)} (this result needed approval, which cannot be asked for after the tool ran)`
        : brief(verdict)
      return {
        kind: "block",
        feedback: [{
          type: "text",
          text: `[OpenGuardrails] the result of this ${exec.name} call was withheld: ${detail}`,
        }],
        ...downstream.additionalContexts ? { additionalContexts: downstream.additionalContexts } : {},
      }
    }
    return downstream
  })

  // Release the pending verdict on the registry's authoritative final outcome,
  // which fires for every execution — dispatched, denied, or errored.
  ctx.on("tools/result", (exec: Readonly<ToolExecution>, _result: Readonly<ToolExecutionResult>) => {
    pending.delete(exec.token)
    records.delete(String(exec.callId))
  })

  // Taint is agent-scoped and in-memory. A cleared session starts a fresh
  // history, so its taint goes with it; `resume` and `compact` keep the
  // ingested content in derived history and must keep the mark.
  ctx.on("agent/session-start", ({ agent, source }) => {
    if (source === "startup" || source === "clear") taint.clear(agent)
  })

  // ---- auto mode: the runtime answers the approval seam --------------------
  //
  // dsh's permission presets bundle sandbox mode + approval policy, and the
  // chat client renders the preset table as its Permissions selector. A
  // deployment that adds an `auto-mode` preset (workspace-write + ask — README has
  // the cordis.yml snippet) gets its meaning from this answerer: for sessions
  // on that preset, asks that would reach a human — a sandbox-escalation
  // retry, a tool whose policy layer said `ask` — resolve with the OGR
  // verdict instead. Same claim-or-delegate shape as dsh's own ACP bridge,
  // prepended so it runs before the chat UI's answerer; every other session
  // delegates untouched, so an unloaded plugin degrades the preset to plain
  // workspace-write + human asks, which is the fail-safe direction.
  const auto = config.auto ?? {}
  if (auto.enabled !== false) {
    const autoPreset = auto.preset ?? DEFAULT_AUTO_PRESET
    const unresolved: AutoUnresolved = auto.unresolved ?? "human"

    ctx.on("approval/request", async (req: ApprovalRequest, next) => {
      if (effectivePreset(req.agent.session.events) !== autoPreset) return next()

      // "Cannot decide" is one disposal, three triggers: a require_approval
      // verdict (including the very verdict whose `ask` raised this request —
      // asking the runtime again is circular, so it stays undecided), an ask
      // with no correlated call, and a failed evaluation. `human` delegates
      // onward to the human gate; `reject` is the restrict-only hard stance.
      const undecided = () => (unresolved === "reject" ? Promise.resolve("rejected" as const) : next())

      // An ApprovalRequest carries no arguments — `callId` links the ask back
      // to the call this plugin already evaluated. No record means OGR never
      // saw what is being approved, and a guard does not grant what it
      // cannot see.
      const record = req.callId === undefined ? undefined : records.get(String(req.callId))
      if (!record) return undecided()

      const { runtime } = guard.for(req.agent.session.header.cwd)
      // Re-evaluate rather than replay the stored verdict: provenance is
      // fresh (the agent may have ingested untrusted content since the call
      // was first judged), the ask's own reason travels in the payload for a
      // judge to weigh, and guardId correlation guarantees the answer can
      // only tighten the earlier decision, never loosen it.
      const workspace = req.agent.session.header.cwd
      const ev: GuardEvent = {
        kind: "tool_call",
        observationPoint: "invocation",
        agentId,
        agentType: "dsh",
        attestation: "client_key",
        sessionId: req.agent.id,
        // The same identity five-tuple as every other event this plugin emits.
        ...workspace ? { agentWorkspace: workspace } : {},
        ...accountUser ? { agentOwner: accountUser, agentUser: accountUser } : {},
        guardId: req.callId,
        payload: {
          name: record.name,
          arguments: record.arguments,
          approval: { tool: req.toolName, ...req.reason !== undefined ? { reason: req.reason } : {} },
        },
        timestamp: new Date().toISOString(),
        provenance: provenanceFor(req.agent),
      }

      const remote = reporter.evaluate(ev)
      let verdict: Verdict
      try {
        verdict = await runtime.evaluate(ev)
      } catch (error: unknown) {
        warn(`auto mode could not evaluate the ${req.toolName} approval ask: ${String(error)}`)
        return undecided()
      }
      verdict = tighter(verdict, await remote)

      if (verdict.decision === "block") return "rejected"
      if (verdict.decision === "require_approval") return undecided()
      return "allowed-once"
    }, { prepend: true })
  }

  // ---- conversation altitude: the OGR v0.6 developer path -----------------
  installLlmGuard(ctx, config, { agentId, reporter, warn })
}

/**
 * The `llm_request` / `llm_response` half: forward the raw model traffic and
 * act on the verdicts.
 *
 * This is the v0.6 developer path, and it is deliberately a different shape
 * from the tool-call half above. There, the plugin decomposes a dsh event into
 * a `tool_call` GuardEvent and a LOCAL `Runtime` judges it. Here it decomposes
 * nothing: the request body and the response body go to the runtime, which
 * derives the new user words, the tool outcomes being fed back, the model's
 * prose, every tool call it asks for, and the declared tool inventory. That
 * classification was every PEP's private burden through v0.5; it is not this
 * plugin's job any more.
 *
 * The consequence is that these two kinds have NO local fallback — the
 * bundled detectors judge commands, not conversations. Both modes therefore
 * require `OGR_RUNTIME_URL` + `OGR_API_KEY`, and both say so loudly when they
 * are switched on without one.
 */
function installLlmGuard(
  ctx: Context,
  config: Config,
  deps: { agentId: string; reporter: PlatformReporter; warn: (message: string) => void },
): void {
  const requestMode: LlmMode = config.llmRequest ?? "off"
  const responseMode: LlmMode = config.llmResponse ?? "off"
  if (requestMode === "off" && responseMode === "off") return

  const { agentId, reporter, warn } = deps
  if (!reporter.enabled) {
    warn(
      "llmRequest/llmResponse need a runtime (set OGR_RUNTIME_URL and OGR_API_KEY) — "
      + "these kinds carry the raw provider body for the RUNTIME to classify, and there is no local fallback. Not registering.",
    )
    return
  }
  // Deliberately NO "is the llm service loaded?" check here. `apply` runs as
  // soon as `tools` resolves, which in a normal cordis.yml is before the LLM
  // adapter has finished loading — an eager check reports a missing service
  // that arrives milliseconds later. Registering the listener unconditionally
  // is both correct and harmless: without an LLM service nothing dispatches
  // `llm/stream`, and every real dsh deployment has one (it is the spine).

  const accountUser = osUser()

  /** One conversation-altitude event, fully typed (no `as GuardEvent` escape). */
  const conversationEvent = (
    kind: "llm_request" | "llm_response",
    options: GenerateOptions,
    payload: Record<string, unknown>,
    source: string,
  ): GuardEvent => ({
    kind,
    observationPoint: "conversation",
    agentId,
    agentType: "dsh",
    attestation: "client_key",
    // The identity five-tuple, minus workspace: a model call belongs to the
    // harness, not to one working tree.
    ...accountUser ? { agentOwner: accountUser, agentUser: accountUser } : {},
    llmProtocol: LLM_PROTOCOL,
    payload,
    timestamp: new Date().toISOString(),
    provenance: [{ source, trust: "unverified" }],
    ...options.sessionId ? { sessionId: String(options.sessionId) } : {},
  })

  /**
   * The chunk a blocked step yields instead of the model's answer. `error` is
   * the honest finish kind: the step did not stop because the model stopped,
   * and the loop's own error handling is what should see it.
   */
  const blockedChunk = (verdict: Verdict, what: string): StreamChunk => ({
    type: "finish",
    reason: {
      kind: "error",
      failure: {
        message: `[OpenGuardrails] ${what} blocked: ${brief(verdict)}`,
        code: "ogr_blocked",
      },
    },
  })

  ctx.on("llm/stream", (options, next): AsyncIterable<StreamChunk> => {
    // An auxiliary call (compaction, session titling) is machinery, not the
    // agent's conversation with the user; judging it would bill a round trip
    // for a summary of history the runtime has already seen.
    if (options.purpose !== undefined) return next()

    return (async function* guarded(): AsyncIterable<StreamChunk> {
      if (requestMode === "enforce") {
        // The assembled request is exactly where trusted and untrusted content
        // have already been mixed — that is what the runtime reads.
        const ev = conversationEvent("llm_request", options, requestBody(options), "model_input")
        const verdict = await reporter.evaluate(ev)
        // A missing verdict (runtime down, timeout) is NOT an allow, but it
        // is not a block either: this altitude has no human gate, and
        // failing a whole turn closed on an unreachable runtime would take
        // the agent down with it. Say so, and let the tool-call altitude —
        // which does fail closed — carry the enforcement.
        if (!verdict) {
          warn("llm_request got no verdict — proceeding; enforcement falls back to the tool-call altitude")
        } else if (verdict.decision === "block" || verdict.decision === "require_approval") {
          // `require_approval` cannot be answered here: `ctx.approval` keys a
          // question to an agent and a tool, and a model call is neither.
          // Restrict-only means the safe direction is to stop the call.
          yield blockedChunk(verdict, "this model call was")
          return
        }
      }

      if (responseMode === "off") {
        yield* next()
        return
      }

      // `enforce` buffers: "BEFORE the agent acts on it" is literally true
      // only if no chunk escapes while the verdict is in flight.
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

      const ev = conversationEvent("llm_response", options, accumulator.body(), "model")
      const verdict = await reporter.evaluate(ev)
      if (verdict && (verdict.decision === "block" || verdict.decision === "require_approval")) {
        yield blockedChunk(verdict, "the model's answer was")
        return
      }
      if (!verdict) warn("llm_response got no verdict — releasing the answer")
      yield* buffered
    })()
  })
}

export default { name, inject, Config, apply }

export {
  DEFAULT_AUTO_PRESET,
  DEFAULT_POLICY,
  DEFAULT_TAINT_TOOL_PATTERN,
  WORKSPACE_POLICY_PATH,
  loadGuardrailsConfig,
} from "./config.js"
export type {
  AutoApprovalConfig,
  AutoUnresolved,
  GuardrailsOptions,
  JudgeConfig,
  TaintConfig,
  ResolvedConfig,
} from "./config.js"
