#!/usr/bin/env node
/**
 * `ogr-local` — the command a `SessionStart` hook runs.
 *
 *   ogr-local ensure          make sure a daemon is listening; print its URL
 *   ogr-local serve           run the daemon in the foreground (what `ensure` spawns)
 *   ogr-local status          what the running daemon has masked
 *   ogr-local base-url <url>  the base URL to point a harness at, for one upstream
 *
 * ⚠️ Every exit path is 0 except an outright usage error. A masking proxy
 * that fails a harness's session start because it could not come up has
 * turned a redaction outage into an inability to work — the harness must
 * carry on, unprotected and loudly, exactly as it did before this existed.
 */
import { LocalRedactor } from "@openguardrails/local-redaction"

import { baseUrlFor, ensure, port, probe } from "./daemon.js"
import { startProxy } from "./server.js"

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`)
  return at !== -1 ? argv[at + 1] : undefined
}
const has = (name: string): boolean => argv.includes(`--${name}`)

const log = { info: (m: string) => console.error(m), warn: (m: string) => console.error(m) }

async function serve(): Promise<void> {
  const runtimeUrl = flag("runtime") ?? process.env["OGR_RUNTIME_URL"] ?? "https://openguardrails.com"
  const apiKey = flag("api-key") ?? process.env["OGR_API_KEY"] ?? ""
  if (!apiKey) {
    // Refused rather than started: with no key there is no ruleset, so the
    // daemon would forward every request unmasked while a harness pointed
    // at it looked protected. Better to not be listening at all.
    console.error("[ogr-local] no OGR_API_KEY — refusing to start a proxy that could not mask anything")
    process.exit(1)
  }
  const redactor = new LocalRedactor({
    source: () => ({ runtimeUrl, apiKey }),
    ...(process.env["OGR_RULES_CACHE"] ? { cachePath: process.env["OGR_RULES_CACHE"]! } : {}),
    log,
  })
  await redactor.start()
  // The interceptor's `sawTraffic` proof does not apply here: this process
  // IS the traffic path, so a request that reaches it has been masked by
  // definition. Nothing else could be listening on this port and forward.
  redactor.fallbackActive = true

  const idleMs = Number(flag("idle-ms") ?? process.env["OGR_LOCAL_IDLE_MS"] ?? 6 * 60 * 60 * 1000)
  const proxy = await startProxy({
    redactor,
    ...(flag("upstream") ? { upstream: flag("upstream")! } : {}),
    ...(flag("host") ? { hosts: flag("host")!.split(",").map((h) => h.trim()).filter(Boolean) } : {}),
    port: Number(flag("port") ?? port()),
    failClosed: has("fail-closed") || process.env["OGR_FAIL_MODE"] === "closed",
    idleMs: Number.isFinite(idleMs) ? idleMs : 0,
    log,
  })
  log.info(`[ogr-local] listening on ${proxy.url} — ruleset ${redactor.rulesetId || "(none)"}`)

  // Refresh the ruleset on the same cadence a plugin's heartbeat would.
  const timer = setInterval(() => void redactor.refresh(), 60_000)
  timer.unref?.()

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => void proxy.close().then(() => process.exit(0)))
  }
}

async function main(): Promise<void> {
  switch (argv[0]) {
    case "serve":
      return serve()
    case "ensure": {
      const url = await ensure({
        ...(flag("port") ? { port: Number(flag("port")) } : {}),
        args: [
          ...(flag("upstream") ? ["--upstream", flag("upstream")!] : []),
          ...(flag("host") ? ["--host", flag("host")!] : []),
          ...(has("fail-closed") ? ["--fail-closed"] : []),
        ],
      })
      if (url) console.log(url)
      else console.error("[ogr-local] could not start a masking proxy — the harness will run unprotected")
      return
    }
    case "status": {
      const s = await probe(flag("port") ? Number(flag("port")) : undefined)
      console.log(JSON.stringify(s ?? { ok: false }, null, 2))
      return
    }
    case "base-url": {
      const upstream = argv[1]
      if (!upstream) {
        console.error("usage: ogr-local base-url <https://api.example.com[/prefix]>")
        process.exit(2)
      }
      console.log(baseUrlFor(upstream, flag("port") ? Number(flag("port")) : undefined))
      return
    }
    default:
      console.error("usage: ogr-local <ensure|serve|status|base-url> [--port N] [--upstream URL] [--host a,b] [--fail-closed]")
      process.exit(2)
  }
}

void main().catch((err: unknown) => {
  console.error(`[ogr-local] ${String(err)}`)
  process.exit(1)
})
