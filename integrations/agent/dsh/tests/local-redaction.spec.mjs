/**
 * Local secrets redaction, end to end through the real plugin: what the
 * runtime is shown, and what it is told about it.
 *
 * ⚠️ The load-bearing claim is NOT "a token appeared". It is that the token
 * the runtime judges is the SAME token the model provider was given — one
 * session map, both destinations. dsh is the only integration that mints on
 * the OGR event rather than at a request-rewrite hook (its request is
 * frozen), so this is where that ordering is pinned.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { boot } from "./harness.mjs"
import { withRuntime, TEST_RULESET } from "./mock-runtime.mjs"

const KEY = "sk-proj-abcdefghijklmnopqrstuvwx"

const REQUEST = {
  provider: "test", model: "test-model", system: "You are dsh.",
  messages: [{
    id: "m1", role: "user",
    content: [{ type: "text", text: `deploy with ${KEY} please` }],
    source: { kind: "user" },
  }],
  tools: [],
  sessionId: "sess-1",
}

const ANSWER = [
  { type: "block-start", index: 0, blockType: "text" },
  { type: "block-end", index: 0, block: { type: "text", text: "Done." } },
  { type: "finish", reason: { kind: "stop" } },
]

/** A cache path under the OS temp dir — never the operator's real ~/.openguardrails. */
function withCache(body) {
  const dir = mkdtempSync(join(tmpdir(), "ogr-dsh-rules-"))
  const saved = process.env.OGR_RULES_CACHE
  process.env.OGR_RULES_CACHE = join(dir, "rules.json")
  return (async () => {
    try {
      return await body()
    } finally {
      if (saved === undefined) delete process.env.OGR_RULES_CACHE
      else process.env.OGR_RULES_CACHE = saved
      rmSync(dir, { recursive: true, force: true })
    }
  })()
}

test("the runtime is shown a token, never the key", async () => {
  await withCache(() =>
    withRuntime(boot, {}, () => "allow", async ({ stream, runtime }) => {
      await stream(REQUEST, ANSWER)
      const sent = JSON.stringify(runtime.received)
      assert.equal(sent.includes(KEY), false, "the API key reached the runtime in the clear")
      assert.match(sent, /\$\{OGR_SECRET_1\}/, "the key was not replaced by a placeholder")
    }, { rules: TEST_RULESET }))
})

test("the step reports WHAT it masked — tokens and a ruleset id, never values", async () => {
  await withCache(() =>
    withRuntime(boot, {}, () => "allow", async ({ stream, runtime }) => {
      await stream(REQUEST, ANSWER)
      const request = runtime.received.find((e) => e.kind === "step/request")
      assert.equal(request.redaction.ruleset, TEST_RULESET.id)
      assert.deepEqual(request.redaction.masked, [
        { token: "${OGR_SECRET_1}", rule: "entity_api_key/openai_project" },
      ])
      // The report is DRAINED: the same token must not be claimed twice, or
      // a coverage count is a count of events rather than of secrets.
      const response = runtime.received.find((e) => e.kind === "step/response")
      assert.deepEqual(response.redaction.masked, [])
    }, { rules: TEST_RULESET }))
})

test("one value, one token — across steps of the same session", async () => {
  await withCache(() =>
    withRuntime(boot, {}, () => "allow", async ({ stream, runtime }) => {
      await stream(REQUEST, ANSWER)
      await stream(REQUEST, ANSWER)
      const requests = runtime.received.filter((e) => e.kind === "step/request")
      assert.equal(requests.length, 2)
      const tokens = requests.map((e) => JSON.stringify(e.payload).match(/\$\{OGR_SECRET_\d+\}/)[0])
      assert.equal(tokens[0], tokens[1], "the same secret must map to the same token, or a restore picks one at random")
      // Minted ONCE. The second step re-uses the map entry, so it has
      // nothing new to report — that is what makes `masked` a count of
      // secrets rather than of mentions.
      assert.deepEqual(requests[1].redaction.masked, [])
    }, { rules: TEST_RULESET }))
})

test("two conversations get their own tokens", async () => {
  await withCache(() =>
    withRuntime(boot, {}, () => "allow", async ({ stream, runtime }) => {
      await stream(REQUEST, ANSWER)
      await stream({ ...REQUEST, sessionId: "sess-2" }, ANSWER)
      const per = runtime.received
        .filter((e) => e.kind === "step/request")
        .map((e) => e.redaction.masked.length)
      assert.deepEqual(per, [1, 1], "a second conversation must mint into its own map, not inherit the first's")
    }, { rules: TEST_RULESET }))
})

test("no ruleset served = on but unprotected, said on the wire rather than implied", async () => {
  await withCache(() =>
    withRuntime(boot, {}, () => "allow", async ({ stream, runtime }) => {
      await stream(REQUEST, ANSWER)
      const request = runtime.received.find((e) => e.kind === "step/request")
      // The key goes out in the clear — there is nothing to mask it with —
      // and the report says exactly that: masking is ON, ruleset is none.
      // A runtime reads this as `unprotected`, which is a different thing
      // from a host that never reported at all.
      assert.equal(request.redaction.ruleset, "")
      assert.equal(JSON.stringify(request.payload).includes(KEY), true)
    }))
})

test("switched off = no claim at all", async () => {
  await withCache(() =>
    withRuntime(boot, { localRedaction: { enabled: false } }, () => "allow", async ({ stream, runtime }) => {
      await stream(REQUEST, ANSWER)
      for (const event of runtime.received) {
        assert.equal("redaction" in event, false, "a host that is not masking must not send the field")
      }
    }, { rules: TEST_RULESET }))
})

test("the heartbeat advertises the ruleset once there is one to advertise", async () => {
  await withCache(() =>
    withRuntime(boot, { heartbeatS: 0.1 }, () => "allow", async ({ stream, runtime }) => {
      // The FIRST beat leaves at plugin start, before the interceptor has
      // settled and before the ruleset has landed — and it carries no
      // `rules` at all, which is the honest answer: an id from a process
      // that is not yet masking would read as coverage.
      assert.equal(runtime.beats[0].rules, undefined)
      await stream(REQUEST, ANSWER)
      await new Promise((r) => setTimeout(r, 250))
      const advertised = runtime.beats.filter((b) => b.rules !== undefined)
      assert.ok(advertised.length > 0, "no beat ever named the ruleset")
      assert.equal(advertised.at(-1).rules.id, TEST_RULESET.id)
    }, { rules: TEST_RULESET }))
})
