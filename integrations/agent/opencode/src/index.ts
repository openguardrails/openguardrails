/**
 * @openguardrails/opencode-auto-mode
 *
 * Auto mode for opencode: permission prompts answered by OpenGuardrails (OGR)
 * policy instead of a human. Whatever your opencode `permission` config would
 * ask you — bash commands, edits, webfetch — the plugin answers from **your
 * own guardrails** (text/regex rules, optionally your own model as the
 * judge); only asks it cannot decide still reach you.
 *
 * Two hooks, one engine:
 *
 *   tool.execute.before   every tool call becomes an OGR `GuardEvent`, judged
 *                          BEFORE it runs: block | require_approval → throw
 *                          (deny-and-continue — the agent sees a tool error
 *                          and must find a safer path). The call's payload is
 *                          recorded under its `callID` for the ask below.
 *
 *   permission.ask         opencode's own permission prompt. Auto mode
 *                          re-evaluates the recorded call (or the ask's own
 *                          metadata) and answers: allow → "allow",
 *                          block → "deny", undecided → the human (default)
 *                          or "deny" under `auto.unresolved: "reject"`.
 *
 * Correlation: both events carry the `callID` as their OGR `guard_id`, so the
 * runtime can only tighten the earlier decision, never loosen it. This stays a
 * restrict-only guard toward the agent — auto mode automates the HUMAN's seat
 * (with the human's own policy), it never overrides an OGR verdict.
 *
 * No opencode core changes required.
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

function brief(v: Verdict): string {
  const cats = v.categories.map((c) => `${c.id}(${c.score})`).join(", ")
  const why = v.reasons.filter((r) => !r.startsWith("[")).join("; ")
  return [cats, why].filter(Boolean).join(" — ") || v.decision
}

/**
 * Bound on the per-call record table. Entries are removed on
 * `tool.execute.after`, which fires for every executed call; the cap is a
 * backstop against calls that never reach it (thrown denials included).
 */
const RECORDS_MAX = 4096

export const OpenGuardrailsPlugin: Plugin = async ({ directory }, options) => {
  const { policy, judge, auto } = loadGuardrailsConfig(directory, options as GuardrailsOptions | undefined)

  const detectors: Detector[] = [new ConfigRulesDetector(policy.config_rules ?? {})]
  if (judge) detectors.push(new LLMJudgeDetector(openAICompatibleBackend(judge)))
  const runtime = new Runtime(detectors, policy)

  /**
   * The payload of each live call, keyed by `callID` — a `Permission` carries
   * only type/pattern/metadata, so the `callID` is how an ask gets the actual
   * arguments back.
   */
  const records = new Map<string, { name: string; arguments: unknown }>()

  /** One invocation-altitude event; `guardId` ties both hooks to one action. */
  const toolCallEvent = (
    guardId: string | undefined,
    sessionId: string,
    payload: Record<string, unknown>,
  ): GuardEvent => ({
    kind: "tool_call",
    observationPoint: "invocation",
    agentId: "opencode",
    agentType: "opencode",
    payload,
    timestamp: new Date().toISOString(),
    sessionId,
    // v0.2: the model's request is unverified content. Transcript-based
    // tainting (web/mcp results → untrusted provenance) is a follow-up via
    // the opencode session API.
    provenance: [{ source: "model", trust: "unverified" }],
    ...guardId !== undefined ? { guardId } : {},
  })

  const hooks: Hooks = {
    "tool.execute.before": async (input, output) => {
      if (records.size >= RECORDS_MAX) {
        const oldest = records.keys().next()
        if (!oldest.done) records.delete(oldest.value)
      }
      records.set(input.callID, { name: input.tool, arguments: output.args })

      const ev = toolCallEvent(input.callID, input.sessionID, {
        name: input.tool,
        arguments: output.args,
      })
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

    "tool.execute.after": async (input) => {
      records.delete(input.callID)
    },
  }

  if (auto.enabled) {
    hooks["permission.ask"] = async (input, output) => {
      // What is actually being asked about: the recorded call when the ask
      // carries a callID this plugin has seen, else the permission's own
      // metadata (opencode's bash asks put the command there). An ask with
      // neither is undecidable — a guard does not grant what it cannot see.
      const record = input.callID !== undefined ? records.get(input.callID) : undefined
      const source = record
        ?? (Object.keys(input.metadata ?? {}).length > 0
          ? { name: input.type, arguments: input.metadata }
          : undefined)

      const undecided = (): void => {
        // `human` leaves the ask exactly as opencode raised it; `reject`
        // refuses it — the headless stance.
        if (auto.unresolved === "reject") output.status = "deny"
      }
      if (!source) return undecided()

      // Re-evaluate rather than trusting the before-hook's verdict blindly:
      // the ask's own descriptors travel in the payload for a judge to weigh,
      // and guard-context correlation (same guardId) guarantees the answer
      // can only tighten the earlier decision.
      const ev = toolCallEvent(input.callID, input.sessionID, {
        name: source.name,
        arguments: source.arguments,
        approval: {
          type: input.type,
          title: input.title,
          ...input.pattern !== undefined ? { pattern: input.pattern } : {},
        },
      })

      let verdict: Verdict
      try {
        verdict = await runtime.evaluate(ev)
      } catch {
        return undecided()
      }

      if (verdict.decision === "block") {
        output.status = "deny"
      } else if (verdict.decision === "require_approval") {
        undecided()
      } else {
        output.status = "allow"
      }
    }
  }

  return hooks
}

export default OpenGuardrailsPlugin
export {
  DEFAULT_POLICY,
  type AutoModeConfig,
  type AutoUnresolved,
  type GuardrailsOptions,
  type JudgeConfig,
} from "./config.js"
