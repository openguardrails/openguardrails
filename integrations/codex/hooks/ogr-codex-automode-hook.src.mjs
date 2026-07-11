#!/usr/bin/env node
/**
 * OpenGuardrails (OGR) — Codex PermissionRequest hook: AUTO MODE (source).
 *
 * Bundled by `npm run build` into ./ogr-codex-automode-hook.mjs (which
 * config.toml runs). This is the SOURCE — edit here, then rebuild.
 *
 * What it does: Codex runs PermissionRequest hooks in the approval path,
 * BEFORE the guardian or the user approval prompt. This hook is an OGR
 * agent-hook PEP: it wraps the pending tool call in a `tool_call` GuardEvent,
 * asks an OpenGuardrails runtime (`POST /api/v1/decide`), and maps the
 * Verdict back:
 *
 *   allow             → auto-approve (the user never sees a prompt)
 *   block             → deny, classifier's reason goes back to the model
 *   require_approval  → abstain: Codex's own prompt appears (the local user
 *                       IS the approver in an interactive CLI)
 *   runtime down /
 *   timeout / error   → abstain (fail closed to ask — never silently allow)
 *
 * The GuardEvent payload carries the OGR agent-hook extension keys:
 * `transcript` — a reasoning-blind projection of the session (user text +
 * bare assistant tool calls; assistant prose and tool outputs are dropped so
 * a prompt-injected agent cannot argue the classifier into an allow) — and
 * `policy` (prose environment/allow/soft_deny slots). tool_call receipt
 * digests cover only ["name","arguments"], so these extensions never
 * invalidate approval receipts.
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
import { hostname } from "node:os"
import { join } from "node:path"

const OGR_VERSION = "0.2"

// --- configuration (env with sane defaults) ---------------------------------

const SERVER = (process.env.OGR_SERVER || "http://127.0.0.1:8878").replace(/\/+$/, "")
const ENROLL_TOKEN = process.env.OGR_ENROLL_TOKEN || ""
const STATE_DIR =
  process.env.OGR_STATE_DIR || join(process.env.HOME || ".", ".codex", "openguardrails")
const AGENT_ID = process.env.OGR_AGENT_ID || `codex-${hostname()}`
const TIMEOUT_MS = Number(process.env.OGR_TIMEOUT_MS || 10_000)
const MAX_CONSECUTIVE_DENIALS = Number(process.env.OGR_MAX_CONSECUTIVE_DENIALS || 3)
const MAX_TOTAL_DENIALS = Number(process.env.OGR_MAX_TOTAL_DENIALS || 20)
const MAX_TRANSCRIPT_TURNS = Number(process.env.OGR_MAX_TRANSCRIPT_TURNS || 200)
/** Optional JSON file with {environment: [], allow: [], soft_deny: []}. */
const POLICY_PATH = process.env.OGR_AUTOMODE_POLICY || ""

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
  writeFileSync(path, JSON.stringify(value))
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

// --- reasoning-blind transcript from the Codex rollout file ------------------

/**
 * transcript_path points at the Codex session rollout: one JSON object per
 * line, `{"timestamp", "type", "payload"}` where `type == "response_item"`
 * lines hold Responses-API items. Keep ONLY user text and bare assistant
 * tool calls.
 */
function buildTranscript(transcriptPath) {
  if (!transcriptPath) return []
  let raw
  try {
    raw = readFileSync(transcriptPath, "utf8")
  } catch {
    return []
  }
  const turns = []
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
      const text = (item.content ?? [])
        .filter((c) => c && (c.type === "input_text" || c.type === "output_text"))
        .map((c) => c.text)
        .join("\n")
      if (text) turns.push({ role: "user", text })
    } else if (item.type === "function_call") {
      let input = item.arguments
      try {
        input = JSON.parse(item.arguments)
      } catch {
        /* keep raw string */
      }
      turns.push({ role: "assistant", tool: item.name, input })
    } else if (item.type === "custom_tool_call") {
      turns.push({ role: "assistant", tool: item.name, input: item.input })
    } else if (item.type === "local_shell_call") {
      turns.push({ role: "assistant", tool: "local_shell", input: item.action ?? {} })
    }
  }
  return turns.slice(-MAX_TRANSCRIPT_TURNS)
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

// --- OGR PEP client (enroll once, decide per call) ---------------------------

const pepStatePath = () => join(STATE_DIR, "pep-state.json")

async function post(path, body, headers = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    return await fetch(`${SERVER}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

/** Returns {agentId, credential}; caches across hook invocations on disk. */
async function ensureEnrolled(forceFresh) {
  if (!forceFresh) {
    const cached = readJson(pepStatePath(), null)
    if (cached?.server === SERVER && cached?.agent_id && cached?.credential) {
      return { agentId: cached.agent_id, credential: cached.credential }
    }
  }
  if (!ENROLL_TOKEN) throw new Error("OGR_ENROLL_TOKEN is not set")
  const resp = await post("/api/v1/enroll", {
    enroll_token: ENROLL_TOKEN,
    agent_type: "codex",
    agent_id: AGENT_ID,
    heartbeat_interval_s: 60,
  })
  if (!resp.ok) throw new Error(`enroll returned HTTP ${resp.status}`)
  const data = await resp.json()
  writeJson(pepStatePath(), {
    server: SERVER,
    agent_id: data.agent_id,
    credential: data.credential,
  })
  return { agentId: data.agent_id, credential: data.credential }
}

let seq = 0
const id = (p) => `${p}-${Date.now().toString(36)}${(seq++).toString(36)}`

function buildGuardEvent(agentId, input, transcript, policy) {
  const payload = { name: input.tool_name, arguments: input.tool_input ?? {} }
  if (transcript.length) payload.transcript = transcript
  if (policy) payload.policy = policy
  return {
    ogr_version: OGR_VERSION,
    event_id: id("evt"),
    guard_id: id("ga"),
    session_id: input.session_id ?? null,
    timestamp: new Date().toISOString(),
    observation_point: "agent_hook",
    kind: "tool_call",
    subject: { agent_id: agentId, agent_type: "codex" },
    payload,
    content_encoding: "raw",
  }
}

/** POST /api/v1/decide with one re-enroll retry on a stale credential. */
async function decide(input, transcript, policy) {
  let { agentId, credential } = await ensureEnrolled(false)
  let event = buildGuardEvent(agentId, input, transcript, policy)
  let resp = await post("/api/v1/decide", event, { authorization: `Bearer ${credential}` })
  if (resp.status === 401 || resp.status === 403) {
    ;({ agentId, credential } = await ensureEnrolled(true))
    event = buildGuardEvent(agentId, input, transcript, policy)
    resp = await post("/api/v1/decide", event, { authorization: `Bearer ${credential}` })
  }
  if (!resp.ok) throw new Error(`decide returned HTTP ${resp.status}`)
  return resp.json()
}

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

  const sessionId = input.session_id ?? ""
  const turnId = input.turn_id ?? ""
  const denials = loadDenials(sessionId, turnId)
  if (denials.consecutive >= MAX_CONSECUTIVE_DENIALS || denials.total >= MAX_TOTAL_DENIALS) {
    // Too many classifier denials this turn: stop auto-deciding, let the
    // human answer Codex's own prompt.
    abstain("denial limit reached for this turn; deferring to the user")
  }

  let verdict
  try {
    const transcript = buildTranscript(input.transcript_path)
    const policy = POLICY_PATH ? readJson(POLICY_PATH, undefined) : undefined
    verdict = await decide(input, transcript, policy)
  } catch (e) {
    // Fail closed TO ASK: no runtime judgment means the human decides.
    abstain(`runtime unavailable, deferring to the user: ${e.message ?? e}`)
  }

  const reason = (verdict.reasons ?? []).join("; ")
  switch (verdict.decision) {
    case "allow": {
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
        `[OpenGuardrails auto mode] ${reason || "blocked by policy"}. ` +
          "Adjust the approach or ask the user to run it manually.",
      )
      break
    }
    default:
      // require_approval / modify / redact (or anything future): the local
      // user is the approver — Codex's native prompt handles it.
      abstain()
  }
}

main().catch((e) => abstain(`unexpected hook error: ${e.message ?? e}`))
