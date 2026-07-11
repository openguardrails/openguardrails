#!/usr/bin/env node
/**
 * OpenGuardrails (OGR) — Claude Code PreToolUse hook (source).
 *
 * Bundled by `npm run build` into ./ogr-hook.mjs (which hooks.json invokes).
 * This is the SOURCE — edit here, then rebuild.
 *
 * Claude Code runs the bundle before a matched tool call. We turn the call into
 * an OGR GuardEvent, run it through the real OGR runtime (`@openguardrails/core`)
 * composing the deterministic `ConfigRulesDetector` with a small egress/secrets
 * detector, and map the composed Verdict to a Claude Code permission decision
 * (deny | ask | allow).
 *
 * Why a PreToolUse hook: it fires ABOVE Claude Code's permission system, so a
 * `deny` here blocks the call even in bypass / --dangerously-skip-permissions
 * mode — the one place the built-in classifier (auto mode only) can't reach.
 *
 * Adding a security vendor is just another detector in the `detectors` array
 * below: implement `evaluate(GuardEvent) → Verdict` and compose. No other change.
 *
 * Philosophy: fail OPEN on our own internal errors (a guardrail must not brick
 * the agent), fail CLOSED on a matched dangerous rule.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { Runtime, ConfigRulesDetector, OGR_VERSION } from "@openguardrails/core"

const HERE = dirname(fileURLToPath(import.meta.url))

/** Read the whole of stdin (the PreToolUse payload Claude Code sends). */
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

/** Pull the security-relevant string from a Claude Code tool call. */
function commandOf(input) {
  const tool = input.tool_name ?? input.tool ?? ""
  const ti = input.tool_input ?? input.toolInput ?? {}
  if (tool === "Bash") return [tool, ti.command]
  if (tool === "WebFetch") return [tool, ti.url]
  if (tool === "Read" || tool === "Edit" || tool === "Write") return [tool, ti.file_path ?? ti.path]
  // Unknown tool → scan serialized args so it still gets rule coverage.
  return [tool, JSON.stringify(ti ?? {})]
}

/**
 * Model the call as an OGR `exec` GuardEvent so the core ConfigRulesDetector
 * matches `command_rules` against argv. (Claude Code's tool name "Bash" isn't in
 * the detector's tool_call shell-tool set, but the exec kind keys off argv.)
 */
function buildGuardEvent(tool, command) {
  const guardId = id("g")
  return {
    kind: "exec",
    observationPoint: "agent_hook",
    subject: { tool },
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
    const cmd = ((ev.payload.argv ?? []).join(" ")) || ""
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

function toClaudeDecision(d) {
  if (d === "block") return "deny"
  if (d === "allow") return "allow"
  return "ask" // require_approval / redact / modify → confirm with the human
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
      { composition: policy.composition ?? { "security.*": { strategy: "deny-wins" }, default: { strategy: "deny-wins" } } },
    )
    const verdict = await runtime.evaluate(ev)
    const reason = (verdict.reasons ?? []).filter((r) => !/no .* finding|no rule matched/.test(r)).join("; ") || "policy violation"
    emit(toClaudeDecision(verdict.decision), reason)
  } catch (e) {
    process.stderr.write(`[OpenGuardrails] hook error, allowing this call: ${e}\n`)
    process.exit(0)
  }
}

main()
