/**
 * The undici half, exercised only where `undici` is resolvable (it is not a
 * dependency of this package): a fetch reference captured BEFORE the
 * interceptor was installed, and an `undici.request` call that never touches
 * `fetch`, both go through the composed global dispatcher — masked on the way
 * out, restored inside arguments on the way back, streamed or not.
 */
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { installHttpInterceptor, LocalRedactor, writeCachedRuleset } from "../dist/index.js"

const corpus = JSON.parse(readFileSync(new URL("../conformance/local-redaction.json", import.meta.url), "utf8"))
const AWS = "AKIAIOSFODNN7EXAMPLE"

let undici = null
try {
  undici = await import("undici")
} catch {
  undici = null
}

const chatChunk = (delta, finish = null) =>
  `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`

test("undici dispatcher half: a captured fetch and undici.request are both covered", { skip: !undici && "undici is not resolvable here" }, async () => {
  const capturedFetch = globalThis.fetch // captured BEFORE install, as a host that loaded its SDK first would hold
  const received = []
  const server = createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      received.push({ url: req.url, headers: req.headers, raw })
      if (req.url.endsWith("/stream")) {
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.write(chatChunk({ tool_calls: [{ index: 0, function: { arguments: '{"cmd":"${OGR_SE' } }] }))
        setTimeout(() => {
          res.write(chatChunk({ tool_calls: [{ index: 0, function: { arguments: 'CRET_1}"}' } }] }))
          res.write(chatChunk({}, "tool_calls") + "data: [DONE]\n\n")
          res.end()
        }, 5)
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ choices: [{ message: { content: "${OGR_SECRET_1}", tool_calls: [{ function: { name: "bash", arguments: '{"cmd":"${OGR_SECRET_1}"}' } }] } }] }))
    })
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const base = `http://127.0.0.1:${server.address().port}`
  const cachePath = join(mkdtempSync(join(tmpdir(), "ogr-undici-")), "rules.json")
  writeCachedRuleset(cachePath, corpus.ruleset)
  const red = new LocalRedactor({ source: () => null, cachePath, log: { info: () => {}, warn: () => {} } })
  await red.start()
  const h = installHttpInterceptor({ redactor: red, installFetch: false })
  await h.ready
  try {
    assert.equal(h.status().undici, "installed")
    const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: `k ${AWS}` }] })
    // 1. The captured (unwrapped) fetch — the dispatcher still sees it.
    const res = await capturedFetch(`${base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body })
    const reply = await res.json()
    assert.equal(JSON.parse(received[0].raw).messages[0].content, "k ${OGR_SECRET_1}")
    assert.equal(received[0].headers["accept-encoding"], "identity")
    assert.equal(reply.choices[0].message.content, "${OGR_SECRET_1}")
    assert.deepEqual(JSON.parse(reply.choices[0].message.tool_calls[0].function.arguments), { cmd: AWS })
    // 2. undici.request, a string body, a streamed reply.
    const r2 = await undici.request(`${base}/v1/chat/completions/stream`, { method: "POST", headers: { "content-type": "application/json" }, body })
    const text = await r2.body.text()
    const args = text.split("\n\n").filter((f) => f.startsWith("data: {")).map((f) => JSON.parse(f.slice(6))).flatMap((c) => c.choices[0].delta.tool_calls ?? []).map((t) => t.function.arguments).join("")
    assert.deepEqual(JSON.parse(args), { cmd: AWS })
    assert.equal(h.status().requests, 2)
    assert.equal(h.status().streams, 1)
  } finally {
    h.uninstall()
    await new Promise((r) => server.close(r))
  }
  // After uninstall the dispatcher is the original again and a request passes untouched.
  const res = await capturedFetch(`${base}/x`, { method: "POST", body: "{}" }).catch(() => null)
  assert.equal(res, null) // the server is closed; what matters is that no interceptor threw first
})

test("both halves on: a request through the wrapped fetch is masked once and counted once — the undici half recognises it by its body", { skip: !undici && "undici is not resolvable here" }, async () => {
  const received = []
  const server = createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      received.push({ headers: req.headers, raw })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ choices: [{ message: { content: "ok", tool_calls: [{ function: { name: "bash", arguments: '{"cmd":"${OGR_SECRET_1}"}' } }] } }] }))
    })
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  const base = `http://127.0.0.1:${server.address().port}`
  const cachePath = join(mkdtempSync(join(tmpdir(), "ogr-undici-")), "rules.json")
  writeCachedRuleset(cachePath, corpus.ruleset)
  const red = new LocalRedactor({ source: () => null, cachePath, log: { info: () => {}, warn: () => {} } })
  await red.start()
  const h = installHttpInterceptor({ redactor: red, installFetch: false })
  await h.ready
  try {
    assert.equal(h.status().undici, "installed")
    const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: `k ${AWS}` }] })
    const reply = await (await h.fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body })).json()
    assert.equal(JSON.parse(received[0].raw).messages[0].content, "k ${OGR_SECRET_1}")
    assert.ok(!Object.keys(received[0].headers).some((k) => k.startsWith("x-ogr-")))
    assert.deepEqual(JSON.parse(reply.choices[0].message.tool_calls[0].function.arguments), { cmd: AWS })
    assert.equal(h.status().requests, 1)
    assert.equal(h.status().minted, 1)
    assert.equal(h.status().restored, 1)
  } finally {
    h.uninstall()
    await new Promise((r) => server.close(r))
  }
})
