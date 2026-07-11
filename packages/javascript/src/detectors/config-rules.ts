/**
 * Reference detector #1 — config-based guardrail (text + regex).
 *
 * Deterministic rules loaded from config: a `policy.json` (text descriptions +
 * regex command rules + an egress allow-list) is a first-class guardrail
 * mechanism alongside an LLM. This is what lets an agent configure guardrails
 * for itself in plain text and regex, no model required.
 */
import { type Category, type GuardEvent, type Verdict, type Decision, severity, OGR_VERSION } from "../models.js"
import type { Detector } from "./index.js"

export interface CommandRule {
  id: string
  regex: string
  category: string
  domain?: string
  decision?: Decision
  score?: number
  why: string
}

export interface ConfigRules {
  egress_allowlist?: string[]
  secret_env_markers?: string[]
  command_rules?: CommandRule[]
}

// Tool-call names that carry a shell command / code payload.
const SHELL_TOOLS = new Set([
  "shell.exec",
  "bash",
  "run_shell",
  "terminal",
  "run_terminal_cmd",
  "execute_code",
  "run_code",
])

function commandString(ev: GuardEvent): string | undefined {
  if (ev.kind === "exec") {
    const argv = (ev.payload["argv"] as string[] | undefined) ?? []
    return argv.join(" ")
  }
  if (ev.kind === "tool_call" && SHELL_TOOLS.has(String(ev.payload["name"] ?? ""))) {
    const args = (ev.payload["arguments"] as Record<string, unknown> | undefined) ?? {}
    return (args["cmd"] ?? args["command"] ?? args["code"]) as string | undefined
  }
  return undefined
}

const maxDecision = (a: Decision, b: Decision): Decision => (severity(a) <= severity(b) ? a : b)

export class ConfigRulesDetector implements Detector {
  readonly provider = "ogr.config_rules"
  readonly handles = ["exec", "tool_call", "network"] as const
  private readonly patterns: Array<[RegExp, CommandRule]>

  constructor(private readonly cfg: ConfigRules) {
    this.patterns = (cfg.command_rules ?? []).map((r) => [new RegExp(r.regex), r])
  }

  evaluate(ev: GuardEvent): Verdict {
    const t0 = Date.now()
    const cats: Category[] = []
    const reasons: string[] = []
    let decision: Decision = "allow"

    // network egress allow-list
    if (ev.kind === "network") {
      const host = String(ev.payload["host"] ?? "")
      const allow = this.cfg.egress_allowlist ?? []
      if (allow.length > 0 && !allow.includes(host)) {
        decision = "block"
        cats.push({ id: "security.ssrf", domain: "security", score: 1.0 })
        reasons.push(`egress to '${host}' not in allow-list ${JSON.stringify(allow)}`)
      }
    }

    // command pattern rules (text/regex)
    const cmd = commandString(ev)
    if (cmd) {
      for (const [rx, rule] of this.patterns) {
        if (rx.test(cmd)) {
          decision = maxDecision(decision, rule.decision ?? "block")
          cats.push({ id: rule.category, domain: rule.domain ?? "security", score: rule.score ?? 1.0 })
          reasons.push(`matched rule '${rule.id}': ${rule.why}`)
        }
      }

      // secret-in-env exposed to a spawned process
      const markers = this.cfg.secret_env_markers ?? []
      const envKeys = (ev.payload["env_keys"] as string[] | undefined) ?? []
      const secretEnv = envKeys.filter((k) => markers.some((s) => k.toUpperCase().includes(s)))
      if (secretEnv.length > 0) {
        decision = maxDecision(decision, "require_approval")
        cats.push({ id: "security.secret_leak", domain: "security", score: 0.8 })
        reasons.push(`secrets exposed to process env: ${JSON.stringify(secretEnv)}`)
      }
    }

    return {
      eventId: ev.eventId,
      guardId: ev.guardId,
      provider: this.provider,
      decision,
      categories: cats,
      reasons: reasons.length ? reasons : ["no rule matched"],
      latencyMs: Date.now() - t0,
      ogrVersion: OGR_VERSION,
    }
  }
}
