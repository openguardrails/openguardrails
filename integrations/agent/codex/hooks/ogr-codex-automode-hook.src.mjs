#!/usr/bin/env node
/**
 * OpenGuardrails (OGR) — Codex PermissionRequest hook: AUTO MODE (source).
 *
 * Bundled by `npm run build` into ./ogr-codex-automode-hook.mjs (which
 * config.toml runs). This is the SOURCE — edit here, then rebuild. The bundle
 * inlines `@openguardrails/core` (RuntimeClient + Ed25519 signing), so the
 * built artifact stays a self-contained single file.
 *
 * What it does: Codex runs PermissionRequest hooks in the approval path,
 * BEFORE the guardian or the user approval prompt. This hook is an OGR
 * agent-hook PEP speaking the spec runtime API (specification/runtime-api.md):
 * it enrolls an Ed25519 key once via `POST /v1/enroll`, wraps the pending
 * tool call in a `tool_call` GuardEvent, asks the runtime for a Verdict via
 * `POST /v1/evaluate`, and maps the decision back:
 *
 *   allow             → auto-approve (the user never sees a prompt)
 *   block             → deny, classifier's reason goes back to the model
 *   require_approval  → abstain: Codex's own prompt appears (the local user
 *                       IS the approver in an interactive CLI)
 *   runtime down /
 *   timeout / error   → abstain (fail closed to ask — never silently allow)
 *
 * The GuardEvent carries the sanctioned `authz` extension envelope:
 * `transcript` — a reasoning-blind projection of the session (user text +
 * bare assistant tool calls; assistant prose and tool outputs are dropped so
 * a prompt-injected agent cannot argue the classifier into an allow) —
 * `instruction` (the latest user ask) and `authorization` (prose
 * environment/allow/soft_deny slots from OGR_AUTOMODE_POLICY). tool_call
 * receipt digests cover only ["name","arguments"], so the envelope never
 * invalidates approval receipts.
 *
 * A denial-escalation backstop (3 consecutive / 20 total denials per turn,
 * persisted under the state dir) hands control back to the human instead of
 * letting the agent spin in a deny loop.
 *
 * Pair this with the PreToolUse guardrail hook (ogr-codex-hook.mjs): this one
 * REMOVES prompts for safe calls, that one BLOCKS dangerous calls even when
 * approvals are bypassed.
 */
import { generateKeyPairSync } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { join } from "node:path"

import { RuntimeClient, createNodeSigner } from "@openguardrails/core"

// --- configuration (env with sane defaults) ---------------------------------

// OGR_SERVER / OGR_ENROLL_TOKEN are legacy aliases kept for existing installs.
const RUNTIME_URL = (
  process.env.OGR_RUNTIME_URL || process.env.OGR_SERVER || "http://127.0.0.1:8878"
).replace(/\/+$/, "")
const API_KEY = process.env.OGR_API_KEY || process.env.OGR_ENROLL_TOKEN || ""
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

// --- OGR PEP client (enroll once, evaluate per call) -------------------------

const pepStatePath = () => join(STATE_DIR, "pep-state.json")

// The signer is attached after enrollment resolves the key id; until then
// requests go out unsigned and land at the unenrolled attestation floor.
let signer = null

function makeClient() {
  return new RuntimeClient({
    baseUrl: RUNTIME_URL,
    apiKey: API_KEY, // RuntimeClient throws when empty → abstain path
    timeoutMs: TIMEOUT_MS,
    signer: { sign: (body) => (signer ? signer.sign(body) : null) },
  })
}

/**
 * Returns {pep_id, key_id, d, x}; cached across hook invocations on disk.
 * `forceFresh` mints a NEW keypair — a revoked key must not be re-enrolled.
 */
async function ensureEnrolled(client, forceFresh) {
  if (!forceFresh) {
    const cached = readJson(pepStatePath(), null)
    if (cached?.server === RUNTIME_URL && cached?.pep_id && cached?.key_id && cached?.d) {
      return cached
    }
  }
  const { privateKey } = generateKeyPairSync("ed25519")
  const jwk = privateKey.export({ format: "jwk" })
  const cred = await client.enroll({
    publicKey: jwk.x,
    pepId: AGENT_ID,
    name: `codex auto mode (${hostname()})`,
  })
  const state = { server: RUNTIME_URL, pep_id: cred.pepId, key_id: cred.keyId, d: jwk.d, x: jwk.x }
  writeJson(pepStatePath(), state)
  return state
}

async function attachSigner(state) {
  signer = await createNodeSigner({ d: state.d, x: state.x }, state.key_id)
}

let seq = 0
const id = (p) => `${p}-${Date.now().toString(36)}${(seq++).toString(36)}`

function buildGuardEvent(input, transcript, policy) {
  const authz = {}
  if (transcript.length) {
    authz.transcript = transcript
    const lastUser = [...transcript].reverse().find((t) => t.role === "user")
    if (lastUser?.text) authz.instruction = lastUser.text
  }
  if (policy) authz.authorization = policy
  const event = {
    kind: "tool_call",
    observationPoint: "invocation",
    sensorId: "openguardrails-codex-automode",
    sensorType: "in_process",
    agentId: AGENT_ID,
    agentType: "codex",
    attestation: "client_key",
    payload: { name: input.tool_name, arguments: input.tool_input ?? {} },
    eventId: id("evt"),
    guardId: id("ga"),
    timestamp: new Date().toISOString(),
    provenance: [],
  }
  if (input.session_id) event.sessionId = input.session_id
  if (Object.keys(authz).length) event.authz = authz
  return event
}

/** POST /v1/evaluate with one fresh-key re-enroll retry on a 401/403. */
async function decide(input, transcript, policy) {
  const client = makeClient()
  await attachSigner(await ensureEnrolled(client, false))
  try {
    return await client.evaluate(buildGuardEvent(input, transcript, policy))
  } catch (err) {
    // A rejected credential (revoked/stale key, runtime reset): enroll a
    // fresh key once and retry. Anything else propagates → abstain.
    if (err?.status !== 401 && err?.status !== 403) throw err
    await attachSigner(await ensureEnrolled(client, true))
    return await client.evaluate(buildGuardEvent(input, transcript, policy))
  }
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
