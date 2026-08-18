#!/usr/bin/env node
/**
 * OpenGuardrails (OGR) — Codex PreToolUse guardrail hook (v0.8).
 *
 * There is no SDK layer in v0.8 — the Runtime API is the integration surface
 * (specification/runtime-api.md), and this hook is the whole integration: one
 * hand-rolled POST to `/v1/evaluate` per held tool call, verdict mapped to a
 * Codex permission decision. No bundling either — this file IS the source,
 * zero dependencies, plain Node ≥ 18.
 *
 * Why a PreToolUse hook: Codex sends `permission_mode` in the payload —
 * including `bypassPermissions` — and the hook fires regardless, so a `deny`
 * here blocks the call even when the user has waved through Codex's own
 * approvals. It is a non-bypassable enforcement point.
 *
 * THE FRAGMENT VANTAGE. A hook does not hold the model call — Codex exposes
 * one tool call about to execute, never the request it sent or the response
 * it got. The honest v0.8 mapping is a single canonical `step/response`
 * carrying exactly what the host hands us: the held call, plus the current
 * generation's prose/reasoning when the session rollout supplies them. We
 * never fabricate the missing halves — no `step/request` is sent, and
 * parallel calls of one generation reach the runtime as separate steps. The
 * runtime derives sessions and turns; `step_id` is fresh per invocation.
 *
 * The v0.6 local policy engine (bundled regex rules, egress allow-list,
 * composed detectors) retired with the SDK: every decision now comes from the
 * runtime's `/v1/evaluate`. No API key configured → the hook is inert.
 *
 * Degraded mode (specification/degraded-mode.md): a call that gets no verdict
 * (unreachable, timeout, 429, 5xx — and our own internal errors, which are
 * the same "could not judge" at a smaller size) applies OGR_FAIL_MODE —
 * `open` (default) proceeds and says so on stderr, `closed` denies.
 * (The companion PermissionRequest hook makes a different degraded choice —
 * abstain, so the human decides — because its failure mode has a human
 * standing by. This one fires under bypassed approvals, where the only
 * outcomes are allow and deny.)
 */
import { readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"

// --- configuration (env; the four-tuple defaults to "" = no assertion) -------

// OGR_SERVER / OGR_ENROLL_TOKEN are legacy aliases kept for existing installs.
const RUNTIME_URL = (
  process.env.OGR_RUNTIME_URL || process.env.OGR_SERVER || "https://openguardrails.com"
).replace(/\/+$/, "")
const API_KEY = process.env.OGR_API_KEY || process.env.OGR_ENROLL_TOKEN || ""
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
  agent_type: process.env.OGR_AGENT_TYPE || "codex",
  agent_workspace: process.env.OGR_AGENT_WORKSPACE || "",
  agent_user: process.env.OGR_AGENT_USER || "",
}

// --- host i/o ----------------------------------------------------------------

/** Read the whole of stdin (the PreToolUse payload Codex sends). */
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

// --- the current generation behind the held call ------------------------------

/**
 * Codex hands the hook a `transcript_path` (the session rollout: one JSON
 * object per line, `response_item` lines holding Responses-API items). The
 * held call was born inside the generation running since the last user
 * message; its prose and reasoning summaries belong in the same
 * `step/response` — splitting them is the decomposition the spec warns
 * destroys judge semantics. Best effort, never fabricated: unreadable or
 * absent rollout → the held call alone is still an honest event.
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

/**
 * WHO REPORTED IT — `"name/version"`, the one OPTIONAL field on the v0.8 wire.
 *
 * ⚠️ Restored to the event on 2026-08-17. It had ridden the heartbeat alone,
 * which cannot answer "which build produced this traffic": a runtime keys its
 * liveness record on the integration NAME — it must, so a rollout updates that
 * row rather than minting a second and reporting the old build as dark — so
 * every replica overwrites the others' version.
 */
const INTEGRATION = "ogr-codex/1.0.0"

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
 * `payload.reasoning` name rollout context the host has already rendered.
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
  //     must not execute. (Spans on payload.text redact rollout context the
  //     host already displayed; nothing left to apply — noted, allowed.)
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
