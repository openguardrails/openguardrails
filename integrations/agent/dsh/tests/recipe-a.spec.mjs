/**
 * Recipe A, end to end against a mock v0.7 runtime: the two step halves with
 * DECLARED coordinates, per-call refusal, the degraded-mode postures, and the
 * turn/end mark with the loop's own reason.
 *
 * Streams are dispatched through Cordis's real `llm/stream` waterfall (what
 * `LlmRuntime.stream()` does); coordinates are seeded the way the loop seeds
 * them — an `agent/request` dispatch carrying {agent, turn, step}.
 */
import { test } from "node:test"
import assert from "node:assert/strict"

import { boot, tick } from "./harness.mjs"
import { withRuntime } from "./mock-runtime.mjs"

const REQUEST = {
  provider: "test", model: "test-model", system: "You are dsh.",
  messages: [{ id: "m1", role: "user", content: [{ type: "text", text: "list the files" }], source: { kind: "user" } }],
  tools: [{ name: "bash", description: "run a command", parameters: { type: "object", properties: {} } }],
  sessionId: "sess-1",
}

const ANSWER = [
  { type: "block-start", index: 0, blockType: "text" },
  { type: "text-delta", index: 0, text: "Sure" },
  { type: "block-end", index: 0, block: { type: "text", text: "Sure, listing them." } },
  { type: "block-end", index: 1, block: { type: "tool-call", id: "c1", name: "bash", arguments: '{"command":"ls"}' } },
  { type: "usage", usage: { inputTokens: 812, outputTokens: 64, cacheReadTokens: 700 } },
  { type: "finish", reason: { kind: "tool-calls" } },
]

/** Seed the loop's own coordinates the way `buildRequest` announces them. */
async function seedCoords(ctx, sessionId, turn, step, parentSession) {
  const agent = {
    id: sessionId,
    session: { id: sessionId, header: { ...parentSession ? { parentSession } : {} }, events: [] },
  }
  await ctx.waterfall({}, "agent/request", {
    agent, turn, step, signal: new AbortController().signal,
  }, async () => ({ provider: "test", model: "test-model" }))
  return agent
}

const finishOf = (chunks) => chunks.find((c) => c.type === "finish")

test("both step halves carry DECLARED coordinates and the identity claims", async () => {
  await withRuntime(boot, {}, () => "allow", async ({ ctx, stream, runtime }) => {
    await seedCoords(ctx, "sess-1", 3, 2, "sess-parent")
    const out = await stream(REQUEST, ANSWER)
    assert.deepEqual(out, ANSWER, "an allow verdict leaves the stream untouched")

    const [req] = runtime.of("step/request")
    assert.ok(req, "one step/request reached the runtime")
    assert.equal(req.ogr_version, "0.7")
    assert.equal(req.session_id, "sess-1")
    assert.equal(req.turn, 3)
    assert.equal(req.step, 2)
    assert.equal(req.parent_session_id, "sess-parent")
    assert.equal(req.agent_type, "dsh")
    assert.match(req.integration, /^ogr-dsh\//)
    assert.equal(req.llm_protocol, "openai.chat")
    // The runtime classifies FROM this body.
    assert.deepEqual(req.payload.messages[0], { role: "system", content: "You are dsh." })
    assert.equal(req.payload.messages[1].content, "list the files")
    assert.equal(req.payload.tools[0].function.name, "bash")
    // Identity is runtime-born: the plugin mints no event id and no step id.
    assert.equal(req.event_id, undefined)

    const [res] = runtime.of("step/response")
    assert.ok(res, "one step/response reached the runtime")
    assert.equal(res.turn, 3)
    assert.equal(res.step, 2)
    // The CANONICAL shape: text + parsed-object tool calls + usage + timing.
    assert.equal(res.payload.text, "Sure, listing them.")
    assert.deepEqual(res.payload.tool_calls, [{ id: "c1", name: "bash", arguments: { command: "ls" } }])
    assert.equal(res.payload.model, "test-model")
    assert.deepEqual(res.payload.usage, { input_tokens: 812, output_tokens: 64, cache_read_tokens: 700 })
    assert.ok(res.payload.timing.started_at, "timing.started_at present")
    assert.ok(res.payload.timing.first_token_at, "timing.first_token_at present")
    assert.ok(res.payload.timing.completed_at, "timing.completed_at present")
  })
})

test("a blocked step/request never reaches the model", async () => {
  await withRuntime(
    boot,
    {},
    (ev) => (ev.kind === "step/request" ? "block" : "allow"),
    async ({ ctx, stream, runtime }) => {
      await seedCoords(ctx, "sess-1", 1, 1)
      let modelCalled = false
      const out = []
      const iterable = ctx.waterfall({}, "llm/stream", REQUEST, async function* () {
        modelCalled = true
        yield* ANSWER
      })
      for await (const chunk of iterable) out.push(chunk)

      assert.equal(modelCalled, false, "the model adapter was never invoked")
      const finish = finishOf(out)
      assert.equal(finish.reason.kind, "error")
      assert.equal(finish.reason.failure.code, "ogr_blocked")
      assert.equal(runtime.of("step/response").length, 0)
      void stream
    },
  )
})

test("a blocked step/response withholds the whole answer", async () => {
  await withRuntime(
    boot,
    {},
    (ev) => (ev.kind === "step/response"
      ? { decision: "block", findings: [{ category: "safety.toxicity", severity: "high", path: "payload.text" }] }
      : "allow"),
    async ({ ctx, stream }) => {
      await seedCoords(ctx, "sess-1", 1, 1)
      const out = await stream(REQUEST, ANSWER)
      const finish = finishOf(out)
      assert.equal(finish.reason.kind, "error")
      assert.match(finish.reason.failure.message, /safety\.toxicity/)
      assert.equal(out.some((c) => c.type === "block-end"), false, "no content escaped")
    },
  )
})

test("per-call refusal: prose passes, the named call is denied, its sibling runs", async () => {
  const TWO_CALLS = [
    { type: "block-end", index: 0, block: { type: "text", text: "Removing, then listing." } },
    { type: "block-end", index: 1, block: { type: "tool-call", id: "c-rm", name: "bash", arguments: '{"command":"rm -rf /"}' } },
    { type: "block-end", index: 2, block: { type: "tool-call", id: "c-ls", name: "bash", arguments: '{"command":"ls"}' } },
    { type: "finish", reason: { kind: "tool-calls" } },
  ]
  await withRuntime(
    boot,
    {},
    (ev) => (ev.kind === "step/response"
      ? {
        decision: "block",
        findings: [{
          category: "security.malicious_command", severity: "critical", action: "block",
          path: "payload.tool_calls.0.arguments.command", start: 0, end: 8,
        }],
      }
      : "allow"),
    async ({ ctx, stream, call }) => {
      await seedCoords(ctx, "sess-1", 1, 1)
      const out = await stream(REQUEST, TWO_CALLS)
      assert.deepEqual(out, TWO_CALLS, "the stream passes — refusal is per call")

      const denied = await call("bash", { command: "rm -rf /" }, { callId: "c-rm" })
      assert.equal(denied.isError, true)
      assert.match(String(denied.content[0].text), /security\.malicious_command/)

      const allowed = await call("bash", { command: "ls" }, { callId: "c-ls" })
      assert.equal(allowed.isError, false)
      void ctx
    },
  )
})

test("fail-open: an unreachable runtime passes the step through, loudly", async () => {
  await withRuntime(boot, {}, () => "allow", async ({ ctx, stream, runtime, warnings }) => {
    await seedCoords(ctx, "sess-1", 1, 1)
    runtime.failNextEvaluate(2)
    const out = await stream(REQUEST, ANSWER)
    assert.deepEqual(out, ANSWER)
    assert.ok(warnings.some((w) => /no verdict/.test(w)), "the gap is loud")
  })
})

test("fail-closed: an unreachable runtime blocks the step", async () => {
  await withRuntime(boot, { failMode: "closed" }, () => "allow", async ({ ctx, stream, runtime }) => {
    await seedCoords(ctx, "sess-1", 1, 1)
    runtime.failNextEvaluate(1)
    const out = await stream(REQUEST, ANSWER)
    const finish = finishOf(out)
    assert.equal(finish.reason.kind, "error")
    assert.equal(finish.reason.failure.code, "ogr_blocked")
  })
})

test("fail-closed: a non-empty `unjudged` is \"could not look\", which is not \"found nothing\"", async () => {
  await withRuntime(
    boot,
    { failMode: "closed" },
    (ev) => (ev.kind === "step/response"
      ? { decision: "allow", unjudged: ["payload.tool_calls.0.arguments.command"] }
      : "allow"),
    async ({ ctx, stream }) => {
      await seedCoords(ctx, "sess-1", 1, 1)
      const out = await stream(REQUEST, ANSWER)
      const finish = finishOf(out)
      assert.equal(finish.reason.kind, "error")
      assert.match(finish.reason.failure.message, /unjudged/)
    },
  )
})

test("fail-open: the same partial verdict passes (the deployment's stated posture)", async () => {
  await withRuntime(
    boot,
    {},
    (ev) => (ev.kind === "step/response"
      ? { decision: "allow", unjudged: ["payload.tool_calls.0.arguments.command"] }
      : "allow"),
    async ({ ctx, stream }) => {
      await seedCoords(ctx, "sess-1", 1, 1)
      const out = await stream(REQUEST, ANSWER)
      assert.deepEqual(out, ANSWER)
    },
  )
})

test("auxiliary calls (compaction, titling) are machinery, never judged", async () => {
  await withRuntime(boot, {}, () => "allow", async ({ stream, runtime }) => {
    const out = await stream({ ...REQUEST, purpose: "compaction" }, ANSWER)
    assert.deepEqual(out, ANSWER)
    assert.equal(runtime.received.length, 0)
  })
})

test("no runtime configured = unguarded, loudly, once — not silently", async () => {
  const { ctx, stream, warnings } = await boot({})
  await seedCoords(ctx, "sess-1", 1, 1)
  const out = await stream(REQUEST, ANSWER)
  assert.deepEqual(out, ANSWER)
  assert.ok(warnings.some((w) => /no runtime configured/.test(w)))
})

test("turn/end rides /v1/ingest with the loop's own reason, coordinates declared", async () => {
  await withRuntime(boot, {}, () => "allow", async ({ ctx, runtime }) => {
    const session = { id: "sess-9", header: { parentSession: "sess-root" }, events: [] }
    ctx.emit("session/event", session, { type: "turn/end", seq: 41, data: { turn: 7, reason: { kind: "max-tokens" } } })
    await tick()
    const [mark] = runtime.of("turn/end")
    assert.ok(mark, "the mark reached /v1/ingest")
    assert.equal(mark.session_id, "sess-9")
    assert.equal(mark.turn, 7)
    assert.equal(mark.parent_session_id, "sess-root")
    assert.deepEqual(mark.payload, { reason: "max_tokens" })
  })
})

test("a turn this plugin blocked closes as `blocked`, not as the error the abort surfaced as", async () => {
  await withRuntime(
    boot,
    {},
    (ev) => (ev.kind === "step/request" ? "block" : "allow"),
    async ({ ctx, stream, runtime }) => {
      await seedCoords(ctx, "sess-1", 4, 1)
      await stream(REQUEST, ANSWER)
      const session = { id: "sess-1", header: {}, events: [] }
      // The loop records the abort as an error; the mark tells the truth.
      ctx.emit("session/event", session, { type: "turn/end", seq: 42, data: { turn: 4, reason: { kind: "error" } } })
      await tick()
      const [mark] = runtime.of("turn/end")
      assert.deepEqual(mark.payload, { reason: "blocked" })
    },
  )
})
