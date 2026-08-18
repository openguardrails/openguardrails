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
  const handlers = new Map()
  plugin.register({ on: (hook, handler) => handlers.set(hook, handler) })
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
