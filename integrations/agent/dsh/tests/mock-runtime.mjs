/**
 * A stand-in for an OGR v0.7 runtime: `/v1/evaluate` and `/v1/ingest`, plus a
 * record of every event received so a test can assert on what the plugin
 * actually sent. No `/v1/enroll` — enrollment left the protocol in v0.7.
 */
import { createServer } from "node:http"

/**
 * @param decide - maps a received wire event to a verdict; return a string
 *   for the decision alone, or an object `{decision, findings, unjudged,
 *   modifications}` to control the whole verdict.
 */
export async function startMockRuntime(decide = () => "allow") {
  const received = []
  const ingested = []
  let failNext = 0

  const server = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => { body += c })
    req.on("end", () => {
      const json = body ? JSON.parse(body) : {}
      const reply = (status, payload) => {
        res.writeHead(status, { "content-type": "application/json" })
        res.end(JSON.stringify(payload))
      }

      if (req.url.endsWith("/v1/evaluate")) {
        received.push(json)
        if (failNext > 0) { failNext -= 1; return reply(503, { error: "unavailable" }) }
        const outcome = decide(json)
        const v = typeof outcome === "string" ? { decision: outcome } : outcome
        return reply(200, {
          ogr_version: "0.7",
          event_id: `ev-${received.length}`,
          provider: "mock-runtime",
          decision: v.decision ?? "allow",
          // Echo the declared coordinates, as a conformant runtime must.
          ...json.session_id !== undefined ? { session_id: json.session_id } : {},
          ...json.turn !== undefined ? { turn: json.turn } : {},
          ...json.step !== undefined ? { step: json.step } : {},
          attribution: json.turn !== undefined ? "declared" : "derived",
          findings: v.findings ?? [],
          ...v.modifications ? { modifications: v.modifications } : {},
          ...v.unjudged ? { unjudged: v.unjudged } : {},
        })
      }
      if (req.url.endsWith("/v1/ingest")) {
        for (const e of json.batch ?? []) { received.push(e); ingested.push(e) }
        return reply(207, {
          results: (json.batch ?? []).map((_e, i) => ({ id: `ev-in-${i}`, status: 201 })),
        })
      }
      reply(404, { error: "not found" })
    })
  })

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address()

  return {
    url: `http://127.0.0.1:${port}`,
    received,
    ingested,
    /** Make the next N evaluate calls fail, to exercise the degraded paths. */
    failNextEvaluate(n) { failNext = n },
    /** Every event of one kind, in arrival order. */
    of(kind) { return received.filter((e) => e.kind === kind) },
    async close() { await new Promise((resolve) => server.close(resolve)) },
  }
}

/**
 * Boot the plugin with a mock runtime wired in through the environment (the
 * plugin reads OGR_RUNTIME_URL/OGR_API_KEY when `apply` runs), and restore
 * the environment afterwards.
 */
export async function withRuntime(bootFn, config, decide, body) {
  const runtime = await startMockRuntime(decide)
  const saved = { ...process.env }
  process.env.OGR_RUNTIME_URL = runtime.url
  process.env.OGR_API_KEY = "ogr_mockmockmockmockmockmockmock"
  try {
    const booted = await bootFn(config)
    return await body({ ...booted, runtime })
  } finally {
    process.env = saved
    await runtime.close()
  }
}
