#!/usr/bin/env node
/**
 * OpenGuardrails (OGR) — Codex PermissionRequest hook: AUTO MODE (v0.8).
 *
 * There is no SDK layer in v0.8 — the Runtime API is the integration surface
 * (specification/runtime-api.md), and this hook is the whole integration: one
 * hand-rolled POST to `/v1/evaluate` per pending approval. No bundling
 * either — this file IS the source, zero dependencies, plain Node ≥ 18.
 * (v0.7 retired what the old hook spoke: `/v1/enroll`, Ed25519 detached-JWS
 * signing, and the `authz` envelope are gone from the protocol; the API key
 * is the whole channel identity.)
 *
 * What it does: Codex runs PermissionRequest hooks in the approval path,
 * BEFORE the user approval prompt. This hook asks the runtime about the
 * pending call and maps the Verdict back:
 *
 *   allow                → auto-approve (the user never sees a prompt)
 *   block                → deny, the findings go back to the model
 *   no verdict (runtime
 *   down/timeout/error)  → ABSTAIN: empty stdout, Codex's own prompt appears.
 *
 * Abstain is this hook's degraded mode, deliberately NOT the spec's
 * open/closed fork: a PermissionRequest has a human standing by, and "the
 * human decides" is strictly safer than either silently allowing (open) or
 * trapping the agent (closed). A guardrail that removes prompts must never
 * remove them by accident. The companion PreToolUse hook, which fires even
 * under bypassed approvals where no human is standing by, is the one that
 * takes OGR_FAIL_MODE.
 *
 * THE FRAGMENT VANTAGE. A hook does not hold the model call — Codex exposes
 * one tool call awaiting approval, never the request it sent or the response
 * it got. The honest v0.8 mapping is a single canonical `step/response`
 * carrying exactly what the host hands us: the held call, plus the current
 * generation's prose/reasoning from the session rollout. We never fabricate
 * the missing halves; the runtime derives sessions and turns, and `step_id`
 * is fresh per invocation. (The v0.6 reasoning-blind transcript projection
 * died with the `authz` envelope — in v0.8 the model's own prose is signal
 * the runtime's judge WANTS alongside the call, and resisting prompt-injected
 * argument is the judge's job, not the wire's.)
 *
 * A denial-escalation backstop (3 consecutive / 20 total denials per turn,
 * persisted under the state dir) hands control back to the human instead of
 * letting the agent spin in a deny loop.
 *
 * Pair this with the PreToolUse guardrail hook (ogr-codex-hook.mjs): this one
 * REMOVES prompts for safe calls, that one BLOCKS dangerous calls even when
 * approvals are bypassed.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"

// --- configuration (env; the four-tuple defaults to "" = no assertion) -------

// OGR_SERVER / OGR_ENROLL_TOKEN are legacy aliases kept for existing installs.
const RUNTIME_URL = (
  process.env.OGR_RUNTIME_URL || process.env.OGR_SERVER || "https://openguardrails.com"
).replace(/\/+$/, "")
const API_KEY = process.env.OGR_API_KEY || process.env.OGR_ENROLL_TOKEN || ""
const STATE_DIR =
  process.env.OGR_STATE_DIR || join(process.env.HOME || ".", ".codex", "openguardrails")
const TIMEOUT_MS = Number(process.env.OGR_TIMEOUT_MS || 5000)
const MAX_CONSECUTIVE_DENIALS = Number(process.env.OGR_MAX_CONSECUTIVE_DENIALS || 3)
const MAX_TOTAL_DENIALS = Number(process.env.OGR_MAX_TOTAL_DENIALS || 20)

/**
 * The identity four-tuple, all four always sent: the empty string is the
 * explicit "no assertion" (the runtime then derives from the API key — the
 * identity floor). Only `agent_type` has a non-empty default: it labels the
 * harness, which we do know.
 */
const IDENTITY = {
  agent_id: process.env.OGR_AGENT_ID || "",
  agent_type: process.env.OGR_AGENT_TYPE || "codex",
  agent_workspace: process.env.OGR_AGENT_WORKSPACE || "",
  agent_user: process.env.OGR_AGENT_USER || "",
}

// --- tiny io helpers ---------------------------------------------------------

function readStdin() {
  try {
    return readFileSync(0, "utf8")
  } catch {
    return ""
  }
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return fallback
  }
}

function writeJson(path, value) {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 })
}

/** Abstain: empty stdout tells Codex "no decision" and its own prompt runs. */
function abstain(note) {
  if (note) process.stderr.write(`[OpenGuardrails auto mode] ${note}\n`)
  process.exit(0)
}

function emit(behavior, message) {
  const decision = message ? { behavior, message } : { behavior }
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision },
    }),
  )
  process.exit(0)
}

// --- the current generation behind the held call ------------------------------

/**
 * `transcript_path` points at the Codex session rollout: one JSON object per
 * line, `response_item` lines holding Responses-API items. The held call was
 * born inside the generation running since the last user message; its prose
 * and reasoning summaries belong in the same `step/response` — splitting them
 * is the decomposition the spec warns destroys judge semantics. Best effort,
 * never fabricated: unreadable or absent rollout → the held call alone is
 * still an honest event.
 */
function currentGenerationOf(transcriptPath) {
  if (!transcriptPath) return null
  let raw
  try {
    raw = readFileSync(transcriptPath, "utf8")
  } catch {
    return null
  }
  let text = []
  let reasoning = []
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    let obj
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    if (obj.type !== "response_item" || !obj.payload) continue
    const item = obj.payload
    if (item.type === "message" && item.role === "user") {
      // A user message closes the previous generation: restart the window.
      text = []
      reasoning = []
    } else if (item.type === "message" && item.role === "assistant") {
      for (const c of item.content ?? []) if (c?.type === "output_text" && c.text) text.push(c.text)
    } else if (item.type === "reasoning") {
      for (const s of item.summary ?? []) if (s?.type === "summary_text" && s.text) reasoning.push(s.text)
    }
  }
  return { text, reasoning }
}

// --- denial-escalation backstop ----------------------------------------------

function denialStatePath(sessionId) {
  return join(STATE_DIR, `denials-${sessionId || "unknown"}.json`)
}

function loadDenials(sessionId, turnId) {
  const state = readJson(denialStatePath(sessionId), null)
  if (!state || state.turn_id !== turnId) return { turn_id: turnId, consecutive: 0, total: 0 }
  return state
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
const INTEGRATION = "ogr-codex-automode/1.0.0"

// --- GuardEvent → /v1/evaluate → Verdict --------------------------------------

/**
 * The one canonical `step/response` this vantage can honestly produce: the
 * held call as `tool_calls[0]`, plus the generation's prose/reasoning and the
 * host-reported model when present. Codex exposes no provider call id at
 * this hook, so the id is minted from the step_id — the canonical shape
 * wants one, and a minted id claims nothing.
 */
function buildEvent(input) {
  const gen = currentGenerationOf(input.transcript_path)
  const stepId = randomUUID().replace(/-/g, "")
  const payload = {
    tool_calls: [
      {
        id: `hook_${stepId}`,
        name: String(input.tool_name ?? ""),
        arguments: input.tool_input ?? {},
      },
    ],
  }
  if (gen?.text?.length) payload.text = gen.text.join("\n")
  if (gen?.reasoning?.length) payload.reasoning = gen.reasoning.join("\n")
  if (input.model) payload.model = String(input.model)
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
 * caller abstains. Per the degraded-mode spec a 429 (and any non-2xx) is an
 * outage, never an allow.
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
      process.stderr.write(`[OpenGuardrails auto mode] evaluate answered ${res.status} — no verdict\n`)
      return null
    }
    return await res.json()
  } catch (err) {
    process.stderr.write(`[OpenGuardrails auto mode] evaluate failed (${String(err)}) — no verdict\n`)
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
  return shown.map((f) => (f.subject ? `${f.category}: ${f.subject}` : f.category)).filter(Boolean).join("; ")
}

/**
 * We registered exactly one judged location: `payload.tool_calls[0]` (and its
 * subpaths). Verdict paths under it name the held call; `payload.text` /
 * `payload.reasoning` name rollout context the host has already rendered.
 */
const touchesHeldCall = (paths) => (paths ?? []).some((p) => String(p).startsWith("payload.tool_calls"))

// --- main --------------------------------------------------------------------

async function main() {
  let input
  try {
    input = JSON.parse(readStdin() || "{}")
  } catch (e) {
    abstain(`could not parse hook input: ${e}`)
  }
  if (input.hook_event_name && input.hook_event_name !== "PermissionRequest") abstain()
  if (!input.tool_name) abstain()
  if (!API_KEY) abstain("no OGR_API_KEY configured; deferring to the user")

  const sessionId = input.session_id ?? ""
  const turnId = input.turn_id ?? ""
  const denials = loadDenials(sessionId, turnId)
  if (denials.consecutive >= MAX_CONSECUTIVE_DENIALS || denials.total >= MAX_TOTAL_DENIALS) {
    // Too many runtime denials this turn: stop auto-deciding, let the human
    // answer Codex's own prompt.
    abstain("denial limit reached for this turn; deferring to the user")
  }

  const verdict = await evaluate(buildEvent(input))
  if (!verdict) abstain("runtime unavailable, deferring to the user")

  switch (verdict.decision) {
    case "allow": {
      // Two allow-shaped answers still go to the human instead of running:
      // spans on the held call (redaction this hook cannot apply must not
      // auto-execute) and `unjudged` naming it ("could not look" must not
      // silently become "auto-approved").
      if (touchesHeldCall((verdict.modifications?.spans ?? []).map((s) => s.path))) {
        abstain("verdict requires redactions this hook cannot apply; deferring to the user")
      }
      if (touchesHeldCall(verdict.unjudged)) {
        abstain("verdict left the held tool call unjudged; deferring to the user")
      }
      denials.consecutive = 0
      writeJson(denialStatePath(sessionId), denials)
      emit("allow")
      break
    }
    case "block": {
      denials.consecutive += 1
      denials.total += 1
      writeJson(denialStatePath(sessionId), denials)
      if (denials.consecutive >= MAX_CONSECUTIVE_DENIALS || denials.total >= MAX_TOTAL_DENIALS) {
        abstain("denial limit reached for this turn; deferring to the user")
      }
      emit(
        "deny",
        `[OpenGuardrails auto mode] ${reasonOf(verdict) || "blocked by policy"}. ` +
          "Adjust the approach or ask the user to run it manually.",
      )
      break
    }
    default:
      // An unrecognized decision from a future runtime: the human decides.
      abstain(`unrecognized decision '${verdict.decision}'; deferring to the user`)
  }
}

main().catch((e) => abstain(`unexpected hook error: ${e?.message ?? e}`))
