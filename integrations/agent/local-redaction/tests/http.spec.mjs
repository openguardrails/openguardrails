/**
 * The HTTP interceptor, end to end against a local stand-in provider: the
 * outbound body is masked whole (system prompt included) with the harness's
 * own headers untouched; the reply is restored inside tool-call arguments
 * only, streamed or not; anything that is not a model call passes through
 * byte-identical; and a tool call before any traffic yields no `redaction`
 * report.
 */
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import {
  installHttpInterceptor,
  interceptorStatus,
  LocalRedactor,
  uninstallHttpInterceptor,
  writeCachedRuleset,
} from "../dist/index.js"

const corpus = JSON.parse(readFileSync(new URL("../conformance/local-redaction.json", import.meta.url), "utf8"))
const AWS = "AKIAIOSFODNN7EXAMPLE"
const OPENAI = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789"

/** A redactor holding the conformance ruleset from its cache — no network. */
async function redactorWith(over = {}) {
  const cachePath = join(mkdtempSync(join(tmpdir(), "ogr-http-")), "rules.json")
  writeCachedRuleset(cachePath, corpus.ruleset)
  const logs = []
  const red = new LocalRedactor({ source: () => null, cachePath, log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) }, ...over })
  await red.start()
  red.logs = logs
  return red
}

/**
 * The stand-in provider. `reply(path, body, req)` returns `{ status, headers,
 * body }` or `{ sse: [frames...] }`; the received requests are recorded.
 */
async function provider(reply) {
  const received = []
  const server = createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      received.push({ url: req.url, method: req.method, headers: req.headers, raw })
      const r = reply(req.url, raw, req)
      if (r.sse) {
        res.writeHead(200, { "content-type": "text/event-stream", ...(r.headers ?? {}) })
        let i = 0
        const tick = () => {
          if (i >= r.sse.length) return res.end()
          res.write(r.sse[i++])
          setTimeout(tick, 2)
        }
        tick()
        return
      }
      res.writeHead(r.status ?? 200, { "content-type": "application/json", ...(r.headers ?? {}) })
      res.end(r.body ?? "{}")
    })
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { url: `http://127.0.0.1:${server.address().port}`, received, close: () => new Promise((r) => server.close(r)) }
}

const echo = (url, raw) => ({ body: JSON.stringify({ echo: raw }) })

const install = (redactor, over = {}) => installHttpInterceptor({ redactor, installFetch: false, undici: false, ...over })

test("openai.chat: the body is masked whole, the system prompt included, and the two headers ride the request", async () => {
  const red = await redactorWith()
  const p = await provider(echo)
  const h = install(red)
  try {
    const body = {
      model: "gpt-4.1",
      messages: [
        { role: "system", content: `You hold ${AWS}.` },
        { role: "user", content: [{ type: "text", text: `use ${OPENAI}` }] },
        { role: "tool", tool_call_id: "c1", content: `${AWS}\n` },
      ],
      tools: [{ type: "function", function: { name: "bash", description: `never print ${AWS}`, parameters: {} } }],
    }
    const res = await h.fetch(`${p.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sk-provider-key-stays" },
      body: JSON.stringify(body),
    })
    assert.equal(res.status, 200)
    const [req] = p.received
    const sent = JSON.parse(req.raw)
    assert.equal(sent.messages[0].content, "You hold ${OGR_SECRET_1}.")
    assert.equal(sent.messages[1].content[0].text, "use ${OGR_SECRET_2}")
    assert.equal(sent.messages[2].content, "${OGR_SECRET_1}\n")
    assert.equal(sent.tools[0].function.description, "never print ${OGR_SECRET_1}")
    assert.equal(sent.model, "gpt-4.1")
    assert.ok(!req.raw.includes(AWS) && !req.raw.includes(OPENAI))
    assert.equal(req.headers.authorization, "Bearer sk-provider-key-stays")
    assert.ok(!Object.keys(req.headers).some((k) => k.startsWith("x-ogr-"))) // nothing rides the request
    assert.equal(req.headers["content-length"], String(Buffer.byteLength(req.raw)))
    assert.ok(h.sawTraffic)
    assert.equal(h.status().requests, 1)
    assert.deepEqual(h.sessions(), ["process"])
    // The minted report is drained by the next event of any host session.
    assert.deepEqual(red.report("host-session").masked.map((m) => m.token), ["${OGR_SECRET_1}", "${OGR_SECRET_2}"])
  } finally {
    h.uninstall()
    await p.close()
  }
})

test("anthropic.messages: the top-level system prompt and tool_result blocks are masked; the stamped metadata.user_id keys the session", async () => {
  const red = await redactorWith()
  const p = await provider(echo)
  const h = install(red)
  try {
    await h.fetch(`${p.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "provider" },
      body: JSON.stringify({
        model: "claude",
        system: [{ type: "text", text: `key ${AWS}` }],
        metadata: { user_id: "u-42" },
        messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "text", text: `.env: ${OPENAI}` }] }] }],
      }),
    })
    const sent = JSON.parse(p.received[0].raw)
    assert.equal(sent.system[0].text, "key ${OGR_SECRET_1}")
    assert.equal(sent.messages[0].content[0].content[0].text, ".env: ${OGR_SECRET_2}")
    assert.equal(sent.metadata.user_id, "u-42")
    assert.deepEqual(h.sessions(), ["u-42"])
    assert.equal(red.session("u-42").valueOf("${OGR_SECRET_1}"), AWS)
  } finally {
    h.uninstall()
    await p.close()
  }
})

test("non-streaming reply: restored inside tool-call arguments, never in prose; content-length follows the new body; a value with a quote stays valid JSON", async () => {
  const red = await redactorWith()
  const p = await provider((url) => {
    if (url.endsWith("/chat/completions")) {
      return {
        body: JSON.stringify({
          id: "c",
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: "I used ${OGR_SECRET_1} and ${OGR_SECRET_2}",
              tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: '{"cmd":"aws --key ${OGR_SECRET_1} --pw ${OGR_SECRET_2} --missing ${OGR_SECRET_9}"}' } }],
            },
            finish_reason: "tool_calls",
          }],
        }),
      }
    }
    return { body: JSON.stringify({ content: [{ type: "text", text: "${OGR_SECRET_1}" }, { type: "tool_use", id: "t", name: "bash", input: { cmd: "echo ${OGR_SECRET_1}", nested: ["${OGR_SECRET_2}"] } }] }) }
  })
  const h = install(red)
  try {
    red.session("process").tokenFor('pa"ss')
    await h.fetch(`${p.url}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "m", messages: [{ role: "user", content: `k ${AWS}` }] }) })
    // ${OGR_SECRET_1} = pa"ss (seeded), ${OGR_SECRET_2} = AWS (masked out of the request)
    const res = await h.fetch(`${p.url}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "again" }] }) })
    const text = await res.text()
    assert.equal(res.headers.get("content-length"), String(Buffer.byteLength(text)))
    const reply = JSON.parse(text)
    assert.equal(reply.choices[0].message.content, "I used ${OGR_SECRET_1} and ${OGR_SECRET_2}")
    assert.deepEqual(JSON.parse(reply.choices[0].message.tool_calls[0].function.arguments), { cmd: `aws --key pa"ss --pw ${AWS} --missing \${OGR_SECRET_9}` })
    assert.deepEqual(h.status().unrestorable, ["${OGR_SECRET_9}"])
    assert.equal(h.status().restored, 2) // both replies carried a restorable argument

    const a = await h.fetch(`${p.url}/v1/messages`, { method: "POST", body: JSON.stringify({ model: "m", system: "x", messages: [{ role: "user", content: "hi" }] }) })
    const reply2 = await a.json()
    assert.equal(reply2.content[0].text, "${OGR_SECRET_1}")
    assert.deepEqual(reply2.content[1].input, { cmd: 'echo pa"ss', nested: [AWS] })
  } finally {
    h.uninstall()
    await p.close()
  }
})

const chatChunk = (delta, finish = null) =>
  `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
const ev = (name, payload) => `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`

test("streamed reply (openai.chat): an argument split across three deltas is restored through the wrapped body; prose deltas are not", async () => {
  const red = await redactorWith()
  const p = await provider(() => ({
    sse: [
      chatChunk({ role: "assistant", content: "key: ${OGR_SECRET_1}" }),
      chatChunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: "" } }] }),
      chatChunk({ tool_calls: [{ index: 0, function: { arguments: '{"cmd":"aws --key ${OGR_SE' } }] }),
      chatChunk({ tool_calls: [{ index: 0, function: { arguments: "CRET_1" } }] }),
      chatChunk({ tool_calls: [{ index: 0, function: { arguments: '} ls"}' } }] }),
      chatChunk({}, "tool_calls"),
      "data: [DONE]\n\n",
    ],
  }))
  const h = install(red)
  try {
    const res = await h.fetch(`${p.url}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: `k ${AWS}` }] }) })
    assert.equal(res.headers.get("content-type"), "text/event-stream")
    const text = await res.text()
    const data = text.split("\n\n").filter((f) => f.startsWith("data:")).map((f) => f.slice(6))
    assert.equal(data.at(-1), "[DONE]")
    const parsed = data.slice(0, -1).map((d) => JSON.parse(d))
    assert.equal(parsed[0].choices[0].delta.content, "key: ${OGR_SECRET_1}")
    const args = parsed.flatMap((c) => c.choices[0].delta.tool_calls ?? []).map((tc) => tc.function?.arguments ?? "").join("")
    assert.deepEqual(JSON.parse(args), { cmd: `aws --key ${AWS} ls` })
    assert.equal(h.status().streams, 1)
    assert.equal(h.status().restored, 1)
  } finally {
    h.uninstall()
    await p.close()
  }
})

test("streamed reply (anthropic.messages): input_json_delta across three deltas restores; text_delta keeps its placeholder", async () => {
  const red = await redactorWith()
  const p = await provider(() => ({
    sse: [
      ev("message_start", { type: "message_start", message: { id: "m", role: "assistant", content: [] } }),
      ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "using ${OGR_SECRET_1}" } }),
      ev("content_block_stop", { type: "content_block_stop", index: 0 }),
      ev("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t", name: "bash", input: {} } }),
      ev("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"cmd": "echo ${OGR_' } }),
      ev("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "SECRET_1" } }),
      ev("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '}"}' } }),
      ev("content_block_stop", { type: "content_block_stop", index: 1 }),
      ev("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" } }),
      ev("message_stop", { type: "message_stop" }),
    ],
  }))
  const h = install(red)
  try {
    const res = await h.fetch(`${p.url}/v1/messages`, { method: "POST", body: JSON.stringify({ model: "m", stream: true, system: "s", messages: [{ role: "user", content: `k ${AWS}` }] }) })
    const text = await res.text()
    const data = text.split("\n\n").filter(Boolean).map((f) => JSON.parse(f.split("\n").find((l) => l.startsWith("data:")).slice(6)))
    const json = data.filter((d) => d.type === "content_block_delta" && d.delta.type === "input_json_delta").map((d) => d.delta.partial_json).join("")
    assert.deepEqual(JSON.parse(json), { cmd: `echo ${AWS}` })
    assert.equal(data.find((d) => d.delta?.type === "text_delta").delta.text, "using ${OGR_SECRET_1}")
  } finally {
    h.uninstall()
    await p.close()
  }
})

test("what is not a model call passes through byte-identical, headers untouched: a GET, a non-JSON POST, a JSON POST without a model shape", async () => {
  const red = await redactorWith()
  const p = await provider(echo)
  const h = install(red)
  try {
    const evaluate = JSON.stringify({ kind: "step/response", payload: { tool_calls: [{ name: "bash", arguments: { command: `echo ${AWS}` } }] }, messages_note: "not an array" })
    await h.fetch(`${p.url}/v1/evaluate`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer ogr_key" }, body: evaluate })
    await h.fetch(`${p.url}/upload`, { method: "POST", headers: { "content-type": "text/plain" }, body: `plain ${AWS}` })
    await h.fetch(`${p.url}/v1/models?q=${encodeURIComponent(AWS)}`)
    assert.equal(p.received[0].raw, evaluate)
    assert.equal(p.received[1].raw, `plain ${AWS}`)
    assert.equal(p.received[2].method, "GET")
    for (const r of p.received) assert.ok(!Object.keys(r.headers).some((k) => k.startsWith("x-ogr-")))
    assert.equal(h.sawTraffic, false)
    assert.equal(h.status().requests, 0)
  } finally {
    h.uninstall()
    await p.close()
  }
})

test("a Request object and a streamed request body are both read, masked and forwarded", async () => {
  const red = await redactorWith()
  const p = await provider(echo)
  const h = install(red)
  try {
    const req = new Request(`${p.url}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "m", messages: [{ role: "user", content: AWS }] }) })
    await h.fetch(req)
    const stream = new Blob([JSON.stringify({ model: "m", messages: [{ role: "user", content: OPENAI }] })]).stream()
    await h.fetch(`${p.url}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: stream, duplex: "half" })
    assert.equal(JSON.parse(p.received[0].raw).messages[0].content, "${OGR_SECRET_1}")
    assert.equal(JSON.parse(p.received[1].raw).messages[0].content, "${OGR_SECRET_2}")
  } finally {
    h.uninstall()
    await p.close()
  }
})

test("the self-check: a tool call before any traffic warns once and yields no redaction report; after traffic, the report is back", async () => {
  const red = await redactorWith()
  const p = await provider(echo)
  const misses = []
  const h = install(red, { onMiss: () => misses.push(1) })
  try {
    assert.equal(h.noteToolCall(), false)
    assert.equal(h.noteToolCall(), false)
    assert.equal(misses.length, 1)
    assert.equal(red.masking, false)
    assert.equal(red.report("sess"), undefined)
    // The hook fallback, when a plugin engages it, is the other proof.
    red.fallbackActive = true
    assert.deepEqual(red.report("sess"), { ruleset: corpus.ruleset.id, masked: [] })
    red.fallbackActive = false
    await h.fetch(`${p.url}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "m", messages: [{ role: "user", content: AWS }] }) })
    assert.equal(h.noteToolCall(), true)
    assert.deepEqual(red.report("sess"), { ruleset: corpus.ruleset.id, masked: [{ token: "${OGR_SECRET_1}", rule: "entity_aws_key_id/aws_access_key_id" }] })
    // …and restoreArgs on the host's session reaches the interceptor's map.
    assert.deepEqual(red.restoreArgs("sess", { k: "${OGR_SECRET_1}" }), { args: { k: AWS }, unresolved: [], changed: true })
  } finally {
    h.uninstall()
    await p.close()
  }
})

test("no ruleset in hand: `proceed` masks known values and warns, `refuse` throws", async () => {
  const cachePath = join(mkdtempSync(join(tmpdir(), "ogr-http-")), "none.json")
  const logs = []
  const red = new LocalRedactor({ source: () => null, cachePath, log: { info: () => {}, warn: (m) => logs.push(m) } })
  await red.start()
  const p = await provider(echo)
  const h = install(red)
  try {
    await h.fetch(`${p.url}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "m", messages: [{ role: "user", content: AWS }] }) })
    assert.equal(JSON.parse(p.received[0].raw).messages[0].content, AWS)
    assert.ok(logs.some((m) => /no ruleset obtained yet/.test(m)))
    h.uninstall()
    const strict = install(red, { unprotected: "refuse" })
    await assert.rejects(
      strict.fetch(`${p.url}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "x" }] }) }),
      /fail-closed/,
    )
    strict.uninstall()
  } finally {
    await p.close()
  }
})

test("installing on globalThis wraps fetch, a second install replaces the first, uninstall restores the original", async () => {
  const original = globalThis.fetch
  const red = await redactorWith()
  const a = installHttpInterceptor({ redactor: red, undici: false })
  assert.equal(globalThis.fetch, a.fetch)
  assert.equal(interceptorStatus().fetch, "wrapped")
  assert.equal(red.http, a)
  const b = installHttpInterceptor({ redactor: red, undici: false })
  assert.equal(a.status().installed, false)
  assert.equal(globalThis.fetch, b.fetch)
  uninstallHttpInterceptor()
  assert.equal(globalThis.fetch, original)
  assert.equal(interceptorStatus().installed, false)
  assert.equal(red.http, null)
})
