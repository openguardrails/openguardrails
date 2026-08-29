#!/usr/bin/env node
/**
 * OpenGuardrails — Codex SessionStart hook: bring up the local masking proxy,
 * and say plainly whether Codex is actually pointed at it.
 *
 * ⚠️⚠️ **WHY A PROXY, AND WHY IT IS UNAVOIDABLE HERE.** The other
 * integrations mask inside the agent's own process, with a `fetch`
 * interceptor a plugin installs. Codex's host is **Rust**; its hooks are
 * separate processes speaking JSON on stdin. There is no JavaScript seam
 * inside Codex to install anything on, and there is not going to be one. The
 * next vantage down is a socket in front of it, which is `ogr-local`.
 *
 * ⚠️ **THE BASE URL IS THE OPERATOR'S TO SET, AND THIS HOOK ONLY CHECKS IT.**
 * Codex resolves its provider URL from `config.toml` at startup — a hook is a
 * child process and can change nothing about it. What this hook can do is
 * start the daemon and read the config back, so the one failure that would
 * otherwise be silent — daemon healthy, Codex talking straight to the
 * provider, nothing masked — is said out loud instead.
 *
 * ⚠️ `openai_base_url` (top level), not `model_providers.openai.base_url`:
 * Codex's built-in providers are deliberately not overridable
 * (`merge_configured_model_providers`), and the top-level key is the hook
 * upstream left for exactly this. It also overrides the ChatGPT-login
 * endpoint, which a per-provider entry would not reach.
 *
 * ⚠️ The proxy SHIPS WITH THIS PLUGIN — `hooks/ogr-local.mjs`, built from
 * `integrations/agent/ogr-local/src` and checked in, because a Codex plugin
 * installs as a directory with no `npm install` and no build step. There is
 * nothing for the user to install separately.
 *
 * Never fails the session.
 */
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const PORT = Number(process.env.OGR_LOCAL_PORT || 8787)

/**
 * Which endpoint Codex would be talking to. A ChatGPT sign-in routes to the
 * Codex backend, an API key to the public API — and the two are different
 * hosts, so the proxy's path has to name the right one. `auth.json` is where
 * Codex records which it holds.
 */
function upstream() {
  if (process.env.OGR_LOCAL_UPSTREAM) return process.env.OGR_LOCAL_UPSTREAM
  const home = process.env.CODEX_HOME || join(homedir(), ".codex")
  try {
    const auth = JSON.parse(readFileSync(join(home, "auth.json"), "utf8"))
    if (auth?.tokens) return "https://chatgpt.com/backend-api/codex"
  } catch {
    /* no auth.json readable: assume the API-key endpoint */
  }
  return "https://api.openai.com/v1"
}

function expectedBaseUrl() {
  const u = new URL(upstream())
  const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "")
  return `http://127.0.0.1:${PORT}/${u.protocol.replace(":", "")}/${u.host}${path}`
}

/** What `config.toml` currently says, if anything. */
function configuredBaseUrl() {
  const home = process.env.CODEX_HOME || join(homedir(), ".codex")
  try {
    const toml = readFileSync(join(home, "config.toml"), "utf8")
    const m = /^\s*openai_base_url\s*=\s*["']([^"']+)["']/m.exec(toml)
    return m ? m[1].replace(/\/+$/, "") : ""
  } catch {
    return ""
  }
}

/** Names this build in the daemon's status, so a shared daemon says whose it is. */
const INTEGRATION = "ogr-codex/2.1.0"

const say = (message) => process.stderr.write(`[OpenGuardrails] ${message}\n`)

async function listening() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/__ogr/status`, { signal: AbortSignal.timeout(700) })
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}

async function main() {
  if (process.env.OGR_LOCAL_REDACTION === "0" || process.env.OGR_LOCAL_REDACTION === "off") return
  if (!process.env.OGR_API_KEY && !process.env.OGR_ENROLL_TOKEN) return

  let status = await listening()
  if (!status) {
    try {
      const { ensure } = await import(new URL("./ogr-local.mjs", import.meta.url).href)
      await ensure({ port: PORT, args: ["--served-by", INTEGRATION] })
    } catch (err) {
      say(
        `could not start the local masking proxy (${err?.message ?? err}). `
        + "Set OGR_LOCAL_REDACTION=0 to stop this message. Secrets in your prompts will reach the model provider.",
      )
      return
    }
    status = await listening()
  }
  if (!status) return

  const want = expectedBaseUrl()
  if (configuredBaseUrl() !== want) {
    say(
      "the local masking proxy is running but Codex is not pointed at it — nothing is being masked. "
      + `Add this to ~/.codex/config.toml and restart:\n    openai_base_url = "${want}"`,
    )
    return
  }
  say(`local secrets redaction active — ruleset ${status.ruleset || "(none yet)"}`)
}

main().catch(() => {})
