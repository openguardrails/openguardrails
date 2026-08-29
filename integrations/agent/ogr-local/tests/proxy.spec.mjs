/**
 * The proxy, driven end to end against a stand-in provider.
 *
 * The claim under test is the one the whole design rests on: **the provider
 * is given a token and the harness is given back the value**. Everything
 * else here guards a way that could stop being true without anything
 * failing — a passthrough that quietly rewrote a non-model call, an SSE
 * reply whose tool arguments came back still tokenised, an upstream the
 * path could name freely.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { LocalRedactor } from "@openguardrails/local-redaction"
import { startProxy, upstreamFor, baseUrlFor } from "../dist/index.js"

const KEY = "sk-proj-abcdefghijklmnopqrstuvwx"

const RULESET = {
  id: "rs_proxytest",
  generated_at: "2026-08-29T00:00:00Z",
  family: "secrets",
  dialect: "ogr-re-1",
  rules: [{
    id: "entity_api_key",
    category: "secrets",
    severity: "critical",
    tier: "strong",
    flags: "",
    patterns: [{ id: "openai_project", source: "sk-proj-[A-Za-z0-9_-]{20,}" }],
    examples: { match: [KEY], nomatch: ["sk-proj-short"] },
  }],
}

/** A provider that records what it was sent and replies as told. */
async function startProvider(reply) {
  const seen = []
  const server = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => { body += c })
    req.on("end", () => {
      seen.push({ url: req.url, body, headers: req.headers })
      reply(req, res, body)
    })
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  return { seen, port: server.address().port, close: () => new Promise((r) => server.close(r)) }
}

async function withProxy(reply, body) {
  const dir = mkdtempSync(join(tmpdir(), "ogr-local-"))
  const provider = await startProvider(reply)
  const redactor = new LocalRedactor({
    // The ruleset comes from a file rather than a served route: this suite
    // is about the PROXY, and a fetch in the middle of it would make a
    // masking failure and a rules-outage failure look alike.
    source: () => null,
    cachePath: join(dir, "rules.json"),
    log: { info: () => {}, warn: () => {} },
  })
  // Seed the cache, then start: exactly the "warm install" path.
  const { writeCachedRuleset } = await import("@openguardrails/local-redaction")
  writeCachedRuleset(join(dir, "rules.json"), RULESET)
  await redactor.start()
  redactor.fallbackActive = true

  const proxy = await startProxy({
    redactor,
    hosts: ["127.0.0.1"],
    log: { info: () => {}, warn: () => {} },
  })
  try {
    return await body({ proxy, provider, redactor })
  } finally {
    await proxy.close()
    await provider.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

const jsonReply = (payload) => (_req, res) => {
  const bytes = Buffer.from(JSON.stringify(payload))
  res.writeHead(200, { "content-type": "application/json", "content-length": String(bytes.length) })
  res.end(bytes)
}

test("the provider gets a token; the harness gets the value back", async () => {
  await withProxy(
    jsonReply({
      id: "msg_1",
      content: [{ type: "tool_use", id: "t1", name: "deploy", input: { token: "${OGR_SECRET_1}" } }],
    }),
    async ({ proxy, provider }) => {
      const res = await fetch(`${proxy.url}/http/127.0.0.1:${provider.port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer sk-ant-user-key" },
        body: JSON.stringify({ model: "claude", system: `use ${KEY}`, messages: [{ role: "user", content: "deploy" }] }),
      })
      const back = await res.json()

      // What the provider saw
      assert.equal(provider.seen[0].body.includes(KEY), false, "the credential reached the provider")
      assert.match(provider.seen[0].body, /\$\{OGR_SECRET_1\}/)
      // What the harness got back — the real value, in the tool's arguments
      assert.equal(back.content[0].input.token, KEY)
    },
  )
})

test("the harness's own credential is forwarded untouched — the proxy is not an auth boundary", async () => {
  await withProxy(jsonReply({ ok: true }), async ({ proxy, provider }) => {
    await fetch(`${proxy.url}/http/127.0.0.1:${provider.port}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sk-ant-user-key",
        "x-api-key": "another-form-of-the-same-thing",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: "claude", messages: [{ role: "user", content: "hi" }] }),
    })
    const sent = provider.seen[0].headers
    // The proxy holds no credential and mints none: whatever the harness
    // authenticated with reaches the provider byte for byte, and a
    // provider-specific header it has never heard of survives too.
    assert.equal(sent.authorization, "Bearer sk-ant-user-key")
    assert.equal(sent["x-api-key"], "another-form-of-the-same-thing")
    assert.equal(sent["anthropic-version"], "2023-06-01")
    // ...and the hop-by-hop ones do not.
    assert.equal(sent.host, `127.0.0.1:${provider.port}`, "the Host header must name the UPSTREAM, not the proxy")
    assert.equal("connection" in sent && sent.connection === "keep-alive, keep-alive", false)
  })
})

test("a non-model call is passed through byte for byte", async () => {
  await withProxy(jsonReply({ data: [] }), async ({ proxy, provider }) => {
    const body = JSON.stringify({ anything: `not a model call, but it mentions ${KEY}` })
    await fetch(`${proxy.url}/http/127.0.0.1:${provider.port}/v1/models`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    })
    // ⚠️ The harness talks to its provider about more than completions. A
    // proxy that masked a token-count or a file upload would break the
    // harness while protecting nothing — the value is not going to a model.
    assert.equal(provider.seen[0].body, body)
  })
})

test("a streamed reply comes back with its tool arguments restored", async () => {
  const sse = (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"deploy","input":{}}}\n\n')
    res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"token\\":\\"${OGR_SECRET_1}\\"}"}}\n\n')
    res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n')
    res.end()
  }
  await withProxy(sse, async ({ proxy, provider }) => {
    const res = await fetch(`${proxy.url}/http/127.0.0.1:${provider.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude", system: `use ${KEY}`, messages: [{ role: "user", content: "go" }], stream: true }),
    })
    const text = await res.text()
    assert.equal(provider.seen[0].body.includes(KEY), false)
    assert.equal(text.includes(KEY), true, "the streamed tool call reached the harness still tokenised")
  })
})

test("the path may only name a model API host", async () => {
  await withProxy(jsonReply({ ok: true }), async ({ proxy }) => {
    const res = await fetch(`${proxy.url}/https/evil.example.com/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "x", messages: [] }),
    })
    // Without this the daemon would be a general-purpose forwarder any
    // process on the machine could reach.
    assert.equal(res.status, 403)
  })
})

test("/__ogr/mask tokenises a hook's own event, and never mints", async () => {
  await withProxy(jsonReply({ ok: true }), async ({ proxy, provider }) => {
    await fetch(`${proxy.url}/http/127.0.0.1:${provider.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude", system: `use ${KEY}`, messages: [{ role: "user", content: "go" }] }),
    })
    const res = await fetch(`${proxy.url}/__ogr/mask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: { text: `the key is ${KEY}`, other: "sk-proj-neverseenbeforeaaaaaaaa" } }),
    })
    const { value, redaction } = await res.json()
    assert.equal(value.text, "the key is ${OGR_SECRET_1}", "a value the request half already named must reuse its token")
    assert.equal(value.other, "sk-proj-neverseenbeforeaaaaaaaa",
      "the control surface must not MINT — a second token for a value the provider never saw restores to nothing")
    assert.equal(redaction.ruleset, RULESET.id)
  })
})

test("there is no /__ogr/restore", async () => {
  await withProxy(jsonReply({ ok: true }), async ({ proxy }) => {
    const res = await fetch(`${proxy.url}/__ogr/restore`, { method: "POST", body: "{}" })
    // A loopback route that turned tokens back into secrets would hand every
    // process on this machine the plaintext of the session.
    assert.equal(res.status, 404)
  })
})

test("the upstream is read from the path, and the base URL is derivable", () => {
  const at = (p) => upstreamFor(new URL(`http://127.0.0.1:8787${p}`), null)
  assert.deepEqual(at("/https/api.anthropic.com/v1/messages"),
    { base: "https://api.anthropic.com", path: "/v1/messages", host: "api.anthropic.com", hostname: "api.anthropic.com" })
  assert.deepEqual(at("/https/chatgpt.com/backend-api/codex/responses"),
    { base: "https://chatgpt.com", path: "/backend-api/codex/responses", host: "chatgpt.com", hostname: "chatgpt.com" })
  assert.equal(at("/v1/messages"), null)
  assert.equal(upstreamFor(new URL("http://127.0.0.1:8787/v1/messages"), "https://api.anthropic.com").base,
    "https://api.anthropic.com")
  assert.equal(baseUrlFor("https://api.anthropic.com", 8787), "http://127.0.0.1:8787/https/api.anthropic.com")
  assert.equal(baseUrlFor("https://chatgpt.com/backend-api/codex", 8787),
    "http://127.0.0.1:8787/https/chatgpt.com/backend-api/codex")
})

test("a decompressed reply does not keep the provider's content-encoding", async () => {
  const { gzipSync } = await import("node:zlib")
  const gz = (_req, res) => {
    const body = gzipSync(JSON.stringify({ content: [{ type: "tool_use", id: "t1", name: "d", input: { token: "${OGR_SECRET_1}" } }] }))
    res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip", "content-length": String(body.length) })
    res.end(body)
  }
  await withProxy(gz, async ({ proxy, provider }) => {
    const res = await fetch(`${proxy.url}/http/127.0.0.1:${provider.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude", system: `use ${KEY}`, messages: [{ role: "user", content: "go" }] }),
    })
    // `fetch` decompressed it, so the bytes we forward are plain. Keeping the
    // provider's header would hand the harness a body it cannot decode.
    assert.equal(res.headers.get("content-encoding"), null)
    const back = await res.json()
    assert.equal(back.content[0].input.token, KEY)
  })
})

test("a client that hangs up mid-stream does not take the daemon down", async () => {
  // The provider keeps the stream open; the TEST is what releases it, so the
  // fixture can tear down even though the scenario is "nobody ended this".
  const open = []
  const slow = (_req, res) => {
    open.push(res)
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.write('event: x\ndata: {"a":1}\n\n')
  }
  await withProxy(slow, async ({ proxy, provider }) => {
    const controller = new AbortController()
    const started = fetch(`${proxy.url}/http/127.0.0.1:${provider.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude", messages: [{ role: "user", content: "go" }], stream: true }),
      signal: controller.signal,
    })
    const res = await started
    await res.body.getReader().read()
    controller.abort()
    await new Promise((r) => setTimeout(r, 120))
    // Still serving. A daemon outlives the request that killed it, and an
    // unhandled socket `error` would have taken the harness's model access
    // down with the proxy.
    const status = await fetch(`${proxy.url}/__ogr/status`)
    assert.equal(status.ok, true)
    for (const res of open) res.end()
  })
})
