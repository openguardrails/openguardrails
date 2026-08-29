/**
 * Starting the proxy once, from a hook that runs on every session.
 *
 * A `SessionStart` hook fires for every new conversation and for every
 * `--resume`, so "start the proxy" has to mean "make sure exactly one is
 * listening" — and it has to be safe when two harnesses fire at the same
 * instant. The answer is the port itself: a daemon is IDENTIFIED by the port
 * it holds, `ensure()` asks that port whether an `ogr-local` is already
 * there, and only spawns when nothing answers. A stale record cannot lie,
 * because the check is a live request rather than a pid or a lock file.
 *
 * ⚠️ THE PORT IS FIXED, AND THAT IS FORCED. Both harnesses configure their
 * provider base URL statically — Claude Code in `settings.json`'s `env`,
 * Codex in `config.toml` — so neither can be handed an ephemeral port. One
 * fixed port serves every upstream because the upstream travels in the path
 * (`server.ts`, `upstreamFor`).
 */
import { spawn } from "node:child_process"
import { openSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

/** The port `ANTHROPIC_BASE_URL` and `openai_base_url` are written against. */
export const DEFAULT_PORT = 8787

export const port = (): number => {
  const raw = process.env["OGR_LOCAL_PORT"]
  const n = raw ? Number(raw) : NaN
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT
}

/** `~/.openguardrails` — shared with the ruleset cache. */
export const stateDir = (): string => join(homedir(), ".openguardrails")

export interface Status {
  ok: true
  upstream: string | null
  ruleset: string
  masking: boolean
  sessions: number
  counters: Record<string, number>
}

/** Ask the port whether an `ogr-local` is behind it. Never throws. */
export async function probe(p = port(), timeoutMs = 500): Promise<Status | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`http://127.0.0.1:${p}/__ogr/status`, { signal: controller.signal })
    if (!res.ok) return null
    const body = (await res.json()) as Status
    return body?.ok === true ? body : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export interface EnsureOptions {
  port?: number
  /** How long to wait for a freshly spawned daemon to answer (default 8s). */
  waitMs?: number
  /** Extra argv for the spawned daemon. */
  args?: readonly string[]
  /** Where the daemon's stderr goes (default `~/.openguardrails/ogr-local.log`). */
  logPath?: string
}

/**
 * The URL a harness should be pointed at, starting a daemon if none answers.
 *
 * Returns `null` when one could not be started — the CALLER decides what
 * that means, and for both harnesses the answer is "say so and carry on
 * unprotected". A hook that failed the session because a masking proxy did
 * not come up would turn a redaction outage into an inability to work.
 */
export async function ensure(opts: EnsureOptions = {}): Promise<string | null> {
  const p = opts.port ?? port()
  if (await probe(p)) return `http://127.0.0.1:${p}`

  await mkdir(stateDir(), { recursive: true }).catch(() => {})
  const logPath = opts.logPath ?? join(stateDir(), "ogr-local.log")
  let out = "ignore" as "ignore" | number
  try {
    out = openSync(logPath, "a")
  } catch {
    /* a log we cannot open is not a reason to skip the mask */
  }

  const entry = fileURLToPath(new URL("./cli.js", import.meta.url))
  const child = spawn(process.execPath, [entry, "serve", "--port", String(p), ...(opts.args ?? [])], {
    detached: true,
    // ⚠️ stdin must be `ignore`, not inherited: a detached child holding the
    // harness's stdin steals the user's keystrokes on some terminals.
    stdio: ["ignore", out, out],
    env: process.env,
  })
  child.unref()

  // Poll rather than sleep: the hook is holding the session open, and the
  // difference between 60ms and a fixed one-second sleep is felt on every
  // `--resume`.
  const deadline = Date.now() + (opts.waitMs ?? 8000)
  for (;;) {
    if (await probe(p, 300)) return `http://127.0.0.1:${p}`
    if (Date.now() > deadline) return null
    await new Promise((r) => setTimeout(r, 60))
  }
}

/** The base URL to configure a harness with, for one upstream. */
export function baseUrlFor(upstream: string, p = port()): string {
  const u = new URL(upstream)
  const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "")
  return `http://127.0.0.1:${p}/${u.protocol.replace(":", "")}/${u.host}${path}`
}
