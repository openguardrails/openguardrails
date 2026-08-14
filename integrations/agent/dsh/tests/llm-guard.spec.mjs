/**
 * The `llm/stream` half of the plugin, against a stand-in runtime.
 *
 * The developer path has no local fallback by design — `llm_request` and
 * `llm_response` carry the raw provider body precisely so the RUNTIME can
 * classify it — so every test here runs with a mock runtime configured and
 * asserts both what the plugin SENT and what it did with the verdict.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { boot } from "./harness.mjs"
import { startMockRuntime } from "./mock-runtime.mjs"

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
  { type: "finish", reason: { kind: "tool-calls" } },
]

/**
 * Boot the plugin with a mock runtime wired in. The reporter reads its
 * configuration from the environment when `apply` runs, so the vars are set
 * before boot and restored after; `OGR_KEYFILE` is redirected so a test never
 * touches the developer's real `~/.ogr` key material.
 */
async function withRuntime(config, decide, body) {
  const runtime = await startMockRuntime(decide)
  const saved = { ...process.env }
  process.env.OGR_RUNTIME_URL = runtime.url
  process.env.OGR_API_KEY = "ogr_mockmockmockmockmockmockmock"
  process.env.OGR_KEYFILE = join(mkdtempSync(join(tmpdir(), "ogr-dsh-key-")), "ed25519.json")
  try {
    const booted = await boot(config)
    return await body({ ...booted, runtime })
  } finally {
    process.env = saved
    await runtime.close()
  }
}

const finishOf = (chunks) => chunks.find((c) => c.type === "finish")

test("off (the default) sends nothing and touches the stream not at all", async () => {
  await withRuntime({}, () => "allow", async ({ stream, runtime }) => {
    const out = await stream(REQUEST, ANSWER)
    assert.deepEqual(out, ANSWER)
    assert.equal(runtime.received.length, 0)
  })
})

test("llm_request carries the assembled provider body, protocol-named", async () => {
  await withRuntime({ llmRequest: "enforce" }, () => "allow", async ({ stream, runtime }) => {
    const out = await stream(REQUEST, ANSWER)
    assert.deepEqual(out, ANSWER, "an allow verdict leaves the stream untouched")

    const [sent] = runtime.of("llm_request")
    assert.ok(sent, "one llm_request reached the runtime")
    assert.equal(sent.llm_protocol, "openai.chat")
    assert.equal(sent.observation_point, "conversation")
    assert.equal(sent.session_id, "sess-1")
    assert.equal(sent.agent_type, "dsh")
    // The runtime classifies FROM this body, so the parts it classifies from
    // have to be present and distinguishable.
    assert.deepEqual(sent.payload.messages[0], { role: "system", content: "You are dsh." })
    assert.equal(sent.payload.messages[1].content, "list the files")
    assert.equal(sent.payload.tools[0].function.name, "bash")
    // v0.6: identity is born at the runtime; a PEP never mints one.
    assert.ok(!sent.event_id)
  })
})

test("a block verdict on llm_request stops the call — the model is never reached", async () => {
  let adapterRan = false
  await withRuntime(
    { llmRequest: "enforce" },
    (e) => e.kind === "llm_request" ? { decision: "block", reasons: ["assembled context is injected"] } : "allow",
    async ({ ctx, stream }) => {
      ctx.on("llm/stream", (_o, next) => { adapterRan = true; return next() })
      const out = await stream(REQUEST, ANSWER)
      assert.equal(adapterRan, false, "nothing downstream of the guard ran")
      const finish = finishOf(out)
      assert.equal(finish.reason.kind, "error")
      assert.equal(finish.reason.failure.code, "ogr_blocked")
      assert.match(finish.reason.failure.message, /\[OpenGuardrails\] this model call was blocked/)
      assert.ok(!out.some((c) => c.type === "text-delta"), "no model output leaked")
    },
  )
})

test("require_approval on llm_request also stops the call — no gate exists at this altitude", async () => {
  await withRuntime({ llmRequest: "enforce" }, () => "require_approval", async ({ stream }) => {
    const out = await stream(REQUEST, ANSWER)
    assert.equal(finishOf(out).reason.failure.code, "ogr_blocked")
  })
})

test("a configured runtime participates in tool-call decisions: evaluate, and tighten only", async () => {
  const decide = (e) => {
    if (e.kind !== "tool_call") return "allow"
    const command = e.payload?.arguments?.command ?? ""
    return /echo hello/.test(command)
      ? { decision: "block", reasons: ["org policy: no hellos"] }
      : "allow"
  }
  await withRuntime({}, decide, async ({ call, runtime }) => {
    // Locally benign, remotely blocked → the remote verdict tightens.
    const blocked = await call("bash", { command: "echo hello" })
    assert.equal(blocked.isError, true)
    assert.match(blocked.error.message, /org policy: no hellos/)

    // Benign both sides → runs; the runtime saw it through /v1/evaluate.
    const ok = await call("bash", { command: "ls -la" })
    assert.equal(ok.isError, false)
    assert.ok(runtime.of("tool_call").length >= 2, "tool calls reached /v1/evaluate")

    // The identity five-tuple travels on every event.
    const [sent] = runtime.of("tool_call")
    assert.equal(sent.agent_type, "dsh")
    assert.ok(sent.agent_id.startsWith("dsh-"))
    assert.ok(sent.agent_owner, "agent_owner asserted (OS account)")
    assert.ok(sent.agent_user, "agent_user asserted (OS account)")
  })
})

test("a remote allow can never loosen a local block", async () => {
  await withRuntime({}, () => "allow", async ({ call }) => {
    const blocked = await call("bash", { command: "rm -rf / " })
    assert.equal(blocked.isError, true)
    assert.match(blocked.error.message, /security\.malicious_command/)
  })
})

test("llm_response carries the provider response body once the answer is complete", async () => {
  await withRuntime({ llmResponse: "enforce" }, () => "allow", async ({ stream, runtime }) => {
    const out = await stream(REQUEST, ANSWER)
    assert.deepEqual(out, ANSWER, "an allow verdict releases the buffered answer verbatim")

    const [sent] = runtime.of("llm_response")
    assert.ok(sent)
    assert.equal(sent.llm_protocol, "openai.chat")
    const choice = sent.payload.choices[0]
    assert.equal(choice.message.content, "Sure, listing them.")
    assert.equal(choice.message.tool_calls[0].function.name, "bash")
    assert.equal(choice.finish_reason, "tool_calls")
  })
})

test("a block verdict on llm_response withholds the whole answer", async () => {
  await withRuntime({ llmResponse: "enforce" }, () => "block", async ({ stream }) => {
    const out = await stream(REQUEST, ANSWER)
    assert.equal(out.length, 1)
    assert.equal(finishOf(out).reason.failure.code, "ogr_blocked")
    assert.match(finishOf(out).reason.failure.message, /the model's answer was blocked/)
  })
})

test("enforce on llm_response yields nothing until the verdict lands", async () => {
  // The ordering guarantee behind "BEFORE the agent acts on it": under enforce
  // no chunk may escape while the verdict is still in flight.
  let evaluated = false
  await withRuntime({ llmResponse: "enforce" }, () => { evaluated = true; return "allow" }, async ({ stream }) => {
    const seen = []
    const iterable = (async () => {
      const out = await stream(REQUEST, ANSWER)
      seen.push(...out)
      return out
    })()
    await iterable
    assert.equal(evaluated, true)
    assert.equal(seen.length, ANSWER.length)
  })
})

test("an aborted stream produces no llm_response — there is no complete answer to judge", async () => {
  const partial = [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text: "half a th" },
  ]
  await withRuntime({ llmResponse: "enforce" }, () => "block", async ({ stream, runtime }) => {
    const out = await stream(REQUEST, partial)
    assert.deepEqual(out, partial, "the partial stream is released, not blocked on a judgement never made")
    assert.equal(runtime.of("llm_response").length, 0)
  })
})

test("an auxiliary call (compaction, session titling) is not the agent's conversation", async () => {
  await withRuntime({ llmRequest: "enforce", llmResponse: "enforce" }, () => "block", async ({ stream, runtime }) => {
    const out = await stream({ ...REQUEST, purpose: "compaction" }, ANSWER)
    assert.deepEqual(out, ANSWER)
    assert.equal(runtime.received.length, 0)
  })
})

test("an unreachable runtime does not fail the turn closed, and says so", async () => {
  await withRuntime({ llmRequest: "enforce" }, () => "allow", async ({ stream, warnings, runtime }) => {
    runtime.failNextEvaluate(1)
    const out = await stream(REQUEST, ANSWER)
    assert.deepEqual(out, ANSWER, "the turn proceeds; the tool-call altitude is what fails closed")
    assert.ok(
      warnings.some((w) => /llm_request got no verdict/.test(w)),
      `expected a no-verdict warning, got: ${warnings.join(" | ")}`,
    )
  })
})

test("without a runtime the modes refuse to register, loudly", async () => {
  const saved = { ...process.env }
  delete process.env.OGR_RUNTIME_URL
  delete process.env.OGR_API_KEY
  try {
    const { stream, warnings } = await boot({ llmRequest: "enforce" })
    const out = await stream(REQUEST, ANSWER)
    assert.deepEqual(out, ANSWER)
    assert.ok(
      warnings.some((w) => /need a runtime/.test(w)),
      `expected a missing-runtime warning, got: ${warnings.join(" | ")}`,
    )
  } finally {
    process.env = saved
  }
})

test("the tool-call altitude keeps working alongside the developer path", async () => {
  await withRuntime({ llmRequest: "enforce" }, () => "allow", async ({ call }) => {
    const blocked = await call("bash", { command: "rm -rf / " })
    assert.equal(blocked.isError, true)
    assert.match(blocked.error.message, /security\.malicious_command/)
  })
})
