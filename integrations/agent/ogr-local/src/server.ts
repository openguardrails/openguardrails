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
import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from "node:zlib"

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

/**
 * A request body the proxy can read, whatever the harness compressed it with.
 *
 * ⚠️⚠️ **CODEX SENDS ITS MODEL REQUESTS `content-encoding: zstd`, AND A BODY
 * THE PROXY CANNOT PARSE WAS FORWARDED VERBATIM** (2026-09-11, Codex 0.153,
 * found with mitmproxy behind the proxy: every seeded credential — user
 * prompt, AGENTS.md, tool output, the tool call itself — reached chatgpt.com
 * in the clear while the daemon's status read `masking: true`). The
 * pass-through exists for calls that are NOT model calls (token counts,
 * model lists); a compressed model call fell into it because `JSON.parse`
 * on zstd bytes fails exactly like a non-JSON body does. So the encoding is
 * undone HERE, before the body is looked at, and a body that still cannot
 * be read is refused (below) rather than forwarded — for this proxy, "could
 * not read it" must never mean "nothing to mask".
 *
 * Returns the decoded bytes, or `null` for an encoding this build cannot
 * undo. The upstream gets the decoded body (the header is dropped with the
 * hop-by-hop set); re-encoding would buy a few KB on loopback and one more
 * way to be wrong.
 */
export function decodeRequestBody(raw: Buffer, encoding: string | undefined): Buffer | null {
  const enc = (encoding ?? "").trim().toLowerCase()
  if (enc === "" || enc === "identity") return raw
  try {
    if (enc === "gzip" || enc === "x-gzip") return gunzipSync(raw)
    if (enc === "deflate") return inflateSync(raw)
    if (enc === "br") return brotliDecompressSync(raw)
    if (enc === "zstd") return zstdDecompressSync(raw)
  } catch {
    return null
  }
  return null
}

const JSON_TYPES = /^application\/(?:json|.*\+json)\b/i

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
  /**
   * Which plugin's build this is, e.g. `ogr-claude-code/2.1.0`.
   *
   * ⚠️ Both plugins ship their own bundle and both reach for the SAME port,
   * so whichever harness starts first is the one whose build ends up masking
   * for the other. That is fine — the masking contract is the SERVED ruleset,
   * not the code — but it must not be invisible: without this, "which build
   * is masking my Codex session" has no answer at all.
   */
  servedBy?: string
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

    // -- the body the proxy is going to READ --
    const encoding = req.headers["content-encoding"]
    const decoded = decodeRequestBody(raw, Array.isArray(encoding) ? encoding[0] : encoding)
    if (decoded === null) {
      // ⚠️ REFUSED, NEVER FORWARDED. A model host given a body this proxy
      // could not open is the one failure the proxy exists to prevent, and
      // it would look — to the harness, to the daemon's counters, to the
      // runtime — exactly like a request with nothing in it to mask.
      pipe.counters.unreadable += 1
      log.warn(`[ogr-local] refused a request with content-encoding ${String(encoding)} this build cannot decode`)
      return refuse(res, 415, "ogr_local_unreadable_body", `content-encoding ${String(encoding)} is not one this proxy can decode; the body was NOT forwarded`)
    }
    if (decoded !== raw) headers.delete("content-encoding")
    const contentType = String(req.headers["content-type"] ?? "")

    // -- the request half --
    let plan = null as ReturnType<Pipe["mask"]>
    let out: Buffer | undefined = decoded.length > 0 ? decoded : undefined
    if (decoded.length > 0) {
      if (!pipe.redactor.ready) {
        // No ruleset: the honest choices are "forward, loudly" and "refuse".
        // Forwarding is the default because a proxy that stops the harness
        // is a proxy nobody keeps installed — and an unmasked request is
        // exactly what the harness did before this existed.
        if (opts.failClosed && looksLikeModelCall(decoded)) {
          res.writeHead(503, { "content-type": "application/json" })
          res.end(JSON.stringify({ error: "ogr_local_unprotected", detail: "no secret ruleset in hand and the deployment is fail-closed" }))
          return
        }
        pipe.redactor.warnUnprotected("this model request")
      }
      const text = decoded.toString("utf8")
      plan = pipe.mask(target, headers, text)
      if (plan) out = Buffer.from(plan.body, "utf8")
      else {
        // ⚠️ A JSON body that did not parse is not "not a model call" — it is
        // a body this proxy could not read, and the same rule as an unknown
        // encoding applies: refuse, count, say so. Bodies that parse and merely
        // sniff as something other than a model call keep passing through.
        if (JSON_TYPES.test(contentType) && !parses(text)) {
          pipe.counters.unreadable += 1
          log.warn(`[ogr-local] refused an application/json request whose body does not parse — NOT forwarded`)
          return refuse(res, 415, "ogr_local_unreadable_body", "the JSON body does not parse; it was NOT forwarded to the model host")
        }
        pipe.counters.passed += 1
      }
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

    // ⚠️ THE CHATGPT CODEX BACKEND ANSWERS WITH NO content-type AT ALL (2026-09-11:
    // `Transfer-Encoding: chunked` and nothing else), so "is this a stream" cannot
    // be read off the reply alone: a stream taken for a buffered JSON reply fails
    // to parse and is passed through with every tool argument still tokenised.
    // The REQUEST said what it wanted — `accept: text/event-stream`, or
    // `"stream": true` in the body — and a typeless reply to such a request is
    // a stream.
    const wantsSse =
      String(req.headers["accept"] ?? "").includes("text/event-stream") || /"stream"\s*:\s*true/.test(plan.body)
    const isSse = type.includes("text/event-stream") || (!type.includes("json") && wantsSse)
    if (isSse) {
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

  function parses(text: string): boolean {
    try {
      JSON.parse(text)
      return true
    } catch {
      return false
    }
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
        served_by: opts.servedBy ?? "",
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
      // OGR 1.6: where this session's last model request was dialled — the proxy is
      // the one thing on this host that saw the URL, so the hook cannot know it otherwise.
      const endpoint = pipe.hostFor(session)
      // ⚠️ THE CLAIM IS ABOUT THIS EVENT: the tokens present in the value the hook
      // is about to send, each with the rule it was minted under. The drained
      // per-step `report()` is the interceptor's shape (it builds the request AND
      // the event); read here it named the previous REQUEST's values — not in a
      // tool-call event at all — so the runtime, which counts only tokens that
      // occur in the body, credited every hook event with zero (2026-09-11). It was
      // also read twice, and it drains, so the second read was always empty.
      const redaction = pipe.reportFor(session, masked.value)
      return reply(200, {
        value: masked.value,
        changed: masked.changed,
        ...(redaction ? { redaction } : {}),
        ...(endpoint ? { llm_endpoint: endpoint } : {}),
      })
    }
    return reply(404, { error: "not_found" })
  }

  /**
   * ⚠️ A WEBSOCKET UPGRADE IS ANSWERED HERE, NOT FORWARDED. Codex 0.153 opens
   * its `/responses` channel as a websocket first and only falls back to the
   * POST + SSE shape this proxy can mask when the upgrade fails — and with the
   * `Upgrade` header dropped as hop-by-hop the daemon was forwarding those as
   * plain GETs, seven 405s from the provider per session before the fallback
   * (measured 2026-09-11). Refusing on the loopback saves the round trips and
   * says why. A masked websocket channel is a separate piece of work; until it
   * exists, refusing is the only answer that keeps the mask on the path.
   */
  server.on("upgrade", (_req, socket) => {
    pipe.counters.upgrades_refused += 1
    const body = JSON.stringify({ error: "ogr_local_websocket_unsupported", detail: "this proxy masks HTTP request bodies only; the harness falls back to POST" })
    socket.end(
      `HTTP/1.1 405 Method Not Allowed\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
    )
  })

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
