/**
 * The streaming restorer (the higress `Restorer.Feed` port) and the three
 * SSE decoders built on it: a token straddling deltas restores once its last
 * piece arrives, every field keeps its own tail, prose is never touched, and
 * a held tail is delivered before the frame that closes its field.
 */
import assert from "node:assert/strict"
import { test } from "node:test"

import { createSseRestorer, createStreamRestorer, jsonStringEncode, restoreJsonText, SessionMap } from "../dist/index.js"

const AWS = "AKIAIOSFODNN7EXAMPLE"

function seeded(values) {
  const map = new SessionMap("s")
  for (const v of values) map.tokenFor(v)
  return map
}

test("feed: a token split across three deltas restores once the last piece arrives; nothing is emitted early", () => {
  const r = createStreamRestorer(seeded([AWS]))
  const state = { pending: "" }
  assert.equal(r.feed(state, 'aws --key OGRKP00', false), "aws --key ")
  assert.equal(state.pending, "OGRKP00")
  assert.equal(r.feed(state, "0000", false), "")
  assert.equal(r.feed(state, "1 ls", false), `${AWS} ls`)
  assert.equal(state.pending, "")
})

test("feed: a partial token at end of stream is text, not lost", () => {
  const r = createStreamRestorer(seeded([AWS]))
  const state = { pending: "" }
  assert.equal(r.feed(state, "cost: O", false), "cost: ")
  assert.equal(r.feed(state, "", true), "O")
  assert.equal(state.pending, "")
})

test("feed: a key held across a delta boundary completes as the token it is — OGRKP000001 then 0 is token 10", () => {
  const map = seeded(["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"])
  const r = createStreamRestorer(map)
  const state = { pending: "" }
  assert.equal(r.feed(state, "OGRKP000001", false), "")
  assert.equal(r.feed(state, "0/OGRKP0000001", false), "ten/one")
})

test("feed: a markdown-escaped legacy token split at the escape restores; a lone backslash before a non-escapable is text", () => {
  // The `${OGR_…}` shape is no longer minted but stays restorable — adopted, as an older plugin's token.
  const legacy = new SessionMap("legacy")
  assert.ok(legacy.adopt("${OGR_SECRET_1}", AWS))
  const r = createStreamRestorer(legacy)
  const state = { pending: "" }
  assert.equal(r.feed(state, "${OGR\\", false), "")
  assert.equal(r.feed(state, "_SECRET\\_1}", false), AWS)
  assert.equal(r.feed(state, "C:\\na", false), "C:\\na")
})

test("feed: two fields keep separate tails — one call's half token is never completed by the other's delta", () => {
  const r = createStreamRestorer(seeded([AWS]))
  const a = { pending: "" }
  const b = { pending: "" }
  assert.equal(r.feed(a, "OGRKP000", false), "")
  assert.equal(r.feed(b, "0001", false), "0001")
  assert.equal(r.feed(a, "0001", false), AWS)
})

test("jsonStringEncode: a value with a quote lands in JSON text escaped, so the document still parses", () => {
  const map = seeded(['pa"ss\\word'])
  const r = restoreJsonText('{"password":"OGRKP0000001"}', map)
  assert.deepEqual(JSON.parse(r.text), { password: 'pa"ss\\word' })
  assert.equal(jsonStringEncode("a\nb"), "a\\nb")
})

/** Split an SSE text into its data payloads (strings), in order. */
function payloads(text) {
  return text
    .split(/\r?\n\r?\n/)
    .filter((f) => f.includes("data:"))
    .map((f) => f.split(/\r?\n/).find((l) => l.startsWith("data:")).slice(6))
}

const chatChunk = (delta, finish = null) =>
  `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", model: "gpt-x", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`

test("openai.chat stream: an argument split across three deltas is restored, prose and reasoning are not, and the assembled call parses", () => {
  const sse = createSseRestorer("openai.chat", seeded([AWS]))
  const frames = [
    chatChunk({ role: "assistant", content: "using OGRKP0000001 now" }),
    chatChunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: "" } }] }),
    chatChunk({ tool_calls: [{ index: 0, function: { arguments: '{"cmd":"aws --key OGRKP00' } }] }),
    chatChunk({ tool_calls: [{ index: 0, function: { arguments: "0000" } }] }),
    chatChunk({ tool_calls: [{ index: 0, function: { arguments: '1 ls"}' } }] }),
    chatChunk({}, "tool_calls"),
    "data: [DONE]\n\n",
  ]
  // Fed in awkward chunks: mid-frame, mid-JSON-string.
  const whole = frames.join("")
  let out = ""
  for (let i = 0; i < whole.length; i += 37) out += sse.feed(whole.slice(i, i + 37))
  out += sse.end()
  const data = payloads(out)
  assert.equal(data.at(-1), "[DONE]")
  const parsed = data.slice(0, -1).map((d) => JSON.parse(d))
  assert.equal(parsed[0].choices[0].delta.content, "using OGRKP0000001 now")
  const args = parsed.flatMap((p) => p.choices[0].delta.tool_calls ?? []).map((tc) => tc.function?.arguments ?? "").join("")
  assert.deepEqual(JSON.parse(args), { cmd: `aws --key ${AWS} ls` })
  // No argument delta went out carrying a token fragment the client would concatenate into a placeholder.
  assert.ok(!args.includes("${OGR_SE"))
})

test("openai.chat stream: a tail held at the finish frame is flushed BEFORE it, so nothing is lost", () => {
  const sse = createSseRestorer("openai.chat", seeded([AWS]))
  const out =
    sse.feed(chatChunk({ tool_calls: [{ index: 0, function: { arguments: '{"a":"O' } }] })) +
    sse.feed(chatChunk({}, "tool_calls")) +
    sse.feed("data: [DONE]\n\n") +
    sse.end()
  const data = payloads(out).slice(0, -1).map((d) => JSON.parse(d))
  const args = data.flatMap((p) => p.choices[0].delta.tool_calls ?? []).map((tc) => tc.function.arguments).join("")
  assert.equal(args, '{"a":"O')
  // The flush precedes the frame carrying finish_reason.
  const finishAt = data.findIndex((p) => p.choices[0].finish_reason === "tool_calls")
  assert.ok(data.slice(0, finishAt).some((p) => (p.choices[0].delta.tool_calls ?? []).some((tc) => tc.function.arguments === "O")))
})

const ev = (name, payload) => `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`

test("anthropic stream: input_json_delta across deltas restores, text_delta does not, and the tail is flushed before content_block_stop", () => {
  const sse = createSseRestorer("anthropic.messages", seeded([AWS]))
  const frames = [
    ev("message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [] } }),
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "I will use OGRKP0000001." } }),
    ev("content_block_stop", { type: "content_block_stop", index: 0 }),
    ev("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "bash", input: {} } }),
    ev("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"cmd": "echo OGRKP' } }),
    ev("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "0000" } }),
    ev("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '001"}' } }),
    ev("content_block_stop", { type: "content_block_stop", index: 1 }),
    ev("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } }),
    ev("message_stop", { type: "message_stop" }),
  ]
  const whole = frames.join("")
  let out = ""
  for (let i = 0; i < whole.length; i += 23) out += sse.feed(whole.slice(i, i + 23))
  out += sse.end()
  const data = payloads(out).map((d) => JSON.parse(d))
  const text = data.filter((d) => d.type === "content_block_delta" && d.delta.type === "text_delta").map((d) => d.delta.text).join("")
  assert.equal(text, "I will use OGRKP0000001.")
  const json = data.filter((d) => d.type === "content_block_delta" && d.delta.type === "input_json_delta").map((d) => d.delta.partial_json).join("")
  assert.deepEqual(JSON.parse(json), { cmd: `echo ${AWS}` })
  // Every event: line still names its data's type — a flush frame is a whole frame.
  for (const frame of out.split(/\n\n/).filter(Boolean)) {
    const [evLine, dataLine] = frame.split("\n")
    assert.equal(evLine.slice(7), JSON.parse(dataLine.slice(6)).type)
  }
})

test("anthropic stream: a tail still held when the block stops is delivered before the stop", () => {
  const sse = createSseRestorer("anthropic.messages", seeded([AWS]))
  const out =
    sse.feed(ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t", name: "x", input: {} } })) +
    sse.feed(ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"a":"${OGR' } })) +
    sse.feed(ev("content_block_stop", { type: "content_block_stop", index: 0 })) +
    sse.end()
  const data = payloads(out).map((d) => JSON.parse(d))
  assert.deepEqual(data.map((d) => d.type), ["content_block_start", "content_block_delta", "content_block_delta", "content_block_stop"])
  assert.equal(data[1].delta.partial_json + data[2].delta.partial_json, '{"a":"${OGR')
})

test("openai.responses stream: argument deltas restore, the .done and completed events restore whole inside arguments only", () => {
  const sse = createSseRestorer("openai.responses", seeded([AWS]))
  const item = { type: "function_call", id: "fc_1", call_id: "call_1", name: "bash", arguments: "" }
  const frames = [
    ev("response.output_item.added", { type: "response.output_item.added", output_index: 0, item }),
    ev("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"cmd":"OGRKP000' }),
    ev("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", output_index: 0, delta: '0001"}' }),
    ev("response.function_call_arguments.done", { type: "response.function_call_arguments.done", output_index: 0, arguments: '{"cmd":"OGRKP0000001"}' }),
    ev("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: { ...item, arguments: '{"cmd":"OGRKP0000001"}' } }),
    ev("response.output_text.delta", { type: "response.output_text.delta", output_index: 1, delta: "the key is OGRKP0000001" }),
    ev("response.completed", {
      type: "response.completed",
      response: { id: "r", output: [{ ...item, arguments: '{"cmd":"OGRKP0000001"}' }, { type: "message", content: [{ type: "output_text", text: "the key is OGRKP0000001" }] }] },
    }),
  ]
  let out = ""
  for (const f of frames) out += sse.feed(f)
  out += sse.end()
  const data = payloads(out).map((d) => JSON.parse(d))
  const deltas = data.filter((d) => d.type === "response.function_call_arguments.delta").map((d) => d.delta).join("")
  assert.deepEqual(JSON.parse(deltas), { cmd: AWS })
  assert.deepEqual(JSON.parse(data.find((d) => d.type === "response.function_call_arguments.done").arguments), { cmd: AWS })
  assert.deepEqual(JSON.parse(data.find((d) => d.type === "response.output_item.done").item.arguments), { cmd: AWS })
  const completed = data.find((d) => d.type === "response.completed").response
  assert.deepEqual(JSON.parse(completed.output[0].arguments), { cmd: AWS })
  assert.equal(completed.output[1].content[0].text, "the key is OGRKP0000001")
  assert.equal(data.find((d) => d.type === "response.output_text.delta").delta, "the key is OGRKP0000001")
})

test("a stream with nothing to restore passes through byte-identical, CRLF endings and comments included", () => {
  const sse = createSseRestorer("openai.chat", seeded([AWS]))
  const raw = ": keep-alive\r\n\r\n" + chatChunk({ content: "hi" }).replaceAll("\n", "\r\n") + "data: [DONE]\r\n\r\n"
  assert.equal(sse.feed(raw) + sse.end(), raw)
})

test("unresolved tokens in a streamed argument are reported once the field completes", () => {
  const seen = []
  const sse = createSseRestorer("openai.chat", seeded([AWS]), { onUnresolved: (t) => seen.push(...t) })
  sse.feed(chatChunk({ tool_calls: [{ index: 0, function: { arguments: '{"k":"OGRKP0000007"}' } }] }))
  sse.feed(chatChunk({}, "tool_calls"))
  sse.end()
  assert.deepEqual(seen, ["OGRKP0000007"])
})

test("openai.responses: Codex's CUSTOM tool call — input deltas, the done frames and the terminal output — restore, under its own spelling", () => {
  // Codex 0.153 runs its shell as a custom_tool_call whose `input` is a freeform
  // JS-repl program; found unrestored with mitmproxy behind the proxy (the tool ran
  // `printf '%s' 'OGRKP0000013' | wc -c` and answered 16).
  const sse = createSseRestorer("openai.responses", seeded([AWS]))
  const item = { id: "ctc_1", type: "custom_tool_call", name: "js_repl", call_id: "c1", status: "in_progress" }
  const program = `text(await tools.exec_command({cmd:"printf '%s' '${"OGRKP0000001"}' | wc -c"}));`
  const frames = [
    ev("response.output_item.added", { type: "response.output_item.added", output_index: 0, item }),
    ev("response.custom_tool_call_input.delta", { type: "response.custom_tool_call_input.delta", output_index: 0, delta: "text(await tools.exec_command({cmd:\"printf '%s' 'OGRKP000" }),
    ev("response.custom_tool_call_input.delta", { type: "response.custom_tool_call_input.delta", output_index: 0, delta: "0001' | wc -c\"}));" }),
    ev("response.custom_tool_call_input.done", { type: "response.custom_tool_call_input.done", output_index: 0, input: program }),
    ev("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: { ...item, status: "completed", input: program } }),
    ev("response.completed", { type: "response.completed", response: { id: "r", output: [{ ...item, status: "completed", input: program }] } }),
  ]
  let out = ""
  for (const f of frames) out += sse.feed(f)
  out += sse.end()
  const data = payloads(out).map((d) => JSON.parse(d))
  const expected = `text(await tools.exec_command({cmd:"printf '%s' '${AWS}' | wc -c"}));`
  const deltas = data.filter((d) => d.type === "response.custom_tool_call_input.delta").map((d) => d.delta).join("")
  assert.equal(deltas, expected)
  assert.equal(data.some((d) => d.type === "response.function_call_arguments.delta"), false, "a custom-tool tail must never be flushed under the function-call spelling")
  assert.equal(data.find((d) => d.type === "response.custom_tool_call_input.done").input, expected)
  assert.equal(data.find((d) => d.type === "response.output_item.done").item.input, expected)
  assert.equal(data.find((d) => d.type === "response.completed").response.output[0].input, expected)
})
