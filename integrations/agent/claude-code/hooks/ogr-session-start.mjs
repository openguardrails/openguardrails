#!/usr/bin/env node
/**
 * OpenGuardrails — Claude Code SessionStart hook: bring up the local masking
 * proxy, and say plainly whether Claude Code is actually pointed at it.
 *
 * ⚠️⚠️ **WHY A PROXY HERE AT ALL, WHEN FOUR OTHER HARNESSES NEED NONE.**
 * hermes, opencode, openclaw and dsh load a plugin INSIDE the agent's
 * process, so their mask is an in-process `fetch` interceptor: no port, no
 * lifecycle, no base URL to change, and nothing left running when the
 * harness exits. Claude Code runs its hooks as separate PROCESSES — this
 * file is one — so there is no seam inside the agent to install anything on.
 * The next vantage down is a socket in front of it. That is the whole
 * reason, and it is why nothing here should ever be copied into a harness
 * that has a real plugin.
 *
 * ⚠️ **THIS HOOK CANNOT SET `ANTHROPIC_BASE_URL` AND MUST NOT PRETEND TO.**
 * A hook is a child process; exporting a variable there reaches nothing.
 * Claude Code reads its own environment at startup, from `settings.json`'s
 * `env` block, which is a file the operator owns. So the hook does the two
 * things it CAN do — start the daemon, and check whether the variable points
 * at it — and reports the gap loudly rather than leaving a session that
 * looks protected and is not.
 *
 * Never fails the session. A masking proxy that could not start is a reason
 * to work unprotected and know it, never a reason to be unable to work.
 */
import { execFileSync } from "node:child_process"

const PORT = Number(process.env.OGR_LOCAL_PORT || 8787)
const UPSTREAM = process.env.OGR_LOCAL_UPSTREAM || "https://api.anthropic.com"
const EXPECTED = `http://127.0.0.1:${PORT}/https/${new URL(UPSTREAM).host}${new URL(UPSTREAM).pathname.replace(/\/$/, "")}`

const say = (message) => process.stderr.write(`[OpenGuardrails] ${message}\n`)

/** The `ogr-local` entry point: an explicit path, else the one on PATH. */
function binary() {
  return process.env.OGR_LOCAL_BIN || "ogr-local"
}

async function listening() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/__ogr/status`, {
      signal: AbortSignal.timeout(700),
    })
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}

async function main() {
  if (process.env.OGR_LOCAL_REDACTION === "0" || process.env.OGR_LOCAL_REDACTION === "off") return
  if (!process.env.OGR_API_KEY) return // the integration is off; nothing to say

  let status = await listening()
  if (!status) {
    try {
      // `ensure` is idempotent and returns as soon as the daemon answers, so
      // a `--resume` storm cannot start a second one: the port is the lock.
      execFileSync(binary(), ["ensure", "--port", String(PORT)], {
        stdio: ["ignore", "ignore", "inherit"],
        timeout: 15_000,
      })
    } catch {
      say(
        `could not start the local masking proxy (${binary()}). Install it with `
        + "`npm i -g @openguardrails/ogr-local`, or set OGR_LOCAL_REDACTION=0 to stop this message. "
        + "Secrets in your prompts will reach the model provider.",
      )
      return
    }
    status = await listening()
  }
  if (!status) return

  const configured = (process.env.ANTHROPIC_BASE_URL || "").replace(/\/+$/, "")
  if (configured !== EXPECTED) {
    // The one failure that would otherwise be silent: the daemon is up, so
    // every status check looks healthy, while Claude Code talks straight to
    // the provider and nothing is masked.
    say(
      "the local masking proxy is running but Claude Code is not pointed at it — nothing is being masked. "
      + `Add this to your settings.json and restart:\n    "env": { "ANTHROPIC_BASE_URL": "${EXPECTED}" }`,
    )
    return
  }
  say(`local secrets redaction active — ruleset ${status.ruleset || "(none yet)"}`)
}

main().catch(() => {})
