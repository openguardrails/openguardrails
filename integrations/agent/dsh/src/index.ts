/**
 * openguardrails-instrumentation-dsh
 *
 * A DeepSeek Harness (dsh) plugin that guards an agent through the
 * OpenGuardrails (OGR) protocol. It is an ordinary Cordis plugin on dsh's
 * documented interception points — no core changes, no external hook protocol.
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
 * @module openguardrails-instrumentation-dsh
 */
import type { Context } from "@deepseek-ai/cordis"
import z from "@deepseek-ai/schemastery"
import type { Agent } from "@deepseek-ai/dsh-agent"
import type { ContentBlock } from "@deepseek-ai/dsh-llm"
import type {
  PostToolDecision,
  PreToolDecision,
  ToolExecution,
  ToolExecutionResult,
} from "@deepseek-ai/dsh-tools"
import {
  Runtime,
  ConfigRulesDetector,
  LLMJudgeDetector,
  HeuristicBackend,
  type Detector,
  type GuardEvent,
  type Provenance,
  type Verdict,
} from "@openguardrails/core"
import {
  DEFAULT_TAINT_TOOL_PATTERN,
  loadGuardrailsConfig,
  type GuardrailsOptions,
  type JudgeConfig,
  type ResolvedConfig,
  type TaintConfig,
} from "./config.js"
import { openAICompatibleBackend } from "./own-model.js"
import { hostAgentId, PlatformReporter } from "./platform.js"

/** Cordis plugin name; the `id:` in `cordis.yml` is the deployment's own label. */
export const name = "openguardrails"

/**
 * The tool registry is the enforcement surface: without it this plugin has
 * nothing to guard, so it waits for the service rather than registering
 * listeners that would silently never fire. Everything else — the agent-loop
 * events, `ctx.approval` — is read opportunistically, so a composition without
 * them still gets tool-call enforcement.
 */
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

export const Config: z<Config> = z.object({
  policy: z.any().description("Inline OGR policy; overrides the workspace file and the default"),
  policyPath: z.string().description("Policy file; relative paths resolve against the session workspace"),
  judge: JudgeSchema.description("Use your own model as an LLM judge (optional)"),
  guardToolResults: z.boolean().default(true).description("Also evaluate tool results, not just tool calls"),
  taint: TaintSchema.description("Per-agent taint propagation from untrusted tool results"),
  failClosed: z.boolean().default(false)
    .description("Deny any call that reached the monotonic guard without an OGR verdict"),
})

/**
 * Bound on the pending-verdict table. Every entry is removed on `tools/result`,
 * which the registry fires for every execution including denials, so the cap is
 * a backstop against an unforeseen path, not the normal release mechanism.
 */
const PENDING_MAX = 4096

/** One-line human summary of a verdict for a denial reason or corrective feedback. */
function brief(v: Verdict): string {
  const cats = v.categories.map((c) => `${c.id}(${c.score})`).join(", ")
  const why = v.reasons.filter((r) => !r.startsWith("[")).join("; ")
  return [cats, why].filter(Boolean).join(" — ") || v.decision
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

  function remember(exec: ToolExecution, verdict: Verdict): void {
    if (pending.size >= PENDING_MAX) {
      const oldest = pending.keys().next()
      if (!oldest.done) pending.delete(oldest.value)
    }
    pending.set(exec.token, verdict)
  }

  /** The agent's workspace — the `session/new` cwd, not the host process's launch dir. */
  function workspaceOf(exec: ToolExecution): string | undefined {
    return exec.agent?.session.header.cwd
  }

  // One harness process per machine → machine-scoped identity (identity design
  // §7); resolved once, because it is a property of the host, not of the call.
  const agentId = hostAgentId()

  /** The identity fields every event this plugin emits shares. */
  function identity(exec: ToolExecution): Pick<GuardEvent, "agentId" | "agentType" | "attestation" | "sessionId"> {
    return {
      // The runtime clamps the attestation claim to this key's enrollment
      // scope. Flat identity fields (OGR v0.6).
      agentId,
      agentType: "dsh",
      attestation: "client_key",
      ...exec.agent ? { sessionId: exec.agent.id } : {},
    }
  }

  /**
   * The call's provenance. The model's own request is unverified content; an
   * agent that has ingested an external tool result adds an `untrusted` entry
   * naming the source, which is what makes an injection-influenced privileged
   * action legible to the judge.
   */
  function provenanceOf(exec: ToolExecution): Provenance[] {
    const provenance: Provenance[] = [{ source: "model", trust: "unverified" }]
    const mark = taint.get(exec.agent)
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
      provenance: provenanceOf(exec),
    }

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
    remember(exec, verdict)
    reporter.report(ev) // fire-and-forget platform observability

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

    let verdict: Verdict
    try {
      verdict = await runtime.evaluate(ev)
    } catch (error: unknown) {
      warn(`evaluation of the ${exec.name} result failed: ${String(error)}`)
      return downstream
    }
    reporter.report(ev)

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
  })

  // Taint is agent-scoped and in-memory. A cleared session starts a fresh
  // history, so its taint goes with it; `resume` and `compact` keep the
  // ingested content in derived history and must keep the mark.
  ctx.on("agent/session-start", ({ agent, source }) => {
    if (source === "startup" || source === "clear") taint.clear(agent)
  })
}

export default { name, inject, Config, apply }

export {
  DEFAULT_POLICY,
  DEFAULT_TAINT_TOOL_PATTERN,
  WORKSPACE_POLICY_PATH,
  loadGuardrailsConfig,
} from "./config.js"
export type { GuardrailsOptions, JudgeConfig, TaintConfig, ResolvedConfig } from "./config.js"
