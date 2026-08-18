#!/usr/bin/env node
/**
 * OpenGuardrails (OGR) — Claude Code PreToolUse hook (v0.8).
 *
 * There is no SDK layer in v0.8 — the Runtime API is the integration surface
 * (specification/runtime-api.md), and this hook is the whole integration: one
 * hand-rolled POST to `/v1/evaluate` per held tool call, verdict mapped to a
 * Claude Code permission decision. No bundling either — this file IS the
 * source, zero dependencies, plain Node ≥ 18.
 *
 * Why a PreToolUse hook: it fires ABOVE Claude Code's permission system, so a
 * `deny` here blocks the call even in bypass / --dangerously-skip-permissions
 * mode — the one place the built-in classifier (auto mode only) can't reach.
 *
 * THE FRAGMENT VANTAGE. A hook does not hold the model call — Claude Code
 * exposes one tool call about to execute, never the request it sent or the
 * response it got. The honest v0.8 mapping is therefore a single canonical
 * `step/response` carrying exactly what the host hands us: the held tool
 * call, plus the prose/reasoning of the assistant turn it came from when the
 * session transcript supplies them. We never fabricate the missing halves —
 * no `step/request` is sent (we never see one), and a parallel tool call
 * arrives as its own hook invocation, so sibling calls of one generation
 * reach the runtime as separate steps. The runtime derives sessions and turns
 * from what it receives; `step_id` is fresh per invocation.
 *
 * The v0.6 local policy engine (bundled regex rules, egress allow-list,
 * composed detectors) retired with the SDK: every decision now comes from the
 * runtime's `/v1/evaluate`. No API key configured → the hook is inert.
 *
 * Degraded mode (specification/degraded-mode.md): a call that gets no verdict
 * (unreachable, timeout, 429, 5xx — and our own internal errors, which are
 * the same "could not judge" at a smaller size) applies OGR_FAIL_MODE —
 * `open` (default) proceeds and says so on stderr, `closed` denies.
 */
import { readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"

// --- configuration (env; the four-tuple defaults to "" = no assertion) -------

const RUNTIME_URL = (process.env.OGR_RUNTIME_URL || "https://openguardrails.com").replace(/\/+$/, "")
const API_KEY = process.env.OGR_API_KEY || ""
const TIMEOUT_MS = Number(process.env.OGR_TIMEOUT_MS || 5000)
/** `open` unless a deployment explicitly opts into `closed` — never a third value. */
const FAIL_MODE = process.env.OGR_FAIL_MODE === "closed" ? "closed" : "open"

/**
 * The identity four-tuple, all four always sent: the empty string is the
 * explicit "no assertion" (the runtime then derives from the API key — the
 * identity floor). Only `agent_type` has a non-empty default: it labels the
 * harness, which we do know.
 */
const IDENTITY = {
  agent_id: process.env.OGR_AGENT_ID || "",
  agent_type: process.env.OGR_AGENT_TYPE || "claude-code",
  agent_workspace: process.env.OGR_AGENT_WORKSPACE || "",
  agent_user: process.env.OGR_AGENT_USER || "",
}

// --- host i/o ----------------------------------------------------------------

/** Read the whole of stdin (the PreToolUse payload Claude Code sends). */
function readStdin() {
  try {
    return readFileSync(0, "utf8")
  } catch {
    return ""
  }
}

/** Allow is SILENT (exit 0, no output) so safe calls add zero friction. */
function emitAllow() {
  process.exit(0)
}

function emitDeny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `[OpenGuardrails] ${reason}`,
      },
    }),
  )
  process.exit(0)
}

/** The one degraded-mode fork: everything that ends in "no verdict" lands here. */
function emitFailMode(why) {
  if (FAIL_MODE === "closed") emitDeny(`${why}; fail mode is closed — denying until the runtime answers`)
  process.stderr.write(`[OpenGuardrails] ${why}; proceeding UNJUDGED (fail-open)\n`)
  emitAllow()
}

// --- the assistant turn behind the held call ---------------------------------

/**
 * Claude Code hands the hook a `transcript_path` (session JSONL). The held
 * tool call was born inside an assistant generation whose prose and thinking
 * the runtime should judge WITH the call — splitting them is the
 * decomposition the spec warns destroys judge semantics. Best effort, never
 * fabricated: find the assistant entry that contains this very tool_use
 * (matched by the host's `tool_use_id` when given, else by name + arguments),
 * fall back to the latest assistant entry, and give up silently on anything
 * unreadable — the held call alone is still an honest event.
 */
function assistantTurnOf(transcriptPath, toolUseId, toolName, toolInput) {
  if (!transcriptPath) return null
  let raw
  try {
    raw = readFileSync(transcriptPath, "utf8")
  } catch {
    return null
  }
  const wanted = JSON.stringify(toolInput ?? {})
  let last = null
  let match = null
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    let obj
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    if (obj.type !== "assistant" || !obj.message) continue
    const content = Array.isArray(obj.message.content) ? obj.message.content : []
    const turn = { text: [], reasoning: [], model: obj.message.model, callId: null }
    for (const block of content) {
      if (!block) continue
      if (block.type === "text" && block.text) turn.text.push(block.text)
      else if (block.type === "thinking" && block.thinking) turn.reasoning.push(block.thinking)
      else if (block.type === "tool_use") {
        const hit = toolUseId
          ? block.id === toolUseId
          : block.name === toolName && JSON.stringify(block.input ?? {}) === wanted
        if (hit) turn.callId = block.id
      }
    }
    last = turn
    if (turn.callId) match = turn
  }
  return match ?? last
}

/**
 * WHO REPORTED IT — `"name/version"`, the one OPTIONAL field on the v0.8 wire.
 *
 * ⚠️ Restored to the event on 2026-08-17. It had ridden the heartbeat alone,
 * which cannot answer "which build produced this traffic": a runtime keys its
 * liveness record on the integration NAME — it must, so a rollout updates that
 * row rather than minting a second and reporting the old build as dark — so
 * every replica overwrites the others' version.
 */
const INTEGRATION = "ogr-claude-code/1.0.0"

// --- GuardEvent → /v1/evaluate → Verdict --------------------------------------

/**
 * The one canonical `step/response` this vantage can honestly produce:
 * the held call as `tool_calls[0]`, plus the generation's prose/reasoning/
 * model when the transcript yields them. The call id is the provider's
 * `tool_use` id when we can recover it; otherwise minted from the step_id,
 * because the canonical shape wants an id and the host exposed none.
 */
function buildEvent(input) {
  const turn = assistantTurnOf(input.transcript_path, input.tool_use_id, input.tool_name, input.tool_input)
  const stepId = randomUUID().replace(/-/g, "")
  const payload = {
    tool_calls: [
      {
        id: (turn?.callId) || input.tool_use_id || `hook_${stepId}`,
        name: String(input.tool_name ?? ""),
        arguments: input.tool_input ?? {},
      },
    ],
  }
  if (turn?.text?.length) payload.text = turn.text.join("\n")
  if (turn?.reasoning?.length) payload.reasoning = turn.reasoning.join("\n")
  if (turn?.model) payload.model = turn.model
  return {
    kind: "step/response",
    step_id: stepId,
    ...IDENTITY,
    llm_protocol: "canonical",
    payload,
    integration: INTEGRATION,
  }
}

/**
 * Judge the event, or return null when the runtime could not answer — the
 * caller applies the fail mode. Per the degraded-mode spec a 429 (and any
 * non-2xx) is an outage, never an allow.
 */
async function evaluate(event) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${RUNTIME_URL}/v1/evaluate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(event),
      signal: controller.signal,
    })
    if (!res.ok) {
      process.stderr.write(`[OpenGuardrails] evaluate answered ${res.status} — no verdict\n`)
      return null
    }
    return await res.json()
  } catch (err) {
    process.stderr.write(`[OpenGuardrails] evaluate failed (${String(err)}) — no verdict\n`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Human-readable deny reason from findings: category + the MASKED subject. */
function reasonOf(verdict) {
  const all = verdict.findings ?? []
  const blocking = all.filter((f) => f.action === "block")
  const shown = blocking.length ? blocking : all
  return (
    shown.map((f) => (f.subject ? `${f.category}: ${f.subject}` : f.category)).filter(Boolean).join("; ") ||
    "blocked by policy"
  )
}

/**
 * We registered exactly one judged location: `payload.tool_calls[0]` (and its
 * subpaths). Verdict paths under it name the held call; `payload.text` /
 * `payload.reasoning` name transcript context the host has already rendered.
 */
const touchesHeldCall = (paths) => (paths ?? []).some((p) => String(p).startsWith("payload.tool_calls"))

async function main() {
  if (!API_KEY) emitAllow() // not configured → inert, not degraded
  let input
  try {
    input = JSON.parse(readStdin() || "{}")
  } catch (e) {
    emitFailMode(`could not parse hook input (${e})`)
  }
  if (!input.tool_name) emitAllow() // nothing held → nothing to judge

  const verdict = await evaluate(buildEvent(input))
  if (!verdict) emitFailMode("runtime unavailable")

  if (verdict.decision === "block") emitDeny(reasonOf(verdict))

  // allow — but two allow-shaped answers still stop the call:
  //  1. spans on the held call: the spec says apply-before-proceed, and a
  //     permission hook cannot rewrite tool arguments — unapplied redaction
  //     must not execute. (Spans on payload.text redact transcript context
  //     the host already displayed; nothing left to apply — noted, allowed.)
  if (touchesHeldCall((verdict.modifications?.spans ?? []).map((s) => s.path))) {
    emitDeny("the runtime requires redactions this hook cannot apply to a pending tool call")
  }
  //  2. fail-closed + `unjudged` naming the held call: "could not look" is
  //     not "found nothing" — the same fork as an unreachable runtime, at a
  //     smaller size (degraded-mode spec).
  if (FAIL_MODE === "closed" && touchesHeldCall(verdict.unjudged)) {
    emitFailMode("the verdict left the held tool call unjudged")
  }
  emitAllow()
}

main().catch((e) => emitFailMode(`unexpected hook error (${e?.message ?? e})`))
