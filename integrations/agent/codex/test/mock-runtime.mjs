// A STRICT v0.8 mock OGR runtime (node:http, offline), shared by both hook
// suites. It rejects any GuardEvent deviating from
// schema/guard-event.schema.json — the nine required fields plus the one
// optional `integration`, nothing else, no retired v0.6/v0.7 fields — and records every violation so a wire
// regression fails the run loudly instead of hiding behind fail-open.
import { createServer } from "node:http"

export const API_KEY = "ogr_test"

// The required set from schema/guard-event.schema.json. The schema also has
// additionalProperties:false, so the only keys allowed beyond these are the
// optional ones below.
const EVENT_KEYS = [
  "kind", "step_id", "agent_id", "agent_type", "agent_workspace",
  "agent_user", "llm_protocol", "payload",
].sort()

// The one OPTIONAL field (2026-08-17): `integration`, the reporter's own
// "name/version". An ALLOWLIST, not a relaxation — an unknown key is still a
// violation; only a MISSING `integration` stopped being one, which is what lets
// a runtime and a reporter roll forward independently.
const OPTIONAL_EVENT_KEYS = ["integration"]

function validateEvent(ev) {
  const errs = []
  const keys = Object.keys(ev).sort()
  const missing = EVENT_KEYS.filter((k) => !keys.includes(k))
  const extra = keys.filter((k) => !EVENT_KEYS.includes(k) && !OPTIONAL_EVENT_KEYS.includes(k))
  if (missing.length || extra.length) {
    errs.push(`key set is [${keys}], missing [${missing}], unexpected [${extra}]`)
  }
  if (!["step/request", "step/response"].includes(ev.kind)) errs.push(`kind ${ev.kind}`)
  if (typeof ev.step_id !== "string" || !ev.step_id) errs.push("step_id must be a non-empty string")
  for (const f of ["agent_id", "agent_type", "agent_workspace", "agent_user"]) {
    if (typeof ev[f] !== "string") errs.push(`${f} must be a string`)
  }
  if (!["openai.chat", "openai.responses", "anthropic.messages", "canonical"].includes(ev.llm_protocol)) {
    errs.push(`llm_protocol ${ev.llm_protocol}`)
  }
  // Presence is optional on the WIRE; for THESE hooks it is mandatory — the mock
  // tolerating a missing `integration` must not let ours stop sending it.
  if (!/^ogr-codex(-automode)?\/[0-9]/.test(String(ev.integration))) {
    errs.push(`integration ${ev.integration}`)
  }
  if (typeof ev.payload !== "object" || ev.payload === null || Array.isArray(ev.payload)) {
    errs.push("payload must be an object")
  }
  return errs
}

export async function startMockRuntime() {
  const state = {
    verdictHandler: () => ({
      status: 200,
      body: { event_id: "evt_1", provider: "mock-runtime", decision: "allow" },
    }),
    requests: [],
    violations: [],
  }
  const server = createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {}
      state.requests.push({ path: req.url, body, auth: req.headers.authorization ?? "" })
      if (req.url !== "/v1/evaluate") {
        state.violations.push(`unexpected path ${req.url} (v0.8 has no other event path)`)
        res.writeHead(404).end()
        return
      }
      const errs = validateEvent(body)
      if (req.headers.authorization !== `Bearer ${API_KEY}`) errs.push(`bad auth '${req.headers.authorization}'`)
      if (errs.length) {
        state.violations.push(...errs)
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: "invalid_event", details: errs }))
        return
      }
      const { status, body: out } = state.verdictHandler(body)
      res.writeHead(status, { "content-type": "application/json" })
      res.end(JSON.stringify(out))
    })
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  state.url = `http://127.0.0.1:${server.address().port}`
  state.close = () => server.close()
  return state
}

export const allowVerdict = (extra = {}) => () => ({
  status: 200,
  body: { event_id: "evt_1", provider: "mock-runtime", decision: "allow", ...extra },
})
