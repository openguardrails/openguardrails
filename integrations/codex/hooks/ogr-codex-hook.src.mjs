#!/usr/bin/env node
/**
 * OpenGuardrails (OGR) — Codex PreToolUse hook (source).
 *
 * Bundled by `npm run build` into ./ogr-codex-hook.mjs (which config.toml runs).
 * This is the SOURCE — edit here, then rebuild.
 *
 * OpenAI Codex (codex-rs) runs a matched `command` hook before a tool call. We
 * turn the call into an OGR GuardEvent, run it through the real OGR runtime
 * (`@openguardrails/core`) composing the deterministic `ConfigRulesDetector`
 * with a small egress/secrets detector, and map the composed Verdict to a Codex
 * permission decision (deny | ask | allow).
 *
 * Why a PreToolUse hook: Codex sends `permission_mode` in the payload — including
 * `bypassPermissions` — and the hook fires regardless, so a `deny` here blocks
 * the call even when the user has waved through Codex's own approvals. It is a
 * non-bypassable enforcement point.
 *
 * Codex maps cleanly to OGR: it has a native `ask` decision, so OGR's
 * `require_approval` becomes Codex's human-in-the-loop prompt with no fudging.
 *
 * Adding a security vendor is just another detector in the `detectors` array:
 * implement `evaluate(GuardEvent) → Verdict` and compose. No other change.
 *
 * Philosophy: fail OPEN on our own internal errors (a guardrail must not brick
 * the agent), fail CLOSED on a matched dangerous rule.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { Runtime, ConfigRulesDetector, OGR_VERSION } from "@openguardrails/core"

const HERE = dirname(fileURLToPath(import.meta.url))

/** Read the whole of stdin (the PreToolUse payload Codex sends). */
function readStdin() {
  try {
    return readFileSync(0, "utf8")
  } catch {
    return ""
  }
}

function loadPolicy() {
  const path = process.env.OGR_POLICY || join(HERE, "..", "policy", "policy.json")
  return JSON.parse(readFileSync(path, "utf8"))
}

let seq = 0
const id = (p) => `${p}_${Date.now().toString(36)}_${(seq++).toString(36)}`

/**
 * Pull the security-relevant string from a Codex tool call. Codex's canonical
 * tool names are `Bash` (shell) and `apply_patch` (file edits, with Claude
 * Code-style aliases `Write`/`Edit`). Unknown tools fall back to the serialized
 * arguments so they still get rule coverage.
 */
function commandOf(input) {
  const tool = input.tool_name ?? input.tool ?? ""
  const ti = input.tool_input ?? input.toolInput ?? {}
  if (tool === "Bash") return [tool, ti.command ?? ti.cmd]
  if (tool === "apply_patch") return [tool, ti.input ?? ti.patch ?? JSON.stringify(ti)]
  if (tool === "Read" || tool === "Edit" || tool === "Write")
    return [tool, ti.file_path ?? ti.path]
  if (tool === "WebFetch" || tool === "web_fetch") return [tool, ti.url]
  return [tool, JSON.stringify(ti ?? {})]
}

/**
 * Model the call as an OGR `exec` GuardEvent so the core ConfigRulesDetector
 * matches `command_rules` against argv (the detector keys shell rules off argv).
 */
function buildGuardEvent(tool, command) {
  const guardId = id("g")
  return {
    kind: "exec",
    observationPoint: "agent_hook",
    subject: { tool, agentType: "codex" },
    payload: { argv: [String(command ?? "")], tool, name: tool },
    eventId: id("e"),
    guardId,
    timestamp: new Date().toISOString(),
    provenance: [{ source: "model", trust: "unverified" }],
    ogrVersion: OGR_VERSION,
  }
}

function hostsIn(text) {
  const out = []
  const re = /https?:\/\/([^/\s"'`)]+)/gi
  let m
  while ((m = re.exec(text))) out.push(m[1].replace(/^.*@/, "").split(":")[0].toLowerCase())
  return out
}
const hostAllowed = (host, allow) =>
  allow.some((p) => {
    const pat = p.toLowerCase()
    return pat.startsWith("*.") ? host === pat.slice(2) || host.endsWith(pat.slice(1)) : host === pat
  })

/**
 * A second OGR detector (the extension point in miniature): egress allow-list +
 * credential-path checks over the command string — things the regex config_rules
 * don't express well. A vendor detector would slot in exactly like this.
 */
class CommandEgressSecretsDetector {
  constructor(policy) {
    this.policy = policy
    this.provider = "ogr.command_egress_secrets"
    this.handles = ["exec"]
  }
  evaluate(ev) {
    const cmd = (ev.payload.argv ?? []).join(" ") || ""
    const reasons = []
    const categories = []
    let decision = "allow"
    const bump = (d) => {
      const order = ["block", "require_approval", "redact", "modify", "allow"]
      if (order.indexOf(d) < order.indexOf(decision)) decision = d
    }

    const allow = this.policy.egress_allowlist ?? []
    if (allow.length) {
      for (const host of hostsIn(cmd)) {
        if (!hostAllowed(host, allow)) {
          bump("require_approval")
          categories.push({ id: "security.egress", domain: "security", score: 0.7 })
          reasons.push(`egress to '${host}' is not in the OGR allow-list`)
        }
      }
    }
    for (const marker of this.policy.secret_read_markers ?? []) {
      if (cmd.includes(marker)) {
        bump("require_approval")
        categories.push({ id: "security.secret_leak", domain: "security", score: 0.8 })
        reasons.push(`references a credential-bearing path ('${marker}')`)
        break
      }
    }
    return {
      eventId: ev.eventId,
      guardId: ev.guardId,
      provider: this.provider,
      decision,
      categories,
      reasons: reasons.length ? reasons : ["no egress/secret finding"],
      ogrVersion: OGR_VERSION,
    }
  }
}

/** OGR Verdict decision → Codex PreToolUse permissionDecision. */
function toCodexDecision(d) {
  if (d === "block") return "deny"
  if (d === "allow") return "allow"
  return "ask" // require_approval / redact / modify → Codex's native human prompt
}

function emit(permissionDecision, reason) {
  if (permissionDecision === "allow") process.exit(0) // stay silent on safe calls
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision,
        permissionDecisionReason: `[OpenGuardrails] ${reason}`,
      },
    }),
  )
  process.exit(0)
}

async function main() {
  let input
  try {
    input = JSON.parse(readStdin() || "{}")
  } catch (e) {
    process.stderr.write(`[OpenGuardrails] could not parse hook input, allowing: ${e}\n`)
    process.exit(0)
  }
  try {
    const policy = loadPolicy()
    const [tool, command] = commandOf(input)
    const ev = buildGuardEvent(tool, command)
    const runtime = new Runtime(
      [new ConfigRulesDetector(policy), new CommandEgressSecretsDetector(policy)],
      {
        composition: policy.composition ?? {
          "security.*": { strategy: "deny-wins" },
          default: { strategy: "deny-wins" },
        },
      },
    )
    const verdict = await runtime.evaluate(ev)
    const reason =
      (verdict.reasons ?? [])
        .filter((r) => !/no .* finding|no rule matched/.test(r))
        .join("; ") || "policy violation"
    emit(toCodexDecision(verdict.decision), reason)
  } catch (e) {
    process.stderr.write(`[OpenGuardrails] hook error, allowing this call: ${e}\n`)
    process.exit(0)
  }
}

main()
