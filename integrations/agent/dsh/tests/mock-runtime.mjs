/**
 * A stand-in for an OGR runtime: enough of `/v1/enroll` and `/v1/evaluate` to
 * exercise the developer path hermetically, plus a record of every event it
 * received so a test can assert on what the plugin actually sent.
 */
import { createServer } from "node:http"

/**
 * @param decide - maps a received wire event to a verdict decision; return a
 *   string for the decision alone, or an object to control the whole verdict.
 */
export async function startMockRuntime(decide = () => "allow") {
  const received = []
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

      if (req.url.endsWith("/v1/enroll")) {
        return reply(200, { pep_id: "pep-mock", key_id: "key-mock" })
      }
      if (req.url.endsWith("/v1/evaluate")) {
        received.push(json)
        if (failNext > 0) { failNext -= 1; return reply(503, { error: "unavailable" }) }
        const outcome = decide(json)
        const v = typeof outcome === "string" ? { decision: outcome } : outcome
        return reply(200, {
          event_id: `ev-${received.length}`,
          guard_id: `ev-${received.length}`,
          provider: "mock-runtime",
          decision: v.decision ?? "allow",
          categories: v.categories ?? [],
          reasons: v.reasons ?? [],
        })
      }
      if (req.url.endsWith("/v1/ingest")) {
        for (const e of json.batch ?? []) received.push(e)
        return reply(207, { results: (json.batch ?? []).map(() => ({ status: "ok" })) })
      }
      reply(404, { error: "not found" })
    })
  })

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address()

  return {
    url: `http://127.0.0.1:${port}`,
    received,
    /** Make the next N evaluate calls fail, to exercise the no-verdict paths. */
    failNextEvaluate(n) { failNext = n },
    /** Every event of one kind, in arrival order. */
    of(kind) { return received.filter((e) => e.kind === kind) },
    async close() { await new Promise((resolve) => server.close(resolve)) },
  }
}
