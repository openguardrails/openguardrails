/**
 * The v0.8 recipe, end to end against a strict mock runtime: two evaluates
 * per model call bound by one producer-minted `step_id`, the required
 * four-tuple with "" as the explicit no-assertion, tail-hold streaming, the
 * degraded-mode postures (default OPEN), and the heartbeat.
 *
 * Streams are dispatched through Cordis's real `llm/stream` waterfall (what
 * `LlmRuntime.stream()` does). The mock validates every event against the
 * exact v0.8 field set and `withRuntime` fails the test on any rejection —
 * the strictness IS the conformance check.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { userInfo } from "node:os"

import { boot, tick } from "./harness.mjs"
import { withRuntime } from "./mock-runtime.mjs"
import { INTEGRATION } from "../dist/wire.js"

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

const finishOf = (chunks) => chunks.find((c) => c.type === "finish")

test("both step halves are exact v0.8 events: the field set, the protocols, timing", async () => {
  await withRuntime(boot, {}, () => "allow", async ({ stream, runtime }) => {
    const out = await stream(REQUEST, ANSWER)
    assert.deepEqual(out, ANSWER, "an allow verdict leaves the stream intact (short answer ≤ tail: held whole, flushed whole)")

    const [req] = runtime.of("step/request")
    assert.ok(req, "one step/request reached the runtime")
    // The strict mock already rejected extras/missing; assert the VALUES.
    assert.equal(req.llm_protocol, "openai.chat")
    assert.match(req.agent_id, /^dsh-/)
    assert.equal(req.agent_type, "dsh")
    // The runtime classifies FROM this body.
    assert.deepEqual(req.payload.messages[0], { role: "system", content: "You are dsh." })
    assert.equal(req.payload.messages[1].content, "list the files")
    assert.equal(req.payload.tools[0].function.name, "bash")
    // Nothing v0.8 removed leaks back onto the wire.
    //
    // ⚠️ `integration` was in this list and deliberately is NOT any more. It came
    // back as the one OPTIONAL field on 2026-08-17: a runtime keys its liveness
    // record on the integration NAME, so that record reports whichever replica
    // beat last and cannot say which build produced a given piece of traffic.
    for (const gone of ["ogr_version", "session_id", "turn", "step", "parent_session_id", "timestamp", "event_id"]) {
      assert.equal(req[gone], undefined, `${gone} left the wire in v0.8`)
    }
    // Every event names the build that produced it, with the SAME string the
    // heartbeat sends — two literals would drift and each would look right alone.
    assert.equal(req.integration, INTEGRATION, "step/request names the build that produced it")

    const [res] = runtime.of("step/response")
    assert.ok(res, "one step/response reached the runtime")
    // Stream-reassembled = no raw provider body = the canonical shape, and
    // the event says so.
    assert.equal(res.llm_protocol, "canonical")
    assert.equal(res.payload.text, "Sure, listing them.")
    assert.deepEqual(res.payload.tool_calls, [{ id: "c1", name: "bash", arguments: { command: "ls" } }])
    assert.equal(res.payload.model, "test-model")
    assert.deepEqual(res.payload.usage, { input_tokens: 812, output_tokens: 64, cache_read_tokens: 700 })
    assert.ok(res.payload.timing.started_at, "timing.started_at present")
    assert.ok(res.payload.timing.first_token_at, "timing.first_token_at present")
    assert.ok(res.payload.timing.completed_at, "timing.completed_at present")
  })
})

test("the four-tuple is always complete; \"\" is the explicit no-assertion", async () => {
  await withRuntime(boot, {}, () => "allow", async ({ stream, runtime }) => {
    await stream(REQUEST, ANSWER)
    for (const event of runtime.received) {
      // All four present on every event (the strict mock enforced presence;
      // this asserts the plugin's own defaults).
      assert.equal(typeof event.agent_workspace, "string")
      assert.equal(event.agent_workspace, "", "unconfigured workspace is the EMPTY STRING, never omitted")
      // A local single-user harness genuinely knows its OS account, so owner
      // and user default to it rather than to "".
      const account = userInfo().username
      assert.equal(event.agent_user, account)
    }
  })
})

test("one step_id binds a call's two halves; the next call mints a fresh one", async () => {
  await withRuntime(boot, {}, () => "allow", async ({ stream, runtime }) => {
    await stream(REQUEST, ANSWER)
    await stream(REQUEST, ANSWER)
    const requests = runtime.of("step/request")
    const responses = runtime.of("step/response")
    assert.equal(requests.length, 2)
    assert.equal(responses.length, 2)
    for (const [i, req] of requests.entries()) {
      assert.ok(req.step_id.length > 0, "step_id is a non-empty opaque id")
      assert.equal(responses[i].step_id, req.step_id, "the SAME id on both halves of one call")
    }
    assert.notEqual(requests[0].step_id, requests[1].step_id, "fresh id per model call — never reused")
  })
})

test("a blocked step/request never reaches the model", async () => {
  await withRuntime(
    boot,
    {},
    (ev) => (ev.kind === "step/request" ? "block" : "allow"),
    async ({ ctx, runtime }) => {
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
    },
  )
})

test("a blocked step/response withholds the answer (short answer: entirely inside the held tail)", async () => {
  await withRuntime(
    boot,
    {},
    (ev) => (ev.kind === "step/response"
      ? { decision: "block", findings: [{ category: "safety.toxicity", severity: "high", path: "payload.text" }] }
      : "allow"),
    async ({ stream }) => {
      const out = await stream(REQUEST, ANSWER)
      const finish = finishOf(out)
      assert.equal(finish.reason.kind, "error")
      assert.match(finish.reason.failure.message, /safety\.toxicity/)
      assert.equal(out.some((c) => c.type === "block-end"), false, "no content escaped — the whole answer sat inside the default 200-char tail")
    },
  )
})

test("tail-hold: the stream is forwarded live, the tail is withheld, block cuts it", async () => {
  const LONG = [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text: "0123456789" },
    { type: "text-delta", index: 0, text: "abcdefghij" },
    { type: "text-delta", index: 0, text: "KLMNOPQRST" },
    { type: "block-end", index: 0, block: { type: "text", text: "0123456789abcdefghijKLMNOPQRST" } },
    { type: "finish", reason: { kind: "stop" } },
  ]
  await withRuntime(
    boot,
    { streamTailChars: 6 },
    (ev) => (ev.kind === "step/response" ? "block" : "allow"),
    async ({ stream }) => {
      const out = await stream(REQUEST, LONG)
      const releasedText = out.filter((c) => c.type === "text-delta").map((c) => c.text).join("")
      // 30 chars streamed; the final 6 never left the plugin.
      assert.equal(releasedText, "0123456789abcdefghijKLMN", "everything ahead of the tail streamed through")
      assert.ok(!releasedText.includes("QRST"), "the held tail was dropped, not released")
      assert.equal(out.some((c) => c.type === "block-end"), false, "the block-end repeats the whole text and stayed held")
      const finish = finishOf(out)
      assert.equal(finish.reason.kind, "error")
      assert.equal(finish.reason.failure.code, "ogr_blocked")
    },
  )
})

test("tail-hold: allow releases the tail and the reassembled text is exact (splits included)", async () => {
  const LONG = [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text: "0123456789" },
    { type: "text-delta", index: 0, text: "abcdefghij" },
    { type: "block-end", index: 0, block: { type: "text", text: "0123456789abcdefghij" } },
    { type: "finish", reason: { kind: "stop" } },
  ]
  await withRuntime(boot, { streamTailChars: 6 }, () => "allow", async ({ stream }) => {
    const out = await stream(REQUEST, LONG)
    const releasedText = out.filter((c) => c.type === "text-delta").map((c) => c.text).join("")
    assert.equal(releasedText, "0123456789abcdefghij", "concatenation is unchanged even where a delta was split at the tail boundary")
    // Order is preserved: every delta before the block-end, finish last.
    const kinds = out.map((c) => c.type)
    assert.equal(kinds[kinds.length - 1], "finish")
    assert.ok(kinds.indexOf("block-end") > kinds.lastIndexOf("text-delta"), "no reordering around the hold")
  })
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
    async ({ stream, call }) => {
      const out = await stream(REQUEST, TWO_CALLS)
      assert.deepEqual(out, TWO_CALLS, "the stream passes — refusal is per call")

      const denied = await call("bash", { command: "rm -rf /" }, { callId: "c-rm" })
      assert.equal(denied.isError, true)
      assert.match(String(denied.content[0].text), /security\.malicious_command/)

      const allowed = await call("bash", { command: "ls" }, { callId: "c-ls" })
      assert.equal(allowed.isError, false)
    },
  )
})

test("fail-open is the DEFAULT: an unreachable runtime passes the step through, loudly", async () => {
  // No failMode configured — this asserts the default posture itself.
  await withRuntime(boot, {}, () => "allow", async ({ stream, runtime, warnings }) => {
    runtime.failNextEvaluate(2)
    const out = await stream(REQUEST, ANSWER)
    assert.deepEqual(out, ANSWER, "the step proceeded despite two failed evaluates")
    assert.ok(warnings.some((w) => /no verdict/.test(w)), "the gap is loud")
  })
})

test("fail-closed when configured: an unreachable runtime blocks the step", async () => {
  await withRuntime(boot, { failMode: "closed" }, () => "allow", async ({ stream, runtime }) => {
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
    async ({ stream }) => {
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
    async ({ stream }) => {
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
  const saved = { ...process.env }
  delete process.env.OGR_API_KEY
  delete process.env.OGR_RUNTIME_URL
  try {
    const { stream, warnings } = await boot({})
    const out = await stream(REQUEST, ANSWER)
    assert.deepEqual(out, ANSWER)
    assert.ok(warnings.some((w) => /no runtime configured/.test(w)))
  } finally {
    process.env = saved
  }
})

test("the heartbeat carries the build id and the degraded-mode counters", async () => {
  await withRuntime(boot, { heartbeatS: 0.05 }, () => "allow", async ({ stream, runtime }) => {
    // One beat fires on connect, before any event — a heartbeat registers a
    // live-but-idle agent.
    await tick(20)
    assert.ok(runtime.beats.length >= 1, "a beat arrived before the first event")
    assert.equal(runtime.beats[0].integration, "ogr-dsh/0.3.0")
    assert.match(runtime.beats[0].agent_id, /^dsh-/)

    // An outage shows up in the counters — v0.8's only record that steps
    // went unjudged (there is no replay channel).
    runtime.failNextEvaluate(1)
    await stream(REQUEST, ANSWER)
    await tick(120)
    const last = runtime.beats[runtime.beats.length - 1]
    assert.ok(last.counters.events_sent >= 2, "both halves were counted")
    assert.ok(last.counters.evaluate_errors >= 1, "the failed evaluate was counted")
  })
})
