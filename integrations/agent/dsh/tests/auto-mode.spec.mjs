/**
 * Auto mode: the `approval/request` answerer that gives an auto-mode
 * permission preset its meaning — asks resolve from the STEP VERDICT the call
 * already earned, instead of a human.
 *
 * Asks are dispatched through Cordis's real waterfall, the same channel
 * `ApprovalService.decide` uses, with a sentinel terminal answerer so a
 * delegated ask is distinguishable from a claimed one.
 */
import { test } from "node:test"
import assert from "node:assert/strict"

import { boot } from "./harness.mjs"
import { withRuntime } from "./mock-runtime.mjs"

let seq = 0

/** A live agent in a session whose preset log is `events` (strings = presets, in order). */
const agentOn = (...presets) => ({
  id: `sess-${++seq}`,
  session: {
    header: { cwd: undefined },
    events: presets.map((preset) => ({ type: "permission/preset", data: { preset } })),
  },
})

/** Dispatch one ask exactly as the approval service would. */
const ask = (ctx, req) => ctx.waterfall({}, "approval/request", req, async () => "unavailable")

const REQUEST = {
  provider: "test", model: "test-model",
  messages: [{ id: "m1", role: "user", content: [{ type: "text", text: "go" }], source: { kind: "user" } }],
  sessionId: "sess-auto",
}

const answerWith = (callId, command) => [
  { type: "block-end", index: 0, block: { type: "tool-call", id: callId, name: "bash", arguments: JSON.stringify({ command }) } },
  { type: "finish", reason: { kind: "tool-calls" } },
]

const refuseCall = (ev) => (ev.kind === "step/response"
  ? {
    decision: "block",
    findings: [{ category: "security.malicious_command", action: "block", path: "payload.tool_calls.0" }],
  }
  : "allow")

test("an ask for a step-cleared call is granted once", async () => {
  await withRuntime(boot, {}, () => "allow", async ({ ctx, stream }) => {
    await stream(REQUEST, answerWith("c-ok", "ls"))
    const outcome = await ask(ctx, { agent: agentOn("auto-mode"), toolName: "bash", callId: "c-ok" })
    assert.equal(outcome, "allowed-once")
  })
})

test("an ask for a step-refused call is rejected, not granted", async () => {
  await withRuntime(boot, {}, refuseCall, async ({ ctx, stream }) => {
    await stream(REQUEST, answerWith("c-bad", "rm -rf /"))
    const outcome = await ask(ctx, { agent: agentOn("auto-mode"), toolName: "bash", callId: "c-bad" })
    assert.equal(outcome, "rejected")
  })
})

test("sessions on any other preset — or never pinned — delegate untouched", async () => {
  await withRuntime(boot, {}, () => "allow", async ({ ctx, stream }) => {
    await stream(REQUEST, answerWith("c-ok", "ls"))
    assert.equal(await ask(ctx, { agent: agentOn("workspace-write"), toolName: "bash", callId: "c-ok" }), "unavailable")
    assert.equal(await ask(ctx, { agent: agentOn(), toolName: "bash", callId: "c-ok" }), "unavailable")
  })
})

test("the LAST permission/preset event wins, matching dsh's own fold", async () => {
  await withRuntime(boot, {}, () => "allow", async ({ ctx, stream }) => {
    await stream(REQUEST, answerWith("c-ok", "ls"))
    assert.equal(
      await ask(ctx, { agent: agentOn("auto-mode", "workspace-write"), toolName: "bash", callId: "c-ok" }),
      "unavailable",
    )
    assert.equal(
      await ask(ctx, { agent: agentOn("workspace-write", "auto-mode"), toolName: "bash", callId: "c-ok" }),
      "allowed-once",
    )
  })
})

test("an ask the step verdict never covered stays undecided: human by default, rejected under `reject`", async () => {
  for (const [unresolved, expected] of [["human", "unavailable"], ["reject", "rejected"]]) {
    await withRuntime(boot, { auto: { unresolved } }, () => "allow", async ({ ctx }) => {
      const outcome = await ask(ctx, { agent: agentOn("auto-mode"), toolName: "bash", callId: "never-seen" })
      assert.equal(outcome, expected, `unresolved=${unresolved}`)
    })
  }
})

test("the preset name is configurable", async () => {
  await withRuntime(boot, { auto: { preset: "ogr-auto" } }, () => "allow", async ({ ctx, stream }) => {
    await stream(REQUEST, answerWith("c-ok", "ls"))
    assert.equal(await ask(ctx, { agent: agentOn("ogr-auto"), toolName: "bash", callId: "c-ok" }), "allowed-once")
    assert.equal(await ask(ctx, { agent: agentOn("auto-mode"), toolName: "bash", callId: "c-ok" }), "unavailable")
  })
})

test("auto.enabled=false registers no answerer at all", async () => {
  await withRuntime(boot, { auto: { enabled: false } }, () => "allow", async ({ ctx, stream }) => {
    await stream(REQUEST, answerWith("c-ok", "ls"))
    assert.equal(await ask(ctx, { agent: agentOn("auto-mode"), toolName: "bash", callId: "c-ok" }), "unavailable")
  })
})
