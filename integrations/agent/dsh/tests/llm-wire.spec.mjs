/**
 * The wire projections in isolation: dsh's `GenerateOptions` → the
 * `step/request` openai.chat body, a chunk stream → the CANONICAL
 * `step/response` payload, and the TailGate's character accounting.
 */
import { test } from "node:test"
import assert from "node:assert/strict"

import { LLM_PROTOCOL, RESPONSE_PROTOCOL, requestBody, ResponseAccumulator, TailGate } from "../dist/llm-wire.js"

test("each half states its shape: the request is a projection, the response is reassembled", () => {
  assert.equal(LLM_PROTOCOL, "openai.chat")
  assert.equal(RESPONSE_PROTOCOL, "canonical")
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
  // runtime judges the outcomes being fed back (they travel in the NEXT
  // step/request; no third call site exists).
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

// ---- TailGate: hold the tail, judge once ----------------------------------

const releasedText = (chunks) =>
  chunks.filter((c) => c.type === "text-delta").map((c) => c.text).join("")

test("TailGate releases everything but the tail, splitting deltas at the boundary", () => {
  const gate = new TailGate(5)
  const out = [
    ...gate.feed({ type: "text-delta", index: 0, text: "0123456789" }), // budget 5 → "01234"
    ...gate.feed({ type: "text-delta", index: 0, text: "abcdefghij" }), // budget 15 → "56789abcde"
  ]
  assert.equal(releasedText(out), "0123456789abcde", "always exactly `tail` chars behind")
  const rest = gate.flush()
  assert.equal(releasedText(rest), "fghij", "the flush is the held tail, nothing else")
})

test("TailGate never lets a block-end reveal held text through the back door", () => {
  const gate = new TailGate(5)
  const out = [
    ...gate.feed({ type: "text-delta", index: 0, text: "0123456789" }),
    // The block-end repeats the whole 10 chars; only 5 were released, so its
    // remainder cost keeps it queued behind the held delta half.
    ...gate.feed({ type: "block-end", index: 0, block: { type: "text", text: "0123456789" } }),
  ]
  assert.equal(out.some((c) => c.type === "block-end"), false)
  // A block that streamed no deltas costs its FULL text.
  const cold = new TailGate(5)
  const coldOut = cold.feed({ type: "block-end", index: 3, block: { type: "text", text: "12345678" } })
  assert.equal(coldOut.length, 0, "an unstreamed block is held whole while it straddles the tail")
})

test("TailGate holds `finish` unconditionally — nothing acts before the verdict", () => {
  const gate = new TailGate(0) // even a zero tail
  gate.feed({ type: "text-delta", index: 0, text: "done" })
  const out = gate.feed({ type: "finish", reason: { kind: "stop" } })
  assert.equal(out.some((c) => c.type === "finish"), false)
  const rest = gate.flush()
  assert.equal(rest[rest.length - 1].type, "finish")
})

test("TailGate preserves chunk order exactly; flush concatenation is lossless", () => {
  const gate = new TailGate(3)
  const chunks = [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text: "abcde" },
    { type: "block-end", index: 0, block: { type: "text", text: "abcde" } },
    { type: "block-end", index: 1, block: { type: "tool-call", id: "c1", name: "bash", arguments: '{"a":1}' } },
    { type: "finish", reason: { kind: "tool-calls" } },
  ]
  const out = []
  for (const chunk of chunks) out.push(...gate.feed(chunk))
  out.push(...gate.flush())
  assert.equal(releasedText(out), "abcde")
  assert.deepEqual(
    out.map((c) => c.type),
    ["block-start", "text-delta", "text-delta", "block-end", "block-end", "finish"],
    "split deltas stay in place; nothing is reordered around the hold",
  )
})
