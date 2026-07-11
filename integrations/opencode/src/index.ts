/**
 * openguardrails-instrumentation-opencode
 *
 * An opencode plugin that guards an agent's tool calls through the OpenGuardrails
 * (OGR) protocol — the TS counterpart of `openguardrails-instrumentation-hermes`.
 *
 * It hooks `tool.execute.before` (fired for every tool, before it runs), turns
 * the call into an OGR `GuardEvent`, runs it through a `Runtime` built from the
 * agent's own guardrails policy (text/regex rules, plus optionally its own model
 * as an LLM judge), and enforces the `Verdict`:
 *
 *   allow | modify | redact → proceed
 *   block | require_approval → throw (deny-and-continue: the agent sees a tool
 *                              error and must find a safer path or get approval)
 *
 * No opencode core changes required. This is a "restrict-only" guard: it can stop
 * a would-run tool call, never loosen one.
 */
import type { Plugin, Hooks } from "@opencode-ai/plugin"
import {
  Runtime,
  ConfigRulesDetector,
  LLMJudgeDetector,
  type Detector,
  type GuardEvent,
  type Verdict,
} from "@openguardrails/core"
import { loadGuardrailsConfig, type GuardrailsOptions } from "./config.js"
import { openAICompatibleBackend } from "./own-model.js"

let seq = 0
function id(prefix: string): string {
  seq += 1
  const rand = globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10)
  return `${prefix}-${seq.toString(36)}-${rand}`
}

function brief(v: Verdict): string {
  const cats = v.categories.map((c) => `${c.id}(${c.score})`).join(", ")
  const why = v.reasons.filter((r) => !r.startsWith("[")).join("; ")
  return [cats, why].filter(Boolean).join(" — ") || v.decision
}

export const OpenGuardrailsPlugin: Plugin = async ({ directory }, options) => {
  const { policy, judge } = loadGuardrailsConfig(directory, options as GuardrailsOptions | undefined)

  const detectors: Detector[] = [new ConfigRulesDetector(policy.config_rules ?? {})]
  if (judge) detectors.push(new LLMJudgeDetector(openAICompatibleBackend(judge)))
  const runtime = new Runtime(detectors, policy)

  const hooks: Hooks = {
    "tool.execute.before": async (input, output) => {
      const ev: GuardEvent = {
        kind: "tool_call",
        observationPoint: "agent_hook",
        subject: { agent_id: "opencode", agent_type: "opencode", session_id: input.sessionID },
        payload: { name: input.tool, arguments: output.args },
        eventId: id("evt"),
        guardId: id("ga"),
        timestamp: new Date().toISOString(),
        sessionId: input.sessionID,
        // v0.1: principal is trusted. Transcript-based tainting (web/mcp results
        // → untrusted provenance) is a follow-up via the opencode session API.
        provenance: [{ source: "user", trust: "trusted" }],
      }

      const verdict = await runtime.evaluate(ev)

      if (verdict.decision === "block") {
        throw new Error(`[OpenGuardrails] blocked this ${input.tool} call: ${brief(verdict)}`)
      }
      if (verdict.decision === "require_approval") {
        throw new Error(
          `[OpenGuardrails] this ${input.tool} call needs your explicit approval: ${brief(verdict)}. ` +
            `Re-run only if you intend this, or relax .opencode/guardrails.json.`,
        )
      }
      // allow | modify | redact → proceed
    },
  }

  return hooks
}

export default OpenGuardrailsPlugin
export { DEFAULT_POLICY, type GuardrailsOptions, type JudgeConfig } from "./config.js"
