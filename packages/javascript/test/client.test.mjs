// RuntimeClient tests against a local node:http server — wire shapes, error
// mapping, and the canonical camelCase↔snake_case converters.
import assert from "node:assert/strict"
import { generateKeyPairSync, verify } from "node:crypto"
import { createServer } from "node:http"
import { readFileSync } from "node:fs"
import { after, before, beforeEach, test } from "node:test"

import {
  INGEST_BATCH_MAX,
  OGR_VERSION,
  RateLimitedError,
  RuntimeApiError,
  RuntimeClient,
  createNodeSigner,
  eventToWire,
  verdictFromWire,
} from "../dist/index.js"

const guardEventSchema = JSON.parse(
  readFileSync(new URL("../../../schema/guard-event.schema.json", import.meta.url), "utf8"),
)

function makeEvent(extra = {}) {
  return {
    kind: "tool_call",
    observationPoint: "invocation",
    subject: { agent_id: "test-agent" },
    payload: { name: "bash", arguments: { command: "ls" } },
    eventId: "evt-1",
    guardId: "ga-1",
    timestamp: "2026-08-11T00:00:00Z",
    provenance: [],
    ...extra,
  }
}

// --- eventToWire / verdictFromWire ------------------------------------------

test("eventToWire emits every schema-required key and never event_id", () => {
  const wire = eventToWire(makeEvent())
  for (const key of guardEventSchema.required) {
    assert.ok(key in wire, `missing required wire key: ${key}`)
  }
  assert.equal(wire.ogr_version, OGR_VERSION)
  assert.equal(wire.ogr_version, "0.6")
  // OGR v0.6: event identity is born at the runtime — a locally minted
  // eventId must NEVER reach the wire. guard_id rides only as a hint.
  assert.ok(!("event_id" in wire))
  assert.equal(wire.guard_id, "ga-1")
  assert.equal(wire.observation_point, "invocation")
})

test("eventToWire sends the minimal event as exactly {ogr_version, kind, payload}", () => {
  const wire = eventToWire({ kind: "exec", payload: { argv: ["ls"] }, provenance: [] })
  assert.deepEqual(Object.keys(wire).sort(), ["kind", "ogr_version", "payload"])
})

test("eventToWire drops empty optionals and maps provenance", () => {
  const bare = eventToWire(makeEvent())
  for (const key of ["session_id", "llm_protocol", "provenance", "sensor"]) {
    assert.ok(!(key in bare), `empty optional leaked onto the wire: ${key}`)
  }
  const full = eventToWire(
    makeEvent({
      sessionId: "s1",
      llmProtocol: "anthropic.messages",
      sensor: { id: "test-sensor", class: "in_process" },
      provenance: [{ source: "web", trust: "untrusted", taintTags: ["injection"] }],
    }),
  )
  assert.equal(full.session_id, "s1")
  assert.equal(full.llm_protocol, "anthropic.messages")
  assert.deepEqual(full.sensor, { id: "test-sensor", class: "in_process" })
  assert.deepEqual(full.provenance, [{ source: "web", trust: "untrusted", taint_tags: ["injection"] }])
})

test("eventToWire passes extension fields through verbatim", () => {
  const wire = eventToWire(makeEvent({ run_id: "r1", turn: 3, authz: { scope: "repo" }, "x.ogr.custom": true }))
  assert.equal(wire.run_id, "r1")
  assert.equal(wire.turn, 3)
  assert.deepEqual(wire.authz, { scope: "repo" })
  assert.equal(wire["x.ogr.custom"], true)
})

test("verdictFromWire maps snake_case and passes extension keys through", () => {
  const verdict = verdictFromWire({
    ogr_version: "0.6",
    event_id: "evt-1",
    guard_id: "ga-1",
    provider: "runtime",
    decision: "block",
    categories: [{ id: "security.exfiltration", domain: "security", score: 0.9 }],
    reasons: ["nope"],
    latency_ms: 12,
    "x.ogr.session_id": "sess-9",
    modifications: { kind: "redact" },
  })
  assert.equal(verdict.eventId, "evt-1")
  assert.equal(verdict.guardId, "ga-1")
  assert.equal(verdict.decision, "block")
  assert.equal(verdict.latencyMs, 12)
  assert.equal(verdict.ogrVersion, "0.6")
  assert.equal(verdict["x.ogr.session_id"], "sess-9")
  assert.deepEqual(verdict.modifications, { kind: "redact" })
  assert.deepEqual(verdict.categories, [{ id: "security.exfiltration", domain: "security", score: 0.9 }])
})

// --- RuntimeClient against a local server ------------------------------------

let server
let baseUrl
let rootUrl
let requests
// Per-test handler: (req, body) => { status, json } — default 200 {}.
let handler

before(async () => {
  server = createServer((req, res) => {
    let raw = ""
    req.on("data", (chunk) => (raw += chunk))
    req.on("end", () => {
      const record = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: raw ? JSON.parse(raw) : null,
        rawBody: raw,
      }
      requests.push(record)
      const out = handler(record) ?? { status: 200, json: {} }
      if (out.hang) return // never respond: exercises the client timeout
      res.writeHead(out.status ?? 200, { "content-type": out.contentType ?? "application/json" })
      res.end(out.text ?? JSON.stringify(out.json ?? {}))
    })
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  rootUrl = `http://127.0.0.1:${server.address().port}`
  // A prefixed base URL proves the client appends canonical /v1 paths to it.
  baseUrl = `${rootUrl}/api/public/ogr`
})

after(() => server.close())

beforeEach(() => {
  requests = []
  handler = () => ({ status: 200, json: {} })
})

function client(options = {}) {
  return new RuntimeClient({ baseUrl, apiKey: "ogr_test", ...options })
}

test("evaluate posts one wire event to <prefix>/v1/evaluate and maps the verdict", async () => {
  handler = () => ({
    status: 200,
    json: {
      ogr_version: "0.6",
      event_id: "evt-1",
      guard_id: "ga-1",
      provider: "runtime",
      decision: "allow",
      reasons: ["no finding"],
      "x.ogr.session_id": "sess-1",
    },
  })
  const verdict = await client().evaluate(makeEvent())
  assert.equal(requests.length, 1)
  assert.equal(requests[0].method, "POST")
  assert.equal(requests[0].url, "/api/public/ogr/v1/evaluate")
  assert.equal(requests[0].headers.authorization, "Bearer ogr_test")
  assert.equal(requests[0].headers["content-type"], "application/json")
  assert.equal(requests[0].headers["ogr-partial"], undefined)
  // v0.6: no client event id on the wire; the verdict is where the id is learned.
  assert.equal(requests[0].body.event_id, undefined)
  assert.equal(requests[0].body.ogr_version, "0.6")
  assert.equal(verdict.decision, "allow")
  assert.equal(verdict.eventId, "evt-1")
  assert.equal(verdict["x.ogr.session_id"], "sess-1")
})

test("evaluate with {partial: true} sends the ogr-partial header", async () => {
  handler = () => ({
    status: 200,
    json: { event_id: "evt-1", guard_id: "ga-1", provider: "runtime", decision: "allow" },
  })
  await client().evaluate(makeEvent(), { partial: true })
  assert.equal(requests[0].headers["ogr-partial"], "1")
})

test("401 maps to RuntimeApiError with status, code and body", async () => {
  handler = () => ({ status: 401, json: { error: "unauthorized" } })
  await assert.rejects(client().evaluate(makeEvent()), (err) => {
    assert.ok(err instanceof RuntimeApiError)
    assert.ok(!(err instanceof RateLimitedError))
    assert.equal(err.status, 401)
    assert.equal(err.code, "unauthorized")
    assert.deepEqual(err.body, { error: "unauthorized" })
    return true
  })
})

test("429 maps to RateLimitedError with the limit", async () => {
  handler = () => ({ status: 429, json: { error: "rate_limited", limit: 100 } })
  await assert.rejects(client().evaluate(makeEvent()), (err) => {
    assert.ok(err instanceof RateLimitedError)
    assert.ok(err instanceof RuntimeApiError)
    assert.equal(err.status, 429)
    assert.equal(err.limit, 100)
    return true
  })
})

test("400 invalid_event keeps the details on the error body", async () => {
  handler = () => ({ status: 400, json: { error: "invalid_event", details: ["subject: required"] } })
  await assert.rejects(client().evaluate(makeEvent()), (err) => {
    assert.ok(err instanceof RuntimeApiError)
    assert.equal(err.code, "invalid_event")
    assert.deepEqual(err.body.details, ["subject: required"])
    return true
  })
})

test("ingest posts {batch} and parses the always-207 results", async () => {
  handler = () => ({
    status: 207,
    json: {
      results: [
        { id: "evt-1", status: 200 },
        { id: "evt-2", status: 400, error: "invalid_event" },
      ],
    },
  })
  const results = await client().ingest([makeEvent(), makeEvent({ guardId: "ga-2" })])
  assert.equal(requests[0].url, "/api/public/ogr/v1/ingest")
  assert.equal(requests[0].body.batch.length, 2)
  // v0.6: ids come back in the ordered results, never go up in the batch.
  assert.equal(requests[0].body.batch[1].event_id, undefined)
  assert.equal(requests[0].body.batch[1].guard_id, "ga-2")
  assert.deepEqual(results, [
    { id: "evt-1", status: 200 },
    { id: "evt-2", status: 400, error: "invalid_event" },
  ])
})

test("ingest refuses a batch over the maximum", async () => {
  const events = Array.from({ length: INGEST_BATCH_MAX + 1 }, (_, i) => makeEvent({ eventId: `evt-${i}` }))
  await assert.rejects(client().ingest(events), RangeError)
  assert.equal(requests.length, 0)
})

test("enroll posts snake_case and returns {pepId, keyId}", async () => {
  handler = () => ({ status: 200, json: { pep_id: "pep-77", key_id: "key-9" } })
  const cred = await client().enroll({ publicKey: "pubkey-b64url", pepId: "my-hook", name: "my hook" })
  assert.equal(requests[0].url, "/api/public/ogr/v1/enroll")
  assert.deepEqual(requests[0].body, { public_key: "pubkey-b64url", pep_id: "my-hook", name: "my hook" })
  assert.deepEqual(cred, { pepId: "pep-77", keyId: "key-9" })
})

test("heartbeat and getApproval hit their endpoints", async () => {
  handler = (req) => {
    if (req.url.endsWith("/v1/heartbeat")) return { status: 200, json: { ok: true } }
    return { status: 200, json: { status: "approved" } }
  }
  const c = client()
  assert.deepEqual(await c.heartbeat(), { ok: true })
  const approval = await c.getApproval("ga one/2")
  assert.deepEqual(approval, { status: "approved" })
  assert.equal(requests[1].method, "GET")
  assert.equal(requests[1].url, "/api/public/ogr/v1/approvals?guard_id=ga%20one%2F2")
})

test("a signer adds a verifiable ogr-batch-signature to evaluate and ingest", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const signer = await createNodeSigner(privateKey, "key-1")
  handler = (req) => {
    if (req.url.endsWith("/v1/ingest")) return { status: 207, json: { results: [] } }
    return { status: 200, json: { event_id: "evt-1", guard_id: "ga-1", provider: "r", decision: "allow" } }
  }
  const c = client({ signer })
  await c.evaluate(makeEvent())
  await c.ingest([makeEvent()])

  for (const req of requests) {
    const sig = req.headers["ogr-batch-signature"]
    assert.ok(sig, `unsigned request to ${req.url}`)
    const [header, middle, signature] = sig.split(".")
    assert.equal(middle, "", "expected detached-JWS 'header..signature' form")
    assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), {
      alg: "EdDSA",
      kid: "key-1",
      b64: false,
      crit: ["b64"],
    })
    const signed = Buffer.concat([Buffer.from(header, "ascii"), Buffer.from("."), Buffer.from(req.rawBody)])
    assert.ok(verify(null, signed, publicKey, Buffer.from(signature, "base64url")), "bad Ed25519 signature")
  }
})

test("createNodeSigner accepts JWK {d, x} key material", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const jwk = privateKey.export({ format: "jwk" })
  const signer = await createNodeSigner({ d: jwk.d, x: jwk.x }, "key-2")
  const body = Buffer.from(JSON.stringify({ batch: [] }))
  const [header, , signature] = signer.sign(body).split(".")
  const signed = Buffer.concat([Buffer.from(header, "ascii"), Buffer.from("."), body])
  assert.ok(verify(null, signed, publicKey, Buffer.from(signature, "base64url")))
})

// --- mount-compat fallback ----------------------------------------------------

const ALLOW_VERDICT = { event_id: "evt-1", guard_id: "ga-1", provider: "runtime", decision: "allow" }

test("a route-level 404 on a canonical path falls back to /api/public/ogr and caches the mount", async () => {
  handler = (req) =>
    req.url.startsWith("/api/public/ogr/v1/")
      ? { status: 200, json: ALLOW_VERDICT }
      : { status: 404, contentType: "text/plain", text: "Not Found" }
  const c = new RuntimeClient({ baseUrl: rootUrl, apiKey: "ogr_test" })

  const verdict = await c.evaluate(makeEvent())
  assert.equal(verdict.decision, "allow")
  assert.deepEqual(
    requests.map((r) => r.url),
    ["/v1/evaluate", "/api/public/ogr/v1/evaluate"],
  )

  // The discovered mount is cached: the next call goes straight to it.
  await c.evaluate(makeEvent())
  assert.equal(requests.length, 3)
  assert.equal(requests[2].url, "/api/public/ogr/v1/evaluate")
})

test("a genuine 404 on both mounts surfaces the canonical error and caches nothing", async () => {
  handler = () => ({ status: 404, contentType: "text/plain", text: "Not Found" })
  const c = new RuntimeClient({ baseUrl: rootUrl, apiKey: "ogr_test" })
  await assert.rejects(c.evaluate(makeEvent()), (err) => {
    assert.ok(err instanceof RuntimeApiError)
    assert.equal(err.status, 404)
    return true
  })
  assert.deepEqual(
    requests.map((r) => r.url),
    ["/v1/evaluate", "/api/public/ogr/v1/evaluate"],
  )
  // No mount was cached — the next request tries the canonical path again.
  await assert.rejects(c.evaluate(makeEvent()), RuntimeApiError)
  assert.equal(requests[2].url, "/v1/evaluate")
})

test("an approvals JSON 404 is an API answer, not a mount miss — no fallback probe", async () => {
  handler = () => ({ status: 404, json: { status: "not_found" } })
  const c = new RuntimeClient({ baseUrl: rootUrl, apiKey: "ogr_test" })
  await assert.rejects(c.getApproval("ga-1"), (err) => {
    assert.ok(err instanceof RuntimeApiError)
    assert.equal(err.status, 404)
    assert.deepEqual(err.body, { status: "not_found" })
    return true
  })
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, "/v1/approvals?guard_id=ga-1")
})

test("an approvals route-level (non-API) 404 still discovers the mount", async () => {
  handler = (req) =>
    req.url.startsWith("/api/public/ogr/v1/")
      ? { status: 200, json: { status: "pending" } }
      : { status: 404, contentType: "text/plain", text: "Not Found" }
  const c = new RuntimeClient({ baseUrl: rootUrl, apiKey: "ogr_test" })
  assert.deepEqual(await c.getApproval("ga-1"), { status: "pending" })
  assert.deepEqual(
    requests.map((r) => r.url),
    ["/v1/approvals?guard_id=ga-1", "/api/public/ogr/v1/approvals?guard_id=ga-1"],
  )
})

test("a base URL already on the compat mount never double-prefixes", async () => {
  handler = () => ({ status: 404, contentType: "text/plain", text: "Not Found" })
  await assert.rejects(client().evaluate(makeEvent()), RuntimeApiError)
  assert.deepEqual(
    requests.map((r) => r.url),
    ["/api/public/ogr/v1/evaluate"],
  )
})

test("a stalled runtime rejects with a timeout error", async () => {
  handler = () => ({ hang: true })
  await assert.rejects(client({ timeoutMs: 100 }).evaluate(makeEvent()), /timed out after 100ms/)
})

test("constructor requires baseUrl and apiKey when env is unset", () => {
  const savedUrl = process.env.OGR_RUNTIME_URL
  const savedKey = process.env.OGR_API_KEY
  delete process.env.OGR_RUNTIME_URL
  delete process.env.OGR_API_KEY
  try {
    assert.throws(() => new RuntimeClient(), /baseUrl/)
    assert.throws(() => new RuntimeClient({ baseUrl: "http://x" }), /apiKey/)
    process.env.OGR_RUNTIME_URL = "http://env-host/prefix/"
    process.env.OGR_API_KEY = "ogr_env"
    assert.doesNotThrow(() => new RuntimeClient())
  } finally {
    if (savedUrl === undefined) delete process.env.OGR_RUNTIME_URL
    else process.env.OGR_RUNTIME_URL = savedUrl
    if (savedKey === undefined) delete process.env.OGR_API_KEY
    else process.env.OGR_API_KEY = savedKey
  }
})
