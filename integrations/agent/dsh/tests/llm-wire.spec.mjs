/**
 * The v0.6 developer path: dsh model traffic → `openai.chat` bodies.
 *
 * These assert the PROJECTION only. Nothing here classifies the conversation —
 * that is the runtime's job — so what the tests pin is that everything the
 * runtime classifies FROM survives the re-shaping: the system slot, user words,
 * assistant prose, tool calls, tool outcomes fed back, and the tool inventory.
 */
import { test } from "node:test"
import assert from "node:assert/strict"

import { LLM_PROTOCOL, requestBody, ResponseAccumulator } from "../dist/llm-wire.js"

const msg = (role, content) => ({ id: `m-${role}`, role, content, source: { kind: "user" } })

test("the protocol name is the shape actually emitted", () => {
  assert.equal(LLM_PROTOCOL, "openai.chat")
})

test("the system slot leads the message list", () => {
  const body = requestBody({
    provider: "p", model: "m", system: "You are dsh.",
    messages: [msg("user", [{ type: "text", text: "hi" }])],
  })
  assert.deepEqual(body.messages[0], { role: "system", content: "You are dsh." })
  assert.deepEqual(body.messages[1], { role: "user", content: "hi" })
  assert.equal(body.model, "m")
})

test("assistant tool calls project onto openai.chat tool_calls", () => {
  const body = requestBody({
    provider: "p", model: "m",
    messages: [msg("assistant", [
      { type: "text", text: "Running it." },
      { type: "tool-call", id: "c1", name: "bash", arguments: '{"command":"ls"}' },
    ])],
  })
  assert.deepEqual(body.messages[0], {
    role: "assistant",
    content: "Running it.",
    tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }],
  })
})

test("a tool result becomes a tool-role message, not user words", () => {
  // This is the distinction the developer path rests on: the runtime has to be
  // able to tell "the tool outcomes being fed back" from "the new user words".
  const body = requestBody({
    provider: "p", model: "m",
    messages: [msg("user", [
      { type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "total 0" }] },
    ])],
  })
  assert.equal(body.messages.length, 1)
  assert.deepEqual(body.messages[0], { role: "tool", tool_call_id: "c1", content: "total 0" })
})

test("a message carrying both a tool result and user text yields both messages", () => {
  const body = requestBody({
    provider: "p", model: "m",
    messages: [msg("user", [
      { type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "done" }] },
      { type: "text", text: "now what?" },
    ])],
  })
  assert.deepEqual(body.messages.map((m) => m.role), ["tool", "user"])
  assert.equal(body.messages[1].content, "now what?")
})

test("the tool inventory travels verbatim — it is an attack surface of its own", () => {
  const body = requestBody({
    provider: "p", model: "m", messages: [],
    tools: [{ name: "bash", description: "run a command", parameters: { type: "object", properties: {} } }],
  })
  assert.deepEqual(body.tools, [{
    type: "function",
    function: { name: "bash", description: "run a command", parameters: { type: "object", properties: {} } },
  }])
})

test("reasoning blocks are dropped; no openai.chat request body carries them", () => {
  const body = requestBody({
    provider: "p", model: "m",
    messages: [msg("assistant", [
      { type: "reasoning", text: "the user probably wants X" },
      { type: "text", text: "Sure." },
    ])],
  })
  assert.equal(body.messages[0].content, "Sure.")
  assert.ok(!JSON.stringify(body).includes("probably wants X"))
})

test("generation parameters ride along when set, and are absent when not", () => {
  const full = requestBody({ provider: "p", model: "m", messages: [], temperature: 0, maxTokens: 100, stop: ["</x>"] })
  assert.equal(full.temperature, 0)
  assert.equal(full.max_tokens, 100)
  assert.deepEqual(full.stop, ["</x>"])

  const bare = requestBody({ provider: "p", model: "m", messages: [] })
  assert.ok(!("temperature" in bare))
  assert.ok(!("max_tokens" in bare))
  assert.ok(!("stop" in bare))
  assert.ok(!("tools" in bare))
})

test("the accumulator folds block-end chunks into an openai.chat response", () => {
  const acc = new ResponseAccumulator("m")
  assert.equal(acc.complete, false)
  assert.equal(acc.empty, true)

  acc.push({ type: "block-start", index: 0, blockType: "text" })
  acc.push({ type: "text-delta", index: 0, text: "par" })
  acc.push({ type: "block-end", index: 0, block: { type: "text", text: "partial ignored, block wins" } })
  acc.push({ type: "block-end", index: 1, block: { type: "tool-call", id: "c1", name: "bash", arguments: '{"command":"ls"}' } })
  acc.push({ type: "usage", usage: { inputTokens: 10, outputTokens: 5 } })
  acc.push({ type: "finish", reason: { kind: "tool-calls" } })

  assert.equal(acc.complete, true)
  assert.equal(acc.empty, false)
  const body = acc.body()
  const choice = body.choices[0]
  assert.equal(choice.message.content, "partial ignored, block wins")
  assert.deepEqual(choice.message.tool_calls, [
    { id: "c1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } },
  ])
  assert.equal(choice.finish_reason, "tool_calls")
  assert.deepEqual(body.usage, { inputTokens: 10, outputTokens: 5 })
})

test("deltas alone never produce content — only block-end is authoritative", () => {
  const acc = new ResponseAccumulator("m")
  acc.push({ type: "text-delta", index: 0, text: "streamed" })
  acc.push({ type: "tool-call-delta", index: 1, id: "c1", name: "bash", argumentsDelta: '{"com' })
  acc.push({ type: "finish", reason: { kind: "stop" } })
  assert.equal(acc.empty, true, "no block-end ⇒ nothing complete to judge")
})

test("finish reasons map to openai.chat, and unknown kinds pass through", () => {
  const of = (kind) => {
    const acc = new ResponseAccumulator("m")
    acc.push({ type: "block-end", index: 0, block: { type: "text", text: "x" } })
    acc.push({ type: "finish", reason: { kind } })
    return acc.body().choices[0].finish_reason
  }
  assert.equal(of("stop"), "stop")
  assert.equal(of("tool-calls"), "tool_calls")
  assert.equal(of("max-tokens"), "length")
  assert.equal(of("some-future-kind"), "some-future-kind")
})

test("a text-only answer reports content and no tool_calls", () => {
  const acc = new ResponseAccumulator("m")
  acc.push({ type: "block-end", index: 0, block: { type: "text", text: "hello" } })
  acc.push({ type: "finish", reason: { kind: "stop" } })
  const choice = acc.body().choices[0]
  assert.equal(choice.message.content, "hello")
  assert.ok(!("tool_calls" in choice.message))
})
