/**
 * The proxy itself: a loopback HTTP server the harness's provider base URL
 * points at, forwarding to the real provider with the request masked and the
 * reply's tool-call arguments restored.
 *
 * ⚠️⚠️ **THIS EXISTS BECAUSE TWO HARNESSES HAVE NO IN-PROCESS SEAM, AND FOR
 * NO OTHER REASON.** Claude Code and Codex expose hooks as separate
 * PROCESSES — Codex's host is not even JavaScript — so the interceptor that
 * masks inside hermes, opencode, openclaw and dsh cannot be installed there.
 * A socket in front of the harness is the next vantage down. Anything with a
 * plugin that runs in the agent's own process must use the interceptor
 * instead: it needs no port, no lifecycle and no base-URL change, and it
 * cannot be left running after the harness exits.
 *
 * What it does NOT do, on purpose:
 *
 * - **It holds no credential and mints none.** The harness's own
 *   `Authorization` (or `x-api-key`) is forwarded byte for byte and never
 *   read. The proxy is not an auth boundary and must never become one — a
 *   process that could answer for the user is a far worse thing to leave
 *   listening than one that can only rewrite a body.
 * - **It answers no `/restore`.** `/__ogr/mask` is offered to the harness's
 *   hooks so their events carry the same tokens the provider was given;
 *   the reverse would turn a loopback port into an oracle that hands any
 *   local process the plaintext of every secret this session has seen.
 * - **It does not judge.** Verdicts stay with the harness's OGR hooks. This
 *   is a masking seam, not a second enforcement point.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { Readable } from "node:stream"

import { isModelHost, LocalRedactor } from "@openguardrails/local-redaction"

import { Pipe, type PipeOptions } from "./pipe.js"

/** Headers a proxy must not copy through — they describe THIS hop, not the next. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
])

/**
 * ⚠️ `accept-encoding` is dropped on the way UP so the provider answers in
 * plain text. A gzipped reply is one this proxy cannot restore a tool call
 * out of, and silently forwarding it would look exactly like a reply with
 * nothing to restore. Compression between a loopback socket and a provider
 * is not worth a failure mode that quiet.
 */
const DROP_UPSTREAM = new Set([...HOP_BY_HOP, "accept-encoding"])

export interface ProxyOptions extends Omit<PipeOptions, "redactor"> {
  /**
   * Where the real provider is when the request does not name one, e.g.
   * `https://api.anthropic.com`. Optional: the ordinary wiring puts the
   * upstream in the PATH (see {@link upstreamFor}), which is what lets one
   * daemon on one port serve harnesses that talk to different providers.
   */
  upstream?: string
  redactor: LocalRedactor
  /** Refuse a model request when no ruleset is in hand (default: forward it, loudly). */
  failClosed?: boolean
  /** Shut down after this many ms with no request (0 = never). */
  idleMs?: number
}

export interface RunningProxy {
  url: string
  port: number
  pipe: Pipe
  close(): Promise<void>
}

const nowMs = (): number => Date.now()

const trimSlash = (u: string): string => (u.endsWith("/") ? u.slice(0, -1) : u)

/**
 * Where this request is really going.
 *
 * ⚠️⚠️ **THE UPSTREAM IS IN THE PATH, AND THAT IS WHAT MAKES ONE DAEMON
 * ENOUGH.** Both harnesses this proxy exists for configure their provider
 * base URL STATICALLY — Claude Code through `settings.json`'s `env` block,
 * Codex through `openai_base_url` in `config.toml` — so neither can be told
 * about an ephemeral port, and a fixed port per upstream would mean one
 * listener per provider, each needing its own lifecycle. Encoding the
 * upstream in the base URL the harness is already configured with collapses
 * all of that to one port:
 *
 *     ANTHROPIC_BASE_URL=http://127.0.0.1:8787/https/api.anthropic.com
 *     openai_base_url   ="http://127.0.0.1:8787/https/chatgpt.com/backend-api/codex"
 *
 * `/https/<host>/<rest>` rather than a query parameter or a header, because
 * a base URL is the ONE thing both harnesses let an operator set, and every
 * path they append lands after it untouched.
 */
export function upstreamFor(
  url: URL,
  fallback: string | null,
): { base: string; path: string; host: string; hostname: string } | null {
  const m = /^\/(https?)\/([^/]+)(\/.*)?$/.exec(url.pathname)
  if (m) {
    const [, scheme, host, rest] = m
    // ⚠️ `host` is the AUTHORITY (it may carry a port) and `hostname` is what
    // the allowlist compares. Passing the authority to `isModelHost` looks
    // right and refuses every upstream on a non-default port — which is
    // every test double and every self-hosted gateway.
    return {
      base: `${scheme}://${host}`,
      path: rest ?? "/",
      host: host!,
      hostname: new URL(`${scheme}://${host}`).hostname,
    }
  }
  if (!fallback) return null
  const u = new URL(fallback)
  return { base: fallback, path: url.pathname, host: u.host, hostname: u.hostname }
}

export async function startProxy(opts: ProxyOptions & { port?: number; host?: string }): Promise<RunningProxy> {
  const log = opts.log ?? { info: (m: string) => console.error(m), warn: (m: string) => console.error(m) }
  const pipe = new Pipe({ ...opts, log })
  const fallback = opts.upstream ? trimSlash(opts.upstream) : null
  let lastActivity = nowMs()

  const server = createServer((req, res) => {
    lastActivity = nowMs()
    // ⚠️ A daemon outlives the request that killed it. An `error` event with
    // no listener — the client hanging up mid-stream is the ordinary case —
    // is an uncaught exception, and taking the proxy down takes the harness's
    // model access with it.
    req.on("error", () => {})
    res.on("error", () => {})
    handle(req, res).catch((err: unknown) => {
      log.warn(`[ogr-local] ${String(err)}`)
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "ogr_local_proxy_failed", detail: String(err) }))
    })
  })

  async function readBody(req: IncomingMessage): Promise<Buffer> {
    const parts: Buffer[] = []
    for await (const chunk of req) parts.push(chunk as Buffer)
    return Buffer.concat(parts)
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`)
    if (url.pathname.startsWith("/__ogr/")) return control(req, res, url)

    const raw = await readBody(req)
    const route = upstreamFor(url, fallback)
    if (!route) {
      return refuse(res, 404, "ogr_local_no_upstream", "no upstream in the path and none configured — see the README's base-URL wiring")
    }
    if (!isModelHost(route.hostname, opts.hosts)) {
      // ⚠️ THE ALLOWLIST IS WHAT KEEPS A PATH-ADDRESSED PROXY FROM BEING AN
      // OPEN ONE. Putting the upstream in the URL is what lets one daemon
      // serve every harness; without a bound on where that URL may point,
      // any process on this machine would have a general-purpose forwarder
      // listening on loopback. It may only reach model APIs.
      return refuse(res, 403, "ogr_local_upstream_refused", `${route.hostname} is not a known model API host (add it with --host)`)
    }
    const target = new URL(route.base + route.path + url.search)
    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || DROP_UPSTREAM.has(k.toLowerCase())) continue
      headers.set(k, Array.isArray(v) ? v.join(", ") : v)
    }

    // -- the request half --
    let plan = null as ReturnType<Pipe["mask"]>
    let out: Buffer | undefined = raw.length > 0 ? raw : undefined
    if (raw.length > 0) {
      if (!pipe.redactor.ready) {
        // No ruleset: the honest choices are "forward, loudly" and "refuse".
        // Forwarding is the default because a proxy that stops the harness
        // is a proxy nobody keeps installed — and an unmasked request is
        // exactly what the harness did before this existed.
        if (opts.failClosed && looksLikeModelCall(raw)) {
          res.writeHead(503, { "content-type": "application/json" })
          res.end(JSON.stringify({ error: "ogr_local_unprotected", detail: "no secret ruleset in hand and the deployment is fail-closed" }))
          return
        }
        pipe.redactor.warnUnprotected("this model request")
      }
      plan = pipe.mask(target, headers, raw.toString("utf8"))
      if (plan) out = Buffer.from(plan.body, "utf8")
      else pipe.counters.passed += 1
    }
    if (out) headers.set("content-length", String(out.byteLength))

    const upstreamRes = await fetch(target, {
      method: req.method ?? "GET",
      headers,
      ...(out ? { body: out } : {}),
      redirect: "manual",
    })

    // -- the reply half --
    const replyHeaders: Record<string, string> = {}
    upstreamRes.headers.forEach((v, k) => {
      if (!HOP_BY_HOP.has(k.toLowerCase())) replyHeaders[k] = v
    })
    // ⚠️ `fetch` decompresses transparently, so the bytes we are about to
    // write are PLAIN whatever the provider's header says. Forwarding a
    // `content-encoding: gzip` over plaintext gives the harness a body it
    // cannot decode — an integration that looks broken for a reason nowhere
    // near the mask.
    delete replyHeaders["content-encoding"]
    const type = upstreamRes.headers.get("content-type") ?? ""

    if (!plan || !upstreamRes.body) {
      // Nothing to restore into: stream the provider's answer through.
      delete replyHeaders["content-length"]
      res.writeHead(upstreamRes.status, replyHeaders)
      if (upstreamRes.body) await pump(upstreamRes.body, res)
      else res.end()
      return
    }

    if (type.includes("text/event-stream")) {
      delete replyHeaders["content-length"]
      res.writeHead(upstreamRes.status, replyHeaders)
      const restorer = pipe.streamRestorer(plan)
      const decoder = new TextDecoder()
      for await (const chunk of upstreamRes.body as unknown as AsyncIterable<Uint8Array>) {
        res.write(restorer.feed(decoder.decode(chunk, { stream: true })))
      }
      const tail = restorer.end()
      if (tail) res.write(tail)
      res.end()
      return
    }

    const text = await upstreamRes.text()
    const restored = pipe.restore(plan, text)
    const bytes = Buffer.from(restored, "utf8")
    replyHeaders["content-length"] = String(bytes.byteLength)
    res.writeHead(upstreamRes.status, replyHeaders)
    res.end(bytes)
  }

  function refuse(res: ServerResponse, status: number, error: string, detail: string): void {
    const bytes = Buffer.from(JSON.stringify({ error, detail }), "utf8")
    res.writeHead(status, { "content-type": "application/json", "content-length": String(bytes.byteLength) })
    res.end(bytes)
  }

  /** A JSON body carrying `messages`/`input`/`instructions` — enough for the fail-closed gate. */
  function looksLikeModelCall(raw: Buffer): boolean {
    try {
      const b = JSON.parse(raw.toString("utf8")) as Record<string, unknown>
      return b["messages"] !== undefined || b["input"] !== undefined || b["instructions"] !== undefined
    } catch {
      return false
    }
  }

  async function pump(body: ReadableStream<Uint8Array>, res: ServerResponse): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      Readable.fromWeb(body as never)
        .on("error", reject)
        .on("end", resolve)
        .pipe(res)
    })
  }

  /**
   * The loopback control surface. Two routes and no more, both read-only
   * about secrets: `status` for a hook that wants to know whether anything
   * is masking, and `mask` so a hook's OWN event carries the same tokens
   * the provider was given (D6 — the OGR client is an egress too).
   */
  async function control(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const reply = (status: number, payload: unknown): void => {
      const bytes = Buffer.from(JSON.stringify(payload), "utf8")
      res.writeHead(status, { "content-type": "application/json", "content-length": String(bytes.byteLength) })
      res.end(bytes)
    }
    if (url.pathname === "/__ogr/status") {
      return reply(200, {
        ok: true,
        upstream: fallback,
        ruleset: pipe.redactor.rulesetId,
        masking: pipe.redactor.masking && pipe.redactor.ready,
        sessions: pipe.knownSessions().length,
        counters: pipe.counters,
      })
    }
    if (url.pathname === "/__ogr/mask" && req.method === "POST") {
      const raw = await readBody(req)
      let body: { value?: unknown; session?: string }
      try {
        body = JSON.parse(raw.toString("utf8") || "{}") as typeof body
      } catch {
        return reply(400, { error: "bad_json" })
      }
      // `maskKnown`, never `mask`: this side must not MINT. A hook sees the
      // harness's own transcript, which is a COPY of what the provider was
      // sent — minting from it would allocate a second token for a value the
      // request half already named, and the two would never restore alike.
      const session = body.session ?? pipe.knownSessions()[0] ?? "process"
      const masked = pipe.redactor.maskKnown(session, body.value ?? null)
      return reply(200, {
        value: masked.value,
        changed: masked.changed,
        ...(pipe.report(session) ? { redaction: pipe.report(session) } : {}),
      })
    }
    return reply(404, { error: "not_found" })
  }

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", resolve))
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0

  let idleTimer: NodeJS.Timeout | undefined
  if (opts.idleMs && opts.idleMs > 0) {
    idleTimer = setInterval(() => {
      if (nowMs() - lastActivity > opts.idleMs!) {
        log.info("[ogr-local] idle — shutting down")
        void close()
      }
    }, Math.min(opts.idleMs, 30_000))
    idleTimer.unref?.()
  }

  const close = async (): Promise<void> => {
    if (idleTimer) clearInterval(idleTimer)
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  return { url: `http://127.0.0.1:${port}`, port, pipe, close }
}

export type { Server }
