/**
 * mask()/restore() beyond the corpus: the round trip, the bound, the request
 * walk, and the shapes a harness actually hands over.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import {
  compileRuleset,
  mask,
  maskKnown,
  maskRequest,
  OVERFLOW_TOKEN,
  restore,
  restoreArgs,
  SessionMap,
  SessionMaps,
  UNRESTORABLE_NOTICE,
} from "../dist/index.js"

const corpus = JSON.parse(readFileSync(new URL("../conformance/local-redaction.json", import.meta.url), "utf8"))
const compiled = compileRuleset(corpus.ruleset)

const AWS = "AKIAIOSFODNN7EXAMPLE"
const OPENAI = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789"

test("round trip: a masked value restores into a tool's arguments, and only there", () => {
  const map = new SessionMap("s1")
  const out = mask(`export AWS_ACCESS_KEY_ID=${AWS}`, map, compiled)
  assert.equal(out.text, "export AWS_ACCESS_KEY_ID=OGRK00000001")
  // The model, having seen the token, uses it in a call.
  const args = { command: "aws s3 ls", env: { AWS_ACCESS_KEY_ID: "OGRK00000001" }, list: ["OGRK00000001", 3, null] }
  const r = restoreArgs(args, map)
  assert.deepEqual(r.args, { command: "aws s3 ls", env: { AWS_ACCESS_KEY_ID: AWS }, list: [AWS, 3, null] })
  assert.deepEqual(r.unresolved, [])
  assert.equal(r.changed, true)
  // The original object is not mutated.
  assert.equal(args.env.AWS_ACCESS_KEY_ID, "OGRK00000001")
})

test("restoreArgs reports every unresolved token once and leaves the args untouched", () => {
  const map = new SessionMap("s1")
  const args = { a: "OGRK00000004", b: ["OGRK00000004", "OGRKXXXXXXXX"] }
  const r = restoreArgs(args, map)
  assert.equal(r.args, args)
  assert.equal(r.changed, false)
  assert.deepEqual(r.unresolved.sort(), ["OGRK00000004", "OGRKXXXXXXXX"])
  assert.match(UNRESTORABLE_NOTICE("OGRK00000004"), /^OGRK00000004 could not be restored: it is not a placeholder this session issued\./)
})

test("value stability across steps and across the walk", () => {
  const map = new SessionMap("s1")
  const a = mask(`first ${OPENAI}`, map, compiled)
  const b = maskRequest({ messages: [{ role: "user", content: `again ${OPENAI}` }] }, map, compiled)
  assert.equal(a.text, "first OGRK00000001")
  assert.equal(b.value.messages[0].content, "again OGRK00000001")
  assert.deepEqual(b.minted, [])
})

test("the bound: value 257 is masked with the non-restorable overflow token and warned once", () => {
  const warnings = []
  const map = new SessionMap("s1", { bound: 3, warn: (m) => warnings.push(m) })
  const keys = ["AKIAIOSFODNN7EXAMPL1", "AKIAIOSFODNN7EXAMPL2", "AKIAIOSFODNN7EXAMPL3", "AKIAIOSFODNN7EXAMPL4", "AKIAIOSFODNN7EXAMPL5"]
  const r = mask(keys.join(" "), map, compiled)
  assert.equal(r.text, `\OGRK00000001 \OGRK00000002 \OGRK00000003 ${OVERFLOW_TOKEN} ${OVERFLOW_TOKEN}`)
  assert.equal(map.size, 3)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /holds 3 secrets/)
  // Still masked (the wrong side to fail on), never restorable.
  const back = restore(r.text, map)
  assert.deepEqual(back.unresolved, [OVERFLOW_TOKEN])
  assert.equal(back.text, `${keys[0]} ${keys[1]} ${keys[2]} ${OVERFLOW_TOKEN} ${OVERFLOW_TOKEN}`)
  // The minted report names the overflow token once per call.
  assert.equal(r.minted.filter((m) => m.token === OVERFLOW_TOKEN).length, 1)
})

test("the request walk keeps structure, indexes and structural keys", () => {
  const map = new SessionMap("s1")
  const body = {
    model: "gpt-4.1",
    messages: [
      { role: "system", content: `You hold ${AWS}.` },
      { role: "user", content: [{ type: "text", text: `use ${OPENAI}` }, { type: "image_url", image_url: { url: "data:..." } }] },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: `{"command":"echo ${AWS}"}` } }] },
      { role: "tool", tool_call_id: "call_1", content: `${AWS}\n` },
    ],
    tools: [{ type: "function", function: { name: "bash", description: `never print ${AWS}`, parameters: { type: "object" } } }],
    temperature: 0.2,
  }
  const r = maskRequest(body, map, compiled)
  const out = r.value
  assert.equal(out.messages.length, 4)
  assert.deepEqual(out.messages.map((m) => m.role), ["system", "user", "assistant", "tool"])
  assert.equal(out.messages[0].content, "You hold OGRK00000001.")
  assert.equal(out.messages[1].content[0].text, "use OGRK00000002")
  assert.deepEqual(out.messages[1].content[1], { type: "image_url", image_url: { url: "data:..." } })
  assert.equal(out.messages[2].content, null)
  assert.equal(out.messages[2].tool_calls[0].id, "call_1")
  assert.equal(out.messages[2].tool_calls[0].function.name, "bash")
  assert.equal(out.messages[2].tool_calls[0].function.arguments, '{"command":"echo OGRK00000001"}')
  assert.equal(out.messages[3].content, "OGRK00000001\n")
  assert.equal(out.tools[0].function.description, "never print OGRK00000001")
  assert.equal(out.temperature, 0.2)
  assert.equal(out.model, "gpt-4.1")
  assert.deepEqual(r.minted.map((m) => m.token), ["OGRK00000001", "OGRK00000002"])
  // The input body is untouched.
  assert.equal(body.messages[0].content, `You hold ${AWS}.`)
})

test("a Responses-style input and an anthropic system block are leaves too", () => {
  const map = new SessionMap("s1")
  const r = maskRequest(
    {
      system: [{ type: "text", text: `key ${AWS}` }],
      input: [{ role: "user", content: [{ type: "input_text", text: `and ${AWS}` }] }],
    },
    map,
    compiled,
  )
  assert.equal(r.value.system[0].text, "key OGRK00000001")
  assert.equal(r.value.input[0].content[0].text, "and OGRK00000001")
})

test("maskKnown runs no rules: the egress pass replaces only what the session already holds", () => {
  const map = new SessionMap("s1")
  mask(AWS, map, compiled)
  const r = maskKnown({ tool_calls: [{ id: "c", name: "bash", arguments: { command: `echo ${AWS} ${OPENAI}` } }] }, map)
  assert.equal(r.value.tool_calls[0].arguments.command, `echo \OGRK00000001 ${OPENAI}`)
  assert.deepEqual(r.minted, [])
  assert.equal(r.changed, true)
})

test("an unchanged walk hands back the very same object", () => {
  const map = new SessionMap("s1")
  const body = { messages: [{ role: "user", content: "hello" }] }
  const r = maskRequest(body, map, compiled)
  assert.equal(r.value, body)
  assert.equal(r.changed, false)
})

test("SessionMaps: one map per session id, oldest dropped at the session bound", () => {
  const maps = new SessionMaps({ maxSessions: 2 })
  const a = maps.get("a")
  assert.equal(maps.get("a"), a)
  maps.get("b")
  maps.get("c") // evicts a
  assert.equal(maps.peek("a"), undefined)
  assert.notEqual(maps.get("a"), a)
})

test("zero-width characters inside a token do not open it, and the splice keeps the rest of the text byte-exact", () => {
  const map = new SessionMap("s1")
  const text = `​pre ${AWS.slice(0, 5)}​‍${AWS.slice(5)} post​`
  const r = mask(text, map, compiled)
  assert.equal(r.text, "​pre OGRK00000001 post​")
  assert.equal(map.valueOf("OGRK00000001"), AWS)
})
