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

import { zstdCompressSync, gzipSync } from "node:zlib"
import { connect } from "node:net"

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
      content: [{ type: "tool_use", id: "t1", name: "deploy", input: { token: "OGRK00000001" } }],
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
      assert.match(provider.seen[0].body, /OGRK00000001/)
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
    res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"token\\":\\"OGRK00000001\\"}"}}\n\n')
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
    assert.equal(value.text, "the key is OGRK00000001", "a value the request half already named must reuse its token")
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
    const body = gzipSync(JSON.stringify({ content: [{ type: "tool_use", id: "t1", name: "d", input: { token: "OGRK00000001" } }] }))
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

test("a zstd-compressed model request (Codex 0.153) is decoded, masked, and forwarded plain", async () => {
  // Found with mitmproxy behind the proxy on 2026-09-11: Codex sends
  // `content-encoding: zstd`, JSON.parse failed on the bytes, and the body
  // took the non-model-call pass-through — every credential in the clear,
  // status reading `masking: true`.
  await withProxy(jsonReply({ id: "resp_1", output: [] }), async ({ proxy, provider }) => {
    const body = JSON.stringify({
      model: "gpt-6", stream: false, store: false, prompt_cache_key: "01a0-codex-session",
      input: [{ role: "user", content: [{ type: "input_text", text: `use ${KEY} for the deploy` }] }],
    })
    const res = await fetch(`${proxy.url}/http/127.0.0.1:${provider.port}/backend-api/codex/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "zstd", authorization: "Bearer x" },
      body: zstdCompressSync(Buffer.from(body)),
    })
    assert.equal(res.status, 200)
    const sent = provider.seen[0]
    assert.equal(sent.headers["content-encoding"], undefined, "the upstream must get the decoded body, without the encoding header")
    assert.equal(sent.body.includes(KEY), false, "the credential reached the provider inside a compressed body")
    assert.match(sent.body, /OGRK00000001/)
    assert.equal(proxy.pipe.counters.passed, 0)
    assert.equal(proxy.pipe.counters.requests, 1)
    // gzip takes the same door
    const res2 = await fetch(`${proxy.url}/http/127.0.0.1:${provider.port}/backend-api/codex/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      body: gzipSync(Buffer.from(body)),
    })
    assert.equal(res2.status, 200)
    assert.equal(provider.seen[1].body.includes(KEY), false)
  })
})

test("a JSON model request the proxy cannot read is REFUSED, never forwarded", async () => {
  await withProxy(jsonReply({ ok: true }), async ({ proxy, provider }) => {
    // An encoding this build does not undo …
    const a = await fetch(`${proxy.url}/http/127.0.0.1:${provider.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "lz4" },
      body: Buffer.from("whatever"),
    })
    assert.equal(a.status, 415)
    assert.equal((await a.json()).error, "ogr_local_unreadable_body")
    // … and a body that claims to be JSON and is not.
    const b = await fetch(`${proxy.url}/http/127.0.0.1:${provider.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json " + KEY,
    })
    assert.equal(b.status, 415)
    assert.equal(provider.seen.length, 0, "nothing may reach the provider")
    assert.equal(proxy.pipe.counters.unreadable, 2)
  })
})

test("the proxy's session is the bare session id a hook is handed — Claude Code's JSON stamp included", async () => {
  // Claude Code 2.x: metadata.user_id = '{"device_id":…,"account_uuid":…,"session_id":"<uuid>"}';
  // the PreToolUse hook asks /__ogr/mask with the bare <uuid>. Keyed by the whole
  // stamp, the lookup found nothing and the hook's event carried the plaintext.
  await withProxy(jsonReply({ id: "msg", content: [] }), async ({ proxy, provider }) => {
    const sid = "484d2bc1-b7e9-4f28-9d97-d08777526aa6"
    const stamp = JSON.stringify({ device_id: "0e2d", account_uuid: "dc62", session_id: sid })
    await fetch(`${proxy.url}/http/127.0.0.1:${provider.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude", metadata: { user_id: stamp }, messages: [{ role: "user", content: `token ${KEY}` }] }),
    })
    assert.deepEqual(proxy.pipe.knownSessions(), [sid])
    const masked = await (await fetch(`${proxy.url}/__ogr/mask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: sid, value: { tool_calls: [{ name: "Bash", arguments: { command: `printf ${KEY}` } }] } }),
    })).json()
    assert.equal(masked.changed, true, "the hook's event must carry the token the provider was given")
    assert.equal(masked.value.tool_calls[0].arguments.command, "printf OGRK00000001")
    assert.deepEqual(masked.redaction.masked, [{ token: "OGRK00000001", rule: "entity_api_key/openai_project" }])
    // The claim is about THIS event: a second hook event that carries no token claims none —
    // the drained per-step report would have named the request's values here.
    const plain = await (await fetch(`${proxy.url}/__ogr/mask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: sid, value: { tool_calls: [{ name: "Bash", arguments: { command: "ls" } }] } }),
    })).json()
    assert.deepEqual(plain.redaction.masked, [])
    assert.equal(plain.redaction.ruleset, "rs_proxytest")
    // Codex: no user field; prompt_cache_key IS the session the hooks are handed.
    await fetch(`${proxy.url}/http/127.0.0.1:${provider.port}/backend-api/codex/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-6", prompt_cache_key: "codex-sess-1", input: [{ role: "user", content: [{ type: "input_text", text: KEY }] }] }),
    })
    assert.ok(proxy.pipe.knownSessions().includes("codex-sess-1"))
  })
})

test("a websocket upgrade is refused on the loopback, not forwarded as a GET", async () => {
  await withProxy(jsonReply({ ok: true }), async ({ proxy, provider }) => {
    const reply = await new Promise((resolve, reject) => {
      const sock = connect(proxy.port, "127.0.0.1", () => {
        sock.write(
          `GET /http/127.0.0.1:${provider.port}/backend-api/codex/responses HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        )
      })
      let buf = ""
      sock.on("data", (c) => { buf += c })
      sock.on("end", () => resolve(buf))
      sock.on("error", reject)
    })
    assert.match(reply, /^HTTP\/1\.1 405 /)
    assert.match(reply, /ogr_local_websocket_unsupported/)
    assert.equal(provider.seen.length, 0, "the provider must not see the upgrade as a plain GET")
    assert.equal(proxy.pipe.counters.upgrades_refused, 1)
  })
})

test("an SSE reply with NO content-type (the ChatGPT Codex backend) is still restored", async () => {
  const sse = (_req, res) => {
    // Exactly what chatgpt.com/backend-api/codex/responses sends: chunked, typeless.
    res.writeHead(200, {})
    res.write(`event: response.custom_tool_call_input.done\ndata: ${JSON.stringify({ type: "response.custom_tool_call_input.done", output_index: 0, input: "run(\"OGRK00000001\")" })}\n\n`)
    res.write(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "r", output: [{ type: "custom_tool_call", input: "run(\"OGRK00000001\")" }] } })}\n\n`)
    res.end()
  }
  await withProxy(sse, async ({ proxy, provider }) => {
    const res = await fetch(`${proxy.url}/http/127.0.0.1:${provider.port}/backend-api/codex/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ model: "gpt-6", stream: true, prompt_cache_key: "s1", input: [{ role: "user", content: [{ type: "input_text", text: KEY }] }] }),
    })
    const text = await res.text()
    assert.equal(text.includes("OGRK00000001"), false, "the harness got a tool call it cannot run")
    const inputs = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)))
    assert.equal(inputs[0].input, `run("${KEY}")`)
    assert.equal(inputs[1].response.output[0].input, `run("${KEY}")`)
    assert.equal(proxy.pipe.counters.streams, 1)
    assert.equal(proxy.pipe.counters.restored, 1)
  })
})
