/**
 * A stand-in for an OGR v0.8 runtime: `/v1/evaluate` and `/v1/heartbeat`,
 * STRICT about the wire. Every evaluate body is checked against the v0.8
 * GuardEvent contract — exactly the required fields, no extras
 * (`additionalProperties: false`), no v0.6/v0.7 leftovers — and a violation
 * both answers 400 (as a conformant runtime must) and lands in
 * `violations` so the test fails loudly instead of passing by accident.
 */
import { createServer } from "node:http"

/** The v0.8 GuardEvent required field set — no others beyond OPTIONAL_FIELDS. */
const REQUIRED_FIELDS = [
  "agent_id",
    "agent_type",
  "agent_user",
  "agent_workspace",
  "kind",
  "llm_protocol",
  "payload",
  "step_id",
]

/**
 * The one OPTIONAL field (2026-08-17): `integration`, the reporter's own
 * `"name/version"`.
 *
 * ⚠️ Still `additionalProperties: false` — this list is an ALLOWLIST, not a
 * relaxation. An unknown key is a violation exactly as before; the change is
 * that a missing `integration` is not, which is what lets a runtime and a
 * reporter roll forward independently.
 */
const OPTIONAL_FIELDS = ["integration"]

const KINDS = new Set(["step/request", "step/response"])
const PROTOCOLS = new Set(["openai.chat", "openai.responses", "anthropic.messages", "canonical"])

/** Every way one event body can violate the v0.8 schema, as strings. */
export function violationsOf(event) {
  const problems = []
  const keys = Object.keys(event).sort()
  const missing = REQUIRED_FIELDS.filter((f) => !keys.includes(f))
  const extra = keys.filter((k) => !REQUIRED_FIELDS.includes(k) && !OPTIONAL_FIELDS.includes(k))
  if (missing.length || extra.length) {
    problems.push(
      `field set is [${keys.join(", ")}]` +
        (missing.length ? `, missing [${missing.join(", ")}]` : "") +
        (extra.length ? `, unexpected [${extra.join(", ")}]` : ""),
    )
  }
  if (!KINDS.has(event.kind)) problems.push(`kind ${JSON.stringify(event.kind)}`)
  if (typeof event.step_id !== "string" || event.step_id.length === 0) {
    problems.push(`step_id ${JSON.stringify(event.step_id)}`)
  }
  for (const f of ["agent_id", "agent_type", "agent_workspace", "agent_user"]) {
    if (typeof event[f] !== "string") problems.push(`${f} is ${typeof event[f]}, not string`)
  }
  if (!PROTOCOLS.has(event.llm_protocol)) problems.push(`llm_protocol ${JSON.stringify(event.llm_protocol)}`)
  if (typeof event.payload !== "object" || event.payload === null || Array.isArray(event.payload)) {
    problems.push("payload is not an object")
  }
  return problems
}

/**
 * @param decide - maps a received wire event to a verdict; return a string
 *   for the decision alone, or an object `{decision, findings, unjudged,
 *   modifications}` to control the whole verdict.
 */
export async function startMockRuntime(decide = () => "allow") {
  const received = []
  const heartbeats = []
  const violations = []
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
        const problems = violationsOf(json)
        if (problems.length > 0) {
          violations.push(...problems)
          return reply(400, { error: "invalid_event", details: problems })
        }
        if (failNext > 0) { failNext -= 1; return reply(503, { error: "unavailable" }) }
        const outcome = decide(json)
        const v = typeof outcome === "string" ? { decision: outcome } : outcome
        return reply(200, {
          event_id: `evt-${received.length}`,
          provider: "mock-runtime",
          decision: v.decision ?? "allow",
          findings: v.findings ?? [],
          ...v.modifications ? { modifications: v.modifications } : {},
          ...v.unjudged ? { unjudged: v.unjudged } : {},
        })
      }
      if (req.url.endsWith("/v1/heartbeat")) {
        heartbeats.push(json)
        if (!json.integration && !json.agent_id) {
          violations.push("heartbeat carried neither integration nor agent_id")
          return reply(400, { error: "invalid_body" })
        }
        return reply(200, { ok: true })
      }
      reply(404, { error: "not found" })
    })
  })

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address()

  return {
    url: `http://127.0.0.1:${port}`,
    received,
    heartbeats,
    /** Schema violations across every call — a conformance test asserts []. */
    violations,
    /** Make the next N evaluate calls fail, to exercise the degraded paths. */
    failNextEvaluate(n) { failNext = n },
    async close() { await new Promise((resolve) => server.close(resolve)) },
  }
}
