/**
 * A stand-in for an OGR v0.8 runtime: `/v1/evaluate` and `/v1/heartbeat`,
 * plus a record of everything received so a test can assert on what the
 * plugin actually sent. No `/v1/ingest` — evaluate is the observation
 * channel since v0.8, and a second event path no longer exists.
 *
 * Validation is deliberately STRICT — exactly the schema's event fields,
 * every one required, extras rejected — because that strictness IS the
 * conformance test: `withRuntime` fails any test whose plugin emitted a
 * non-conformant event, so the whole suite doubles as a wire check.
 */
import { createServer } from "node:http"

/** The v0.8 GuardEvent fields — all required, nothing else allowed. */
const EVENT_FIELDS = [
  "kind", "step_id",
  "agent_id", "agent_type", "agent_workspace", "agent_user",
  "llm_protocol", "payload",
]

/**
 * The one OPTIONAL field (2026-08-17): `integration`, the reporter's own
 * `"name/version"`. An ALLOWLIST, not a relaxation — an unknown key is still a
 * violation; only a MISSING `integration` stopped being one, which is what lets
 * a runtime and a reporter roll forward independently.
 */
const OPTIONAL_EVENT_FIELDS = ["integration"]

const KINDS = ["step/request", "step/response"]
const PROTOCOLS = ["openai.chat", "openai.responses", "anthropic.messages", "canonical"]

/** Per-field issues with one event, [] when conformant. */
function eventIssues(e) {
  const issues = []
  for (const f of EVENT_FIELDS) if (!(f in e)) issues.push(`missing ${f}`)
  for (const k of Object.keys(e)) {
    if (!EVENT_FIELDS.includes(k) && !OPTIONAL_EVENT_FIELDS.includes(k)) issues.push(`unexpected ${k}`)
  }
  if ("kind" in e && !KINDS.includes(e.kind)) issues.push(`bad kind ${JSON.stringify(e.kind)}`)
  if ("step_id" in e && (typeof e.step_id !== "string" || e.step_id.length === 0)) issues.push("step_id must be a non-empty string")
  for (const f of ["agent_id", "agent_type", "agent_workspace", "agent_user"]) {
    // The four-tuple is required WITH "" as the explicit no-assertion — a
    // missing field and an empty one are different statements.
    if (f in e && typeof e[f] !== "string") issues.push(`${f} must be a string ("" = no assertion)`)
  }
  if ("llm_protocol" in e && !PROTOCOLS.includes(e.llm_protocol)) issues.push(`bad llm_protocol ${JSON.stringify(e.llm_protocol)}`)
  if ("payload" in e && (typeof e.payload !== "object" || e.payload === null || Array.isArray(e.payload))) issues.push("payload must be an object")
  return issues
}

/**
 * @param decide - maps a received wire event to a verdict; return a string
 *   for the decision alone, or an object `{decision, findings, unjudged,
 *   modifications}` to control the whole verdict.
 */
export async function startMockRuntime(decide = () => "allow") {
  const received = []
  const beats = []
  const invalid = []
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
        const issues = eventIssues(json)
        if (issues.length > 0) {
          invalid.push({ event: json, issues })
          return reply(400, { error: "invalid_event", details: issues })
        }
        received.push(json)
        if (failNext > 0) { failNext -= 1; return reply(503, { error: "unavailable" }) }
        const outcome = decide(json)
        const v = typeof outcome === "string" ? { decision: outcome } : outcome
        // A v0.8 verdict: runtime-born event_id, no coordinate echo, no
        // attribution, no ogr_version — none of that exists any more.
        return reply(200, {
          event_id: `ev-${received.length}`,
          provider: "mock-runtime",
          decision: v.decision ?? "allow",
          findings: v.findings ?? [],
          ...v.modifications ? { modifications: v.modifications } : {},
          ...v.unjudged ? { unjudged: v.unjudged } : {},
          latency_ms: 1,
        })
      }
      if (req.url.endsWith("/v1/heartbeat")) {
        if (json.integration === undefined && json.agent_id === undefined) {
          invalid.push({ event: json, issues: ["heartbeat needs integration or agent_id"] })
          return reply(400, { error: "invalid_body" })
        }
        beats.push(json)
        return reply(200, { ok: true })
      }
      // /v1/ingest falls through here too: it left the protocol in v0.8, so
      // a plugin that still calls it sees the 404 a v0.8 runtime would give.
      reply(404, { error: "not found" })
    })
  })

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address()

  return {
    url: `http://127.0.0.1:${port}`,
    received,
    beats,
    invalid,
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
 * the environment afterwards. The OGR_AGENT_* claim variables are cleared so
 * the four-tuple defaults under test are the plugin's, not the developer's
 * shell's. Any event the mock rejected fails the test — conformance is not
 * optional.
 */
export async function withRuntime(bootFn, config, decide, body) {
  const runtime = await startMockRuntime(decide)
  const saved = { ...process.env }
  process.env.OGR_RUNTIME_URL = runtime.url
  process.env.OGR_API_KEY = "ogr_mockmockmockmockmockmockmock"
  delete process.env.OGR_AGENT_WORKSPACE
  delete process.env.OGR_AGENT_USER
  try {
    const booted = await bootFn(config)
    const result = await body({ ...booted, runtime })
    if (runtime.invalid.length > 0) {
      const first = runtime.invalid[0]
      throw new Error(
        `mock runtime rejected ${runtime.invalid.length} request(s); first: ${first.issues.join("; ")}`,
      )
    }
    return result
  } finally {
    process.env = saved
    await runtime.close()
  }
}
