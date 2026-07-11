/**
 * openguardrails-instrumentation-openclaw
 *
 * An OpenClaw plugin that guards an assistant through the OpenGuardrails (OGR)
 * protocol — the multi-channel counterpart of
 * `openguardrails-instrumentation-opencode`.
 *
 * It registers in-process plugin hooks, turns each event into an OGR
 * `GuardEvent`, runs it through a `Runtime` built from the assistant's own
 * guardrails policy (text/regex rules, plus optionally its own model as an LLM
 * judge), and enforces the `Verdict`:
 *
 *   before_tool_call   allow | modify | redact → proceed
 *                      block                   → { block }
 *                      require_approval        → { requireApproval } (human gate)
 *
 *   message_sending    allow | modify | redact → deliver
 *                      block | require_approval → { cancel } (outbound guard)
 *
 * No OpenClaw core changes required. This is a "restrict-only" guard: it can
 * stop a would-run tool call or a would-send message, never loosen one. The
 * human-confirm gate (`requireApproval`) and enforcement stay privilege-
 * separated: the plugin decides, the user approves, the host enforces.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry"
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
import { loadGuardrailsConfig, type GuardrailsOptions, type TaintConfig } from "./config.js"
import { openAICompatibleBackend } from "./own-model.js"

let seq = 0
function id(prefix: string): string {
  seq += 1
  const rand = globalThis.crypto?.randomUUID?.().slice(0, 8) ?? seq.toString(36).padStart(8, "0")
  return `${prefix}-${seq.toString(36)}-${rand}`
}

function brief(v: Verdict): string {
  const cats = v.categories.map((c) => `${c.id}(${c.score})`).join(", ")
  const why = v.reasons.filter((r) => !r.startsWith("[")).join("; ")
  return [cats, why].filter(Boolean).join(" — ") || v.decision
}

/**
 * Per-session taint: once a session ingests untrusted content (an inbound
 * channel message, or a tool result from a web/fetch/search/browser/MCP tool),
 * later tool calls in that session get `untrusted` provenance. Session-scoped;
 * cleared on `session_end`/`before_reset`.
 */
interface TaintMark {
  sources: Set<string>
  tags: Set<string>
}

class TaintTracker {
  private readonly bySession = new Map<string, TaintMark>()

  mark(sessionKey: string | undefined, source: string, tag: string): void {
    if (!sessionKey) return
    const m = this.bySession.get(sessionKey) ?? { sources: new Set<string>(), tags: new Set<string>() }
    m.sources.add(source)
    m.tags.add(tag)
    this.bySession.set(sessionKey, m)
  }

  get(sessionKey: string | undefined): TaintMark | undefined {
    return sessionKey ? this.bySession.get(sessionKey) : undefined
  }

  clear(sessionKey: string | undefined): void {
    if (sessionKey) this.bySession.delete(sessionKey)
  }
}

/**
 * Lazily builds and caches the OGR runtime. The policy file lives in the
 * workspace, which is only known at `gateway_start`; tool/message hooks build
 * on first use if startup has not populated it yet.
 */
class GuardManager {
  private runtime: Runtime | undefined
  private guardMessages = true
  private taintCfg: Required<TaintConfig> = {
    inboundMessages: true,
    toolResults: true,
    toolResultPattern: "",
  }
  private toolResultRe: RegExp | undefined
  private workspaceDir: string | undefined
  private options: GuardrailsOptions | undefined

  configure(workspaceDir: string | undefined, options: GuardrailsOptions | undefined): void {
    this.workspaceDir = workspaceDir
    this.options = options
    this.runtime = undefined // force rebuild with the new workspace/options
    this.ensure()
  }

  private ensure(): Runtime {
    if (this.runtime) return this.runtime
    const { policy, judge, guardMessages, taint } = loadGuardrailsConfig(this.workspaceDir, this.options)
    // ConfigRulesDetector enforces deterministic regex rules; the judge weighs
    // provenance (taint) so an untrusted-derived privileged action escalates.
    // Use the operator's own model when configured, else the deterministic
    // HeuristicBackend so tainting has teeth with no external model.
    const judgeBackend = judge ? openAICompatibleBackend(judge) : new HeuristicBackend()
    const detectors: Detector[] = [
      new ConfigRulesDetector(policy.config_rules ?? {}),
      new LLMJudgeDetector(judgeBackend),
    ]
    this.guardMessages = guardMessages
    this.taintCfg = taint
    this.toolResultRe = taint.toolResultPattern ? new RegExp(taint.toolResultPattern, "i") : undefined
    this.runtime = new Runtime(detectors, policy)
    return this.runtime
  }

  get messagesEnabled(): boolean {
    this.ensure()
    return this.guardMessages
  }

  get taint(): Required<TaintConfig> {
    this.ensure()
    return this.taintCfg
  }

  /** Is this tool one whose result carries untrusted external content? */
  isExternalContentTool(toolName: string): boolean {
    this.ensure()
    return this.toolResultRe?.test(toolName) ?? false
  }

  evaluate(ev: GuardEvent): Promise<Verdict> {
    return this.ensure().evaluate(ev)
  }
}

/** Best-effort read of this plugin's config out of the OpenClaw config tree. */
function readOptions(config: unknown): GuardrailsOptions | undefined {
  const entries = (config as { plugins?: { entries?: Record<string, { config?: unknown }> } })?.plugins?.entries
  return entries?.["openguardrails"]?.config as GuardrailsOptions | undefined
}

// Annotate via the importable `definePluginEntry` symbol so the emitted
// declaration does not inline OpenClaw's non-exported `DefinedPluginEntry`
// type (TS2742 portability).
const plugin: ReturnType<typeof definePluginEntry> = definePluginEntry({
  id: "openguardrails",
  name: "OpenGuardrails",
  description:
    "Enforce the OpenGuardrails (OGR) protocol on tool calls and channel traffic — block, rewrite, or require human approval under a policy you own.",
  register(api) {
    const guard = new GuardManager()
    const taint = new TaintTracker()

    // Resolve the workspace-scoped policy once the Gateway is up.
    api.on("gateway_start", (_event, ctx) => {
      const c = ctx as { workspaceDir?: string; config?: unknown }
      guard.configure(c.workspaceDir, readOptions(c.config))
    })

    // Channel-inbound tainting: inbound channel messages are untrusted content.
    api.on("message_received", (event, ctx) => {
      if (!guard.taint.inboundMessages) return
      const c = ctx as { sessionKey?: string; messageProvider?: string }
      const e = event as { messageProvider?: string }
      const provider = c.messageProvider ?? e.messageProvider ?? "channel"
      taint.mark(c.sessionKey, `channel:${provider}`, "channel_inbound")
    })

    // Channel-inbound tainting: results of web/fetch/search/browser/MCP tools
    // are untrusted external content (the indirect prompt-injection vector).
    api.on("after_tool_call", (event, ctx) => {
      if (!guard.taint.toolResults) return
      const e = event as { toolName: string; error?: string }
      if (e.error) return // a failed fetch produced no content to trust-taint
      if (!guard.isExternalContentTool(e.toolName)) return
      const c = ctx as { sessionKey?: string }
      taint.mark(c.sessionKey, `tool_result:${e.toolName}`, "untrusted_tool_result")
    })

    // Taint is session-scoped; drop it when the session ends or resets.
    api.on("session_end", (_event, ctx) => taint.clear((ctx as { sessionKey?: string }).sessionKey))
    api.on("before_reset", (_event, ctx) => taint.clear((ctx as { sessionKey?: string }).sessionKey))

    // Core enforcement: every tool call, before it runs.
    api.on(
      "before_tool_call",
      async (event, ctx) => {
        const c = ctx as { agentId?: string; sessionKey?: string; channelId?: string }
        // The principal is trusted, but if the session has ingested untrusted
        // content (inbound message / web / mcp result), this action may be
        // injection-influenced — flag it untrusted so the judge escalates.
        const provenance: Provenance[] = [{ source: "user", trust: "trusted" }]
        const mark = taint.get(c.sessionKey)
        if (mark) {
          provenance.push({
            source: [...mark.sources][0] ?? "tainted",
            trust: "untrusted",
            taintTags: [...mark.tags],
          })
        }
        const ev: GuardEvent = {
          kind: "tool_call",
          observationPoint: "agent_hook",
          subject: {
            agent_id: c.agentId ?? "openclaw",
            agent_type: "openclaw",
            session_id: c.sessionKey,
            channel: c.channelId,
          },
          payload: { name: event.toolName, arguments: event.params },
          eventId: id("evt"),
          guardId: event.toolCallId ?? id("ga"),
          timestamp: new Date().toISOString(),
          sessionId: c.sessionKey,
          provenance,
        }

        const verdict = await guard.evaluate(ev)

        if (verdict.decision === "block") {
          return { block: true, blockReason: `[OpenGuardrails] ${brief(verdict)}` }
        }
        if (verdict.decision === "require_approval") {
          return {
            requireApproval: {
              title: `Approve ${event.toolName}?`,
              description: `[OpenGuardrails] ${brief(verdict)}`,
              severity: "warning",
              timeoutBehavior: "deny",
              pluginId: "openguardrails",
            },
          }
        }
        // allow | modify | redact → proceed unchanged
        return
      },
      { priority: 50 },
    )

    // Outbound guard: cancel a reply a deny verdict would forbid.
    api.on("message_sending", async (event, ctx) => {
      if (!guard.messagesEnabled) return
      const e = event as { content?: string }
      const c = ctx as { agentId?: string; sessionKey?: string; messageProvider?: string }
      const ev: GuardEvent = {
        kind: "model_output",
        observationPoint: "gateway",
        subject: { agent_id: c.agentId ?? "openclaw", agent_type: "openclaw", session_id: c.sessionKey },
        payload: { content: e.content ?? "", channel: c.messageProvider },
        eventId: id("evt"),
        guardId: id("ga"),
        timestamp: new Date().toISOString(),
        sessionId: c.sessionKey,
        provenance: [{ source: "model", trust: "unverified" }],
      }

      const verdict = await guard.evaluate(ev)
      if (verdict.decision === "block" || verdict.decision === "require_approval") {
        return {
          cancel: true,
          cancelReason: `openguardrails:${verdict.decision}`,
          metadata: { reason: brief(verdict) },
        }
      }
      return
    })
  },
})

export default plugin

export { DEFAULT_POLICY, DEFAULT_TAINT_TOOL_PATTERN } from "./config.js"
export type { GuardrailsOptions, JudgeConfig, TaintConfig } from "./config.js"
