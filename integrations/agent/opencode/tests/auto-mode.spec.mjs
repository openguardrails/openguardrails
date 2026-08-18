/**
 * The v0.8 contract, exercised offline: a strict mock runtime (every event
 * checked against the exact ten-field GuardEvent, extras rejected) behind
 * the two opencode hooks, driven exactly as opencode calls them —
 * `tool.execute.before` first (judging and recording the call), then the
 * permission ask carrying the same `callID`.
 */
import assert from "node:assert/strict"
import { test } from "node:test"

import OpenGuardrailsPlugin from "../dist/index.js"
import { startMockRuntime } from "./mock-runtime.mjs"

let seq = 0

// The environment must not leak a real runtime (or identity claims) into
// what these tests assert — every connection is injected through options.
for (const k of Object.keys(process.env)) if (k.startsWith("OGR_")) delete process.env[k]

/** Boot the plugin against a mock runtime; returns hooks + the runtime. */
async function boot(decide, options = {}) {
  const runtime = await startMockRuntime(decide)
  const hooks = await OpenGuardrailsPlugin({ directory: "/nonexistent" }, {
    ...options,
    runtime: { url: runtime.url, apiKey: "ogr_mock", ...options.runtime },
  })
  return { hooks, runtime }
}

/** Drive one tool call through the before-hook. */
const before = (hooks, callID, command = "ls -la") =>
  hooks["tool.execute.before"]({ tool: "bash", sessionID: "sess-1", callID }, { args: { command } })

/** Run one permission ask and return the resulting status. */
async function ask(hooks, over) {
  const output = { status: "ask" }
  await hooks["permission.ask"]({ id: `perm-${++seq}`, type: "bash", sessionID: "sess-1", title: "Run command", metadata: {}, ...over }, output)
  return output.status
}

test("an allowed call proceeds, and the event is the exact v0.8 wire", async () => {
  const { hooks, runtime } = await boot(() => "allow")
  try {
    await before(hooks, `call-${++seq}`)
    assert.deepEqual(runtime.violations, [])
    assert.equal(runtime.received.length, 1)
    const [event] = runtime.received
    assert.equal(event.kind, "step/response")
    assert.equal(event.llm_protocol, "canonical")
    assert.deepEqual(event.payload.tool_calls.map((c) => c.name), ["bash"])
    assert.deepEqual(event.payload.tool_calls[0].arguments, { command: "ls -la" })
  } finally {
    await runtime.close()
  }
})

test("step_id is fresh per held call — never reused", async () => {
  const { hooks, runtime } = await boot(() => "allow")
  try {
    await before(hooks, `call-${++seq}`)
    await before(hooks, `call-${++seq}`)
    const [a, b] = runtime.received.map((e) => e.step_id)
    assert.ok(a.length > 0 && b.length > 0 && a !== b)
  } finally {
    await runtime.close()
  }
})

test("a blocked call throws, and its prompt is denied from the recorded verdict", async () => {
  const { hooks, runtime } = await boot((event) =>
    JSON.stringify(event.payload).includes("rm -rf /")
      ? { decision: "block", findings: [{ category: "security.malicious_command", severity: "critical", action: "block" }] }
      : "allow")
  try {
    const callID = `call-${++seq}`
    await assert.rejects(before(hooks, callID, "rm -rf / "), /OpenGuardrails.*security\.malicious_command/)
    // The ask reuses the record — the same action never earns a second answer.
    const sent = runtime.received.length
    assert.equal(await ask(hooks, { callID }), "deny")
    assert.equal(runtime.received.length, sent)
    assert.deepEqual(runtime.violations, [])
  } finally {
    await runtime.close()
  }
})

test("an uncorrelated ask is judged from its own metadata", async () => {
  const { hooks, runtime } = await boot((event) =>
    JSON.stringify(event.payload).includes("rm -rf /") ? "block" : "allow")
  try {
    assert.equal(await ask(hooks, { metadata: { command: "ls -la" } }), "allow")
    assert.equal(await ask(hooks, { metadata: { command: "rm -rf / " } }), "deny")
    assert.deepEqual(runtime.violations, [])
  } finally {
    await runtime.close()
  }
})

test("an ask with nothing to judge is never granted", async () => {
  const human = await boot(() => "allow")
  const strict = await boot(() => "allow", { auto: { unresolved: "reject" } })
  try {
    assert.equal(await ask(human.hooks, {}), "ask")
    assert.equal(await ask(strict.hooks, {}), "deny")
  } finally {
    await human.runtime.close()
    await strict.runtime.close()
  }
})

test("fail-open is the default: an unanswered evaluate proceeds, an unanswered ask stays human", async () => {
  const { hooks, runtime } = await boot(() => "allow")
  try {
    runtime.failNextEvaluate(2)
    await before(hooks, `call-${++seq}`) // no throw — the call proceeds
    assert.equal(await ask(hooks, { metadata: { command: "ls" } }), "ask")
  } finally {
    await runtime.close()
  }
})

test("failMode closed: an unanswered evaluate refuses the call and denies the ask", async () => {
  const { hooks, runtime } = await boot(() => "allow", { failMode: "closed" })
  try {
    runtime.failNextEvaluate(2)
    await assert.rejects(before(hooks, `call-${++seq}`), /could not be judged.*fail-closed/)
    assert.equal(await ask(hooks, { metadata: { command: "ls" } }), "deny")
  } finally {
    await runtime.close()
  }
})

test("failMode closed treats a non-empty unjudged as could-not-look", async () => {
  const { hooks, runtime } = await boot(
    () => ({ decision: "allow", unjudged: ["payload.tool_calls.0.arguments.command"] }),
    { failMode: "closed" },
  )
  try {
    await assert.rejects(before(hooks, `call-${++seq}`), /unjudged.*fail-closed/)
  } finally {
    await runtime.close()
  }
})

test("the four-tuple defaults to agent_type=opencode and empty assertions", async () => {
  const { hooks, runtime } = await boot(() => "allow")
  try {
    await before(hooks, `call-${++seq}`)
    const [event] = runtime.received
    assert.equal(event.agent_type, "opencode")
    assert.equal(event.agent_id, "")
    assert.equal(event.agent_workspace, "")
    assert.equal(event.agent_user, "")
  } finally {
    await runtime.close()
  }
})

test("configured identity claims ride on every event", async () => {
  const { hooks, runtime } = await boot(() => "allow", {
    runtime: { agentId: "invoice-bot", workspace: "finance-agents", owner: "payments-team", user: "u-8232" },
  })
  try {
    await before(hooks, `call-${++seq}`)
    const [event] = runtime.received
    assert.equal(event.agent_id, "invoice-bot")
    assert.equal(event.agent_type, "opencode")
    assert.equal(event.agent_workspace, "finance-agents")
    assert.equal(event.agent_user, "u-8232")
    assert.deepEqual(runtime.violations, [])
  } finally {
    await runtime.close()
  }
})

test("a heartbeat with the build id goes out at boot", async () => {
  const { runtime } = await boot(() => "allow", { runtime: { agentId: "invoice-bot" } })
  try {
    for (let i = 0; i < 50 && runtime.heartbeats.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10))
    }
    assert.equal(runtime.heartbeats.length, 1)
    assert.match(runtime.heartbeats[0].integration, /^ogr-opencode-auto-mode\//)
    assert.equal(runtime.heartbeats[0].agent_id, "invoice-bot")
    assert.deepEqual(Object.keys(runtime.heartbeats[0].counters).sort(), ["evaluate_errors", "events_sent"])
  } finally {
    await runtime.close()
  }
})

test("auto.enabled=false registers no permission hook at all", async () => {
  const { hooks, runtime } = await boot(() => "allow", { auto: { enabled: false } })
  try {
    assert.equal(hooks["permission.ask"], undefined)
  } finally {
    await runtime.close()
  }
})

test("no runtime configured: hooks pass through and nothing is sent", async () => {
  const runtime = await startMockRuntime(() => "allow")
  try {
    const hooks = await OpenGuardrailsPlugin({ directory: "/nonexistent" }, {})
    await before(hooks, `call-${++seq}`) // no throw, no traffic
    assert.equal(await ask(hooks, { metadata: { command: "ls" } }), "ask")
    assert.equal(runtime.received.length, 0)
    assert.equal(runtime.heartbeats.length, 0)
  } finally {
    await runtime.close()
  }
})
