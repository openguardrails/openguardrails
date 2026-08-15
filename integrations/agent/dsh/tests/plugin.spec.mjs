/**
 * Enforcement at the tool registry — the step verdict's consequences, driven
 * through `ctx.tools.execute()` and the genuine pipeline (`tools/pre-execute`,
 * the monotonic guards, dispatch, `tools/result`) so a change in how dsh
 * orders or short-circuits that pipeline shows up as a failure rather than a
 * silently bypassed guard.
 */
import { test } from "node:test"
import assert from "node:assert/strict"

import { boot, text } from "./harness.mjs"
import { withRuntime } from "./mock-runtime.mjs"

const REQUEST = {
  provider: "test", model: "test-model",
  messages: [{ id: "m1", role: "user", content: [{ type: "text", text: "go" }], source: { kind: "user" } }],
  sessionId: "sess-1",
}

/** A stream whose step/response asks for one bash call with the given id/command. */
const answerWith = (callId, command) => [
  { type: "block-end", index: 0, block: { type: "tool-call", id: callId, name: "bash", arguments: JSON.stringify({ command }) } },
  { type: "finish", reason: { kind: "tool-calls" } },
]

/** Judge the step so `callId` is refused per-call. */
const refuseCall = (ev) => (ev.kind === "step/response"
  ? {
    decision: "block",
    findings: [{
      category: "security.malicious_command", severity: "critical", action: "block",
      path: "payload.tool_calls.0.arguments.command",
    }],
  }
  : "allow")

test("a call the step verdict refused is denied at the registry", async () => {
  await withRuntime(boot, {}, refuseCall, async ({ stream, call }) => {
    await stream(REQUEST, answerWith("c-bad", "rm -rf /"))
    const result = await call("bash", { command: "rm -rf /" }, { callId: "c-bad" })
    assert.equal(result.isError, true)
    assert.match(text(result), /\[OpenGuardrails\] security\.malicious_command/)
  })
})

test("a call the step verdict cleared dispatches untouched", async () => {
  await withRuntime(boot, {}, () => "allow", async ({ stream, call }) => {
    await stream(REQUEST, answerWith("c-ok", "ls"))
    const result = await call("bash", { command: "ls" }, { callId: "c-ok" })
    assert.equal(result.isError, false)
    assert.equal(text(result), "ls")
  })
})

test("the verdict is released on tools/result — a REUSED id is judged by the fail mode, not by history", async () => {
  await withRuntime(boot, {}, refuseCall, async ({ stream, call }) => {
    await stream(REQUEST, answerWith("c-bad", "rm -rf /"))
    await call("bash", { command: "rm -rf /" }, { callId: "c-bad" })
    // Fail-open default: the released id carries no verdict and dispatches.
    const again = await call("bash", { command: "echo fine" }, { callId: "c-bad" })
    assert.equal(again.isError, false)
  })
})

test("fail-closed: a call with NO step verdict at all is refused", async () => {
  await withRuntime(boot, { failMode: "closed" }, () => "allow", async ({ call }) => {
    const result = await call("bash", { command: "ls" }, { callId: "never-judged" })
    assert.equal(result.isError, true)
    assert.match(text(result), /no step verdict|never covered/)
  })
})

test("fail-open: a call with no step verdict dispatches (the deployment's stated posture)", async () => {
  await withRuntime(boot, {}, () => "allow", async ({ call }) => {
    const result = await call("bash", { command: "ls" }, { callId: "never-judged" })
    assert.equal(result.isError, false)
  })
})

test("no runtime configured: the registry is unguarded even under failMode closed", async () => {
  // Closed governs a runtime that IS configured and cannot answer;
  // unconfigured is a deployment choice, warned about at the stream.
  const saved = { ...process.env }
  delete process.env.OGR_API_KEY
  delete process.env.OGR_RUNTIME_URL
  try {
    const { call } = await boot({ failMode: "closed" })
    const result = await call("bash", { command: "ls" })
    assert.equal(result.isError, false)
  } finally {
    process.env = saved
  }
})

test("the monotonic guard re-asserts a refusal a reordered waterfall would skip", async () => {
  await withRuntime(boot, {}, refuseCall, async ({ ctx, stream, call }) => {
    await stream(REQUEST, answerWith("c-bad", "rm -rf /"))
    // A permissive listener AHEAD of the plugin short-circuits pre-execute.
    ctx.on("tools/pre-execute", async () => ({ kind: "allow" }), { prepend: true })
    const result = await call("bash", { command: "rm -rf /" }, { callId: "c-bad" })
    assert.equal(result.isError, true, "the guard held")
    assert.match(text(result), /\[OpenGuardrails\]/)
  })
})
