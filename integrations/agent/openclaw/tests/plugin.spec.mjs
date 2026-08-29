/**
 * The v0.8 contract, exercised offline: a strict mock runtime (every event
 * checked against the exact ten-field GuardEvent, extras rejected) behind
 * the two OpenClaw hooks, driven exactly as the host calls them —
 * `gateway_start` delivering the config tree, then `before_tool_call` /
 * `message_sending` returning their enforcement objects.
 */
import assert from "node:assert/strict"
import { test } from "node:test"

import plugin from "../dist/index.js"
import { startMockRuntime } from "./mock-runtime.mjs"

let seq = 0

// The environment must not leak a real runtime (or identity claims) into
// what these tests assert — every connection is injected through the config
// tree the way OpenClaw delivers it.
for (const k of Object.keys(process.env)) if (k.startsWith("OGR_")) delete process.env[k]

/** Register the plugin and deliver `options` the way OpenClaw does. */
function bootPlugin(options) {
  const registered = new Map()
  plugin.register({
    on: (hook, handler, opts) => {
      const list = registered.get(hook) ?? []
      list.push({ handler, priority: opts?.priority ?? 0 })
      registered.set(hook, list)
    },
  })
  // What the host does: `before_tool_call` handlers run in priority order,
  // higher first, results merged, stopping at the first `{ block }`
  // (src/plugins/hooks.ts runBeforeToolCall); the single-handler hooks map
  // straight through. `handlers.get(hook)` therefore returns ONE callable.
  const handlers = new Map()
  for (const [hook, list] of registered) {
    list.sort((a, b) => b.priority - a.priority)
    if (hook === "before_tool_call") {
      handlers.set(hook, async (event, ctx) => {
        let acc
        for (const { handler } of list) {
          const next = await handler({ ...event, params: acc?.params ?? event.params }, ctx)
          if (next === undefined) continue
          acc = { params: next.params ?? acc?.params, block: next.block ?? acc?.block, blockReason: next.blockReason ?? acc?.blockReason }
          if (acc.block) break
        }
        return acc
      })
    } else {
      handlers.set(hook, list[0].handler)
    }
  }
  handlers.registered = registered
  handlers.get("gateway_start")({}, {
    config: { plugins: { entries: { openguardrails: { config: options } } } },
  })
  return handlers
}

/** Boot against a mock runtime; returns the hook handlers + the runtime. */
async function boot(decide, options = {}) {
  const runtime = await startMockRuntime(decide)
  const handlers = bootPlugin({
    ...options,
    runtime: { url: runtime.url, apiKey: "ogr_mock", ...options.runtime },
  })
  return { handlers, runtime }
}

/** Drive one tool call through before_tool_call. */
const toolCall = (handlers, command = "ls -la", ctx = {}) =>
  handlers.get("before_tool_call")(
    { toolName: "bash", toolCallId: `call-${++seq}`, params: { command } },
    { sessionKey: "sess-1", ...ctx },
  )

test("an allowed tool call proceeds, and the event is the exact v0.8 wire", async () => {
  const { handlers, runtime } = await boot(() => "allow")
  try {
    assert.equal(await toolCall(handlers), undefined)
    assert.deepEqual(runtime.violations, [])
    assert.equal(runtime.received.length, 1)
    const [event] = runtime.received
    assert.equal(event.kind, "step/response")
    assert.equal(event.llm_protocol, "canonical")
    assert.equal(event.payload.tool_calls[0].name, "bash")
    assert.equal(event.payload.tool_calls[0].id, `call-${seq}`)
    assert.deepEqual(event.payload.tool_calls[0].arguments, { command: "ls -la" })
  } finally {
    await runtime.close()
  }
})

test("session_hint carries the host's sessionKey, on tool calls and outbound messages", async () => {
  const { handlers, runtime } = await boot(() => "allow")
  try {
    await toolCall(handlers)
    // One id per conversation: a second action in the same session names it
    // identically, which is what makes the hint a grouping signal at all.
    await toolCall(handlers)
    await handlers.get("message_sending")({ content: "hi" }, { sessionKey: "sess-1" })
    assert.deepEqual(runtime.received.map((e) => e.session_hint), ["sess-1", "sess-1", "sess-1"])
    assert.deepEqual(runtime.violations, [])
  } finally {
    await runtime.close()
  }
})

test("no sessionKey from the host → no session_hint on the wire", async () => {
  const { handlers, runtime } = await boot(() => "allow")
  try {
    // Never "": an empty optional asserts nothing, while the schema would read
    // it as a session actually named "".
    await handlers.get("before_tool_call")(
      { toolName: "bash", toolCallId: `call-${++seq}`, params: { command: "ls" } },
      {},
    )
    assert.ok(!("session_hint" in runtime.received[0]))
    assert.deepEqual(runtime.violations, [])
  } finally {
    await runtime.close()
  }
})

test("step_id is fresh per held action — never reused", async () => {
  const { handlers, runtime } = await boot(() => "allow")
  try {
    await toolCall(handlers)
    await toolCall(handlers)
    const [a, b] = runtime.received.map((e) => e.step_id)
    assert.ok(a.length > 0 && b.length > 0 && a !== b)
  } finally {
    await runtime.close()
  }
})

test("a blocked tool call is refused in place, reason included", async () => {
  const { handlers, runtime } = await boot(() => ({
    decision: "block",
    findings: [{ category: "security.malicious_command", severity: "critical", action: "block" }],
  }))
  try {
    const result = await toolCall(handlers, "rm -rf / ")
    assert.equal(result.block, true)
    assert.match(result.blockReason, /OpenGuardrails.*security\.malicious_command/)
  } finally {
    await runtime.close()
  }
})

test("a blocked outbound message is cancelled; an allowed one is delivered", async () => {
  const { handlers, runtime } = await boot((event) =>
    String(event.payload.text ?? "").includes("AKIA") ? "block" : "allow")
  try {
    const send = (content) => handlers.get("message_sending")({ content }, { sessionKey: "sess-1" })
    assert.equal(await send("all done!"), undefined)
    const cancelled = await send("your key is AKIA123")
    assert.equal(cancelled.cancel, true)
    assert.equal(cancelled.cancelReason, "openguardrails:block")
    assert.deepEqual(runtime.violations, [])
    assert.deepEqual(runtime.received.map((e) => e.payload.text), ["all done!", "your key is AKIA123"])
  } finally {
    await runtime.close()
  }
})

test("an empty outbound message is not an event", async () => {
  const { handlers, runtime } = await boot(() => "allow")
  try {
    assert.equal(await handlers.get("message_sending")({}, {}), undefined)
    assert.equal(runtime.received.length, 0)
  } finally {
    await runtime.close()
  }
})

test("fail-open is the default: an unanswered evaluate proceeds", async () => {
  const { handlers, runtime } = await boot(() => "allow")
  try {
    runtime.failNextEvaluate(2)
    assert.equal(await toolCall(handlers), undefined)
    assert.equal(await handlers.get("message_sending")({ content: "hi" }, {}), undefined)
  } finally {
    await runtime.close()
  }
})

test("failMode closed: an unanswered evaluate refuses the action", async () => {
  const { handlers, runtime } = await boot(() => "allow", { failMode: "closed" })
  try {
    runtime.failNextEvaluate(2)
    const blocked = await toolCall(handlers)
    assert.equal(blocked.block, true)
    assert.match(blocked.blockReason, /could not be judged.*fail-closed/)
    const cancelled = await handlers.get("message_sending")({ content: "hi" }, {})
    assert.equal(cancelled.cancel, true)
  } finally {
    await runtime.close()
  }
})

test("failMode closed treats a non-empty unjudged as could-not-look", async () => {
  const { handlers, runtime } = await boot(
    () => ({ decision: "allow", unjudged: ["payload.tool_calls.0.arguments.command"] }),
    { failMode: "closed" },
  )
  try {
    const blocked = await toolCall(handlers)
    assert.equal(blocked.block, true)
    assert.match(blocked.blockReason, /unjudged.*fail-closed/)
  } finally {
    await runtime.close()
  }
})

test("the four-tuple defaults to agent_type=openclaw and empty assertions", async () => {
  const { handlers, runtime } = await boot(() => "allow")
  try {
    await toolCall(handlers)
    const [event] = runtime.received
    assert.equal(event.agent_type, "openclaw")
    assert.equal(event.agent_id, "")
    assert.equal(event.agent_workspace, "")
    assert.equal(event.agent_user, "")
  } finally {
    await runtime.close()
  }
})

test("an unasserted agent_id falls back to the host's own, never invented", async () => {
  const { handlers, runtime } = await boot(() => "allow")
  try {
    await toolCall(handlers, "ls", { agentId: "claw-main" })
    assert.equal(runtime.received[0].agent_id, "claw-main")
  } finally {
    await runtime.close()
  }
})

test("configured identity claims ride on every event and beat the host's", async () => {
  const { handlers, runtime } = await boot(() => "allow", {
    runtime: { agentId: "invoice-bot", workspace: "finance-agents", owner: "payments-team", user: "u-8232" },
  })
  try {
    await toolCall(handlers, "ls", { agentId: "claw-main" })
    const [event] = runtime.received
    assert.equal(event.agent_id, "invoice-bot")
    assert.equal(event.agent_type, "openclaw")
    assert.equal(event.agent_workspace, "finance-agents")
    assert.equal(event.agent_user, "u-8232")
    assert.deepEqual(runtime.violations, [])
  } finally {
    await runtime.close()
  }
})

test("guardMessages=false leaves the channel path unjudged", async () => {
  const { handlers, runtime } = await boot(() => "allow", { guardMessages: false })
  try {
    assert.equal(await handlers.get("message_sending")({ content: "hi" }, {}), undefined)
    assert.equal(runtime.received.length, 0)
  } finally {
    await runtime.close()
  }
})

test("a heartbeat with the build id goes out once the runtime is configured", async () => {
  const { runtime } = await boot(() => "allow", { runtime: { agentId: "invoice-bot" } })
  try {
    for (let i = 0; i < 50 && runtime.heartbeats.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10))
    }
    assert.equal(runtime.heartbeats.length, 1)
    assert.match(runtime.heartbeats[0].integration, /^ogr-openclaw\//)
    assert.equal(runtime.heartbeats[0].agent_id, "invoice-bot")
    assert.deepEqual(Object.keys(runtime.heartbeats[0].counters).sort(), ["evaluate_errors", "events_sent"])
  } finally {
    await runtime.close()
  }
})

test("no runtime configured: hooks pass through and nothing is sent", async () => {
  const runtime = await startMockRuntime(() => "allow")
  try {
    const handlers = bootPlugin(undefined)
    assert.equal(await toolCall(handlers), undefined)
    assert.equal(await handlers.get("message_sending")({ content: "hi" }, {}), undefined)
    assert.equal(runtime.received.length, 0)
    assert.equal(runtime.heartbeats.length, 0)
  } finally {
    await runtime.close()
  }
})

// ---- local secrets redaction (OGR 1.4), the INGRESS model ------------------

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CONFORMANCE } from "./mock-runtime.mjs"

const AWS = "AKIAIOSFODNN7EXAMPLE"
const OPENAI = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789"

/** Boot with local redaction caching into a throwaway directory, and wait for the ruleset. */
async function bootRedacting(decide, options = {}) {
  const cachePath = join(mkdtempSync(join(tmpdir(), "ogr-openclaw-")), "rules.json")
  const booted = await boot(decide, { ...options, localRedaction: { cachePath, ...options.localRedaction } })
  // `register` is synchronous, so the fetch lands in the background: the
  // observable is a tool result coming back masked. The probe runs in
  // `sess-1` — token numbers are allocated once per process, so after it
  // `sess-1` holds AWS as ${OGR_SECRET_1} and the next mint anywhere is 2.
  const probe = { role: "toolResult", toolCallId: "probe", toolName: "read", content: [{ type: "text", text: AWS }], isError: false, timestamp: 0 }
  for (let i = 0; i < 100; i += 1) {
    const out = booted.handlers.get("tool_result_persist")({ toolName: "read", toolCallId: "probe", message: probe }, { sessionKey: "sess-1" })
    if (out?.message?.content?.[0]?.text === "${OGR_SECRET_1}") break
    await new Promise((r) => setTimeout(r, 10))
  }
  return booted
}

const persist = (handlers, text, ctx = { sessionKey: "sess-1" }) =>
  handlers.get("tool_result_persist")(
    { toolName: "read", toolCallId: `call-${++seq}`, message: { role: "toolResult", toolCallId: "c", toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: 1 } },
    ctx,
  )

test("the restorer is registered on before_tool_call BELOW the guard's priority, so it runs after it", async () => {
  const { handlers, runtime } = await bootRedacting(() => "allow")
  try {
    const priorities = handlers.registered.get("before_tool_call").map((h) => h.priority)
    assert.deepEqual(priorities, [50, 10])
    // Both ingress hooks are synchronous, as the host requires.
    for (const hook of ["tool_result_persist", "before_message_write"]) {
      const out = handlers.get(hook)({ message: { role: "user", content: "hi", timestamp: 1 } }, { sessionKey: "s" })
      assert.ok(!(out instanceof Promise), `${hook} must not return a Promise`)
    }
  } finally {
    await runtime.close()
  }
})

test("a tool result is tokenised as it is persisted; the same value gets the same token later", async () => {
  const { handlers, runtime } = await bootRedacting(() => "allow")
  try {
    const out = persist(handlers, `OPENAI=${OPENAI}\nAWS=${AWS}\n`)
    assert.equal(out.message.content[0].text, "OPENAI=${OGR_SECRET_2}\nAWS=${OGR_SECRET_1}\n")
    assert.equal(out.message.role, "toolResult")
    assert.equal(out.message.toolName, "read")
    assert.equal(out.message.timestamp, 1)
    const again = handlers.get("before_message_write")(
      { message: { role: "user", content: `please use ${AWS}`, timestamp: 2 } },
      { sessionKey: "sess-1" },
    )
    assert.equal(again.message.content, "please use ${OGR_SECRET_1}")
    // A message with nothing to mask is left to the host untouched.
    assert.equal(handlers.get("before_message_write")({ message: { role: "user", content: "hi", timestamp: 3 } }, { sessionKey: "sess-1" }), undefined)
  } finally {
    await runtime.close()
  }
})

test("the call is judged on the placeholder, restored into params after the guard, and the event reports what was minted", async () => {
  const { handlers, runtime } = await bootRedacting(() => "allow")
  try {
    persist(handlers, `key ${AWS}`)
    const result = await handlers.get("before_tool_call")(
      { toolName: "bash", toolCallId: `call-${++seq}`, params: { command: "aws s3 ls", env: { AWS_ACCESS_KEY_ID: "${OGR_SECRET_1}" } } },
      { sessionKey: "sess-1" },
    )
    assert.deepEqual(result.params, { command: "aws s3 ls", env: { AWS_ACCESS_KEY_ID: AWS } })
    assert.ok(!result.block)
    const [event] = runtime.received
    assert.deepEqual(runtime.violations, [])
    assert.equal(event.payload.tool_calls[0].arguments.env.AWS_ACCESS_KEY_ID, "${OGR_SECRET_1}")
    assert.ok(!JSON.stringify(event).includes(AWS))
    assert.deepEqual(event.redaction, {
      ruleset: CONFORMANCE.ruleset.id,
      masked: [{ token: "${OGR_SECRET_1}", rule: "entity_aws_key_id/aws_access_key_id" }],
    })
    await toolCall(handlers)
    assert.deepEqual(runtime.received[1].redaction, { ruleset: CONFORMANCE.ruleset.id, masked: [] })
  } finally {
    await runtime.close()
  }
})

test("a blocked call is never restored", async () => {
  const { handlers, runtime } = await bootRedacting(() => "block")
  try {
    persist(handlers, `key ${AWS}`)
    const result = await handlers.get("before_tool_call")(
      { toolName: "bash", toolCallId: `call-${++seq}`, params: { command: "echo ${OGR_SECRET_1}" } },
      { sessionKey: "sess-1" },
    )
    assert.equal(result.block, true)
    assert.equal(result.params, undefined)
  } finally {
    await runtime.close()
  }
})

test("an unresolvable placeholder blocks the call with the notice", async () => {
  const { handlers, runtime } = await bootRedacting(() => "allow")
  try {
    const result = await handlers.get("before_tool_call")(
      { toolName: "bash", toolCallId: `call-${++seq}`, params: { command: "curl -H 'Authorization: Bearer ${OGR_SECRET_7}'" } },
      { sessionKey: "sess-1" },
    )
    assert.equal(result.block, true)
    assert.match(result.blockReason, /\$\{OGR_SECRET_7\} could not be restored: it is not a placeholder this session issued/)
  } finally {
    await runtime.close()
  }
})

test("D6: an outbound channel message carrying a known value reaches the runtime masked", async () => {
  const { handlers, runtime } = await bootRedacting(() => "allow")
  try {
    persist(handlers, `key ${AWS}`)
    assert.equal(await handlers.get("message_sending")({ content: `here: ${AWS}` }, { sessionKey: "sess-1" }), undefined)
    const event = runtime.received.at(-1)
    assert.equal(event.payload.text, "here: ${OGR_SECRET_1}")
    assert.equal(event.redaction.ruleset, CONFORMANCE.ruleset.id)
    assert.deepEqual(runtime.violations, [])
  } finally {
    await runtime.close()
  }
})

test("localRedaction.enabled=false masks nothing and sends no redaction field", async () => {
  const { handlers, runtime } = await boot(() => "allow", { localRedaction: { enabled: false } })
  try {
    assert.equal(runtime.rulesFetches, 0)
    assert.equal(persist(handlers, `key ${AWS}`), undefined)
    await toolCall(handlers)
    assert.ok(!("redaction" in runtime.received[0]))
    assert.deepEqual(runtime.violations, [])
  } finally {
    await runtime.close()
  }
})

test("the heartbeat carries the ruleset id", async () => {
  const { runtime } = await bootRedacting(() => "allow")
  try {
    for (let i = 0; i < 50 && runtime.heartbeats.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10))
    // The boot beat raced the fetch and preceded any proof of masking: absent
    // (nothing provably masks yet), "" (not yet fetched) or the id are each a
    // truthful report; a claim ahead of the proof would not be.
    assert.ok([undefined, "", CONFORMANCE.ruleset.id].includes(runtime.heartbeats[0].ruleset))
    assert.deepEqual(runtime.violations, [])
  } finally {
    await runtime.close()
  }
})

// ---- the HTTP interceptor: masking at the layer every harness shares --------

import { createServer } from "node:http"
import { interceptorStatus, uninstallHttpInterceptor } from "@openguardrails/local-redaction"

/** A stand-in provider on this process's `fetch`: echoes the request, answers a tool_use carrying a placeholder. */
async function startProvider() {
  const received = []
  const server = createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      received.push({ headers: req.headers, body: JSON.parse(raw) })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({
        id: "m", type: "message", role: "assistant", stop_reason: "tool_use",
        content: [{ type: "text", text: "using ${OGR_SECRET_1}" }, { type: "tool_use", id: "toolu_1", name: "bash", input: { command: "aws s3 ls --key ${OGR_SECRET_1}" } }],
      }))
    })
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  return {
    url: `http://127.0.0.1:${server.address().port}/v1/messages`,
    received,
    async close() { await new Promise((r) => server.close(r)) },
  }
}

/** What the host's model layer does: one POST through the process's fetch — the system prompt is a top-level field here. */
const modelCall = (url, content) =>
  globalThis.fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-api-key": "provider-key" }, body: JSON.stringify({ model: "claude", system: `You are a shell. Deploy key: ${OPENAI}`, messages: [{ role: "user", content }] }) })

/** Boot and wait for the ruleset WITHOUT touching an ingress hook — so nothing has masked yet. */
async function bootQuiet(decide, options = {}) {
  const booted = await boot(decide, { ...options, localRedaction: { cachePath: join(mkdtempSync(join(tmpdir(), "ogr-openclaw-")), "rules.json"), ...options.localRedaction } })
  for (let i = 0; i < 100 && booted.runtime.rulesFetches === 0; i += 1) await new Promise((r) => setTimeout(r, 10))
  await new Promise((r) => setTimeout(r, 20)) // the adopt follows the fetch
  return booted
}

test("the interceptor is installed with the redactor: the model request — system prompt included — is masked on the wire, the reply restored in tool_use.input, and the tool hook restores the same token", async () => {
  const { handlers, runtime } = await bootQuiet(() => "allow")
  const provider = await startProvider()
  try {
    assert.equal(interceptorStatus().installed, true)
    assert.equal(interceptorStatus().fetch, "wrapped")
    const res = await modelCall(provider.url, `my key is ${AWS}`)
    const reply = await res.json()
    const [sent] = provider.received
    assert.equal(sent.body.system, "You are a shell. Deploy key: ${OGR_SECRET_1}")
    assert.equal(sent.body.messages[0].content, "my key is ${OGR_SECRET_2}")
    assert.equal(sent.headers["x-api-key"], "provider-key")
    assert.ok(!Object.keys(sent.headers).some((k) => k.startsWith("x-ogr-")))
    assert.deepEqual(reply.content[1].input, { command: `aws s3 ls --key ${OPENAI}` })
    assert.equal(reply.content[0].text, "using ${OGR_SECRET_1}")
    assert.equal(interceptorStatus().sawTraffic, true)
    const result = await handlers.get("before_tool_call")(
      { toolName: "bash", toolCallId: `call-${++seq}`, params: { command: "aws s3 ls", env: { AWS_ACCESS_KEY_ID: "${OGR_SECRET_2}" } } },
      { sessionKey: "sess-1" },
    )
    assert.deepEqual(result.params, { command: "aws s3 ls", env: { AWS_ACCESS_KEY_ID: AWS } })
    const event = runtime.received.at(-1)
    assert.equal(event.payload.tool_calls[0].arguments.env.AWS_ACCESS_KEY_ID, "${OGR_SECRET_2}")
    assert.deepEqual(event.redaction.masked.map((m) => m.token), ["${OGR_SECRET_1}", "${OGR_SECRET_2}"])
    assert.deepEqual(runtime.violations, [])
    assert.equal(interceptorStatus().requests, 1) // the runtime's own calls passed through untouched
  } finally {
    await provider.close()
    await runtime.close()
  }
})

test("the ingress hooks mask until the interceptor has seen traffic, then step aside — nothing is masked twice", async () => {
  const { handlers, runtime } = await bootRedacting(() => "allow")
  const provider = await startProvider()
  try {
    // Unproven: the ingress hook masks (the probe already did, in sess-1).
    assert.equal(persist(handlers, `k ${OPENAI}`).message.content[0].text, "k ${OGR_SECRET_2}")
    await (await modelCall(provider.url, "hi")).text()
    // Proven: the same hook now leaves the message to the host, and the wire is masked by the interceptor.
    assert.equal(persist(handlers, `k ${AWS} again`), undefined)
    await (await modelCall(provider.url, `and ${AWS}`)).text()
    assert.equal(provider.received[1].body.messages[0].content, "and ${OGR_SECRET_4}")
    assert.equal(handlers.get("before_message_write")({ message: { role: "user", content: AWS, timestamp: 1 } }, { sessionKey: "sess-1" }), undefined)
  } finally {
    await provider.close()
    await runtime.close()
  }
})

test("the self-check: a tool call before any model traffic (and before any ingress masking) warns once and sends no redaction field", async () => {
  const warnings = []
  const original = console.warn
  console.warn = (m) => warnings.push(String(m))
  const { handlers, runtime } = await bootQuiet(() => "allow")
  try {
    await toolCall(handlers)
    await toolCall(handlers)
    assert.ok(!("redaction" in runtime.received[0]))
    assert.ok(!("redaction" in runtime.received[1]))
    const miss = warnings.filter((m) => /not passing through the HTTP interceptor/.test(m))
    assert.equal(miss.length, 1)
    assert.match(miss[0], /nothing is masked/)
    assert.deepEqual(runtime.violations, [])
  } finally {
    console.warn = original
    await runtime.close()
  }
})

test("localRedaction.http=false leaves fetch alone; the ingress model is the only path and reports as before", async () => {
  uninstallHttpInterceptor() // an earlier boot's; a plugin booting with http=false installs none of its own
  const original = globalThis.fetch
  const { handlers, runtime } = await bootRedacting(() => "allow", { localRedaction: { http: false } })
  try {
    assert.equal(interceptorStatus().installed, false)
    assert.equal(globalThis.fetch, original)
    await toolCall(handlers)
    assert.equal(runtime.received[0].redaction.ruleset, CONFORMANCE.ruleset.id)
  } finally {
    await runtime.close()
  }
})
