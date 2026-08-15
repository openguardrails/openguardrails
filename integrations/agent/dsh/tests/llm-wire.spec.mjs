/**
 * The wire projections in isolation: dsh's `GenerateOptions` → the
 * `step/request` openai.chat body, and a chunk stream → the CANONICAL
 * `step/response` payload.
 */
import { test } from "node:test"
import assert from "node:assert/strict"

import { LLM_PROTOCOL, requestBody, ResponseAccumulator } from "../dist/llm-wire.js"

test("the protocol name is the request projection's", () => {
  assert.equal(LLM_PROTOCOL, "openai.chat")
})

test("requestBody: system leads, tool results become tool-role messages", () => {
  const body = requestBody({
    provider: "test", model: "m", system: "sys",
    messages: [
      { id: "m1", role: "user", content: [{ type: "text", text: "hi" }], source: { kind: "user" } },
      {
        id: "m2", role: "assistant",
        content: [
          { type: "text", text: "running it" },
          { type: "tool-call", id: "c1", name: "bash", arguments: '{"command":"ls"}' },
        ],
        source: { kind: "assistant" },
      },
      {
        id: "m3", role: "user",
        content: [{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "README.md" }] }],
        source: { kind: "tool" },
      },
    ],
    tools: [{ name: "bash", description: "run", parameters: { type: "object" } }],
  })
  assert.deepEqual(body.messages[0], { role: "system", content: "sys" })
  assert.deepEqual(body.messages[1], { role: "user", content: "hi" })
  assert.equal(body.messages[2].role, "assistant")
  assert.equal(body.messages[2].tool_calls[0].function.name, "bash")
  // The tool RESULT is a tool-role message keyed by tool_call_id — where the
  // runtime judges the outcomes being fed back (Recipe A step 3).
  assert.deepEqual(body.messages[3], { role: "tool", tool_call_id: "c1", content: "README.md" })
  assert.equal(body.tools[0].function.name, "bash")
})

test("the accumulator folds block-ends into the canonical payload, args parsed", () => {
  const acc = new ResponseAccumulator("m")
  acc.push({ type: "block-end", index: 0, block: { type: "reasoning", text: "thinking…" } })
  acc.push({ type: "block-end", index: 1, block: { type: "text", text: "on it. " } })
  acc.push({ type: "block-end", index: 2, block: { type: "text", text: "done." } })
  acc.push({ type: "block-end", index: 3, block: { type: "tool-call", id: "c1", name: "bash", arguments: '{"command":"df -h"}' } })
  acc.push({ type: "usage", usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 2 } })
  acc.push({ type: "finish", reason: { kind: "tool-calls" } })

  assert.equal(acc.complete, true)
  assert.equal(acc.empty, false)
  const body = acc.body()
  assert.equal(body.text, "on it. done.")
  assert.equal(body.reasoning, "thinking…")
  assert.deepEqual(body.tool_calls, [{ id: "c1", name: "bash", arguments: { command: "df -h" } }])
  assert.deepEqual(body.usage, { input_tokens: 10, output_tokens: 5, reasoning_tokens: 2 })
  assert.ok(body.timing.started_at)
  assert.ok(body.timing.first_token_at)
  assert.ok(body.timing.completed_at)
})

test("unparseable tool arguments degrade to {input}, never a double-encoded string", () => {
  const acc = new ResponseAccumulator("m")
  acc.push({ type: "block-end", index: 0, block: { type: "tool-call", id: "c1", name: "bash", arguments: "not json {" } })
  acc.push({ type: "finish", reason: { kind: "stop" } })
  assert.deepEqual(acc.body().tool_calls, [{ id: "c1", name: "bash", arguments: { input: "not json {" } }])
})

test("an aborted stream is incomplete; an empty one not worth a round trip", () => {
  const aborted = new ResponseAccumulator("m")
  aborted.push({ type: "block-end", index: 0, block: { type: "text", text: "half" } })
  assert.equal(aborted.complete, false)

  const empty = new ResponseAccumulator("m")
  empty.push({ type: "finish", reason: { kind: "stop" } })
  assert.equal(empty.complete, true)
  assert.equal(empty.empty, true)
})
