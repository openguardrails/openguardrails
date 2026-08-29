/**
 * The shared corpus: every mask/restore case in conformance/local-redaction.json,
 * run against this package the way the Python reference runs them.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { compileRuleset, createStreamRestorer, mask, restore, SessionMap } from "../dist/index.js"

const corpus = JSON.parse(readFileSync(new URL("../conformance/local-redaction.json", import.meta.url), "utf8"))

test("the corpus ruleset compiles with every rule enabled", () => {
  const compiled = compileRuleset(corpus.ruleset)
  assert.deepEqual(compiled.disabled, [])
  assert.equal(compiled.rules.length, corpus.ruleset.rules.length)
  assert.equal(compiled.id, corpus.ruleset.id)
})

for (const c of corpus.cases.mask) {
  test(`mask: ${c.name}`, () => {
    const compiled = compileRuleset(corpus.ruleset)
    const map = new SessionMap("conformance")
    c.steps.forEach((step, i) => {
      const r = mask(step, map, compiled)
      assert.equal(r.text, c.expect[i].text)
      assert.deepEqual(r.minted, c.expect[i].minted)
    })
    if (c.values) assert.deepEqual(Object.fromEntries(map.entries()), c.values)
  })
}

/**
 * Seed a map so each fixture token gets exactly its number: mint filler
 * values up to n-1, then the value — the counter is the only allocator.
 */
function seeded(fixture) {
  const map = new SessionMap("conformance")
  for (const [token, value] of Object.entries(fixture)) {
    const n = Number(/_([0-9]+)\}$/.exec(token)[1])
    while (map.size < n - 1) map.tokenFor(`filler-${map.size}`)
    const grant = map.tokenFor(value)
    assert.equal(grant.token, token, `fixture map must be seedable in order (${token})`)
  }
  return map
}

for (const c of corpus.cases.restore) {
  test(`restore: ${c.name}`, () => {
    const r = restore(c.input, seeded(c.map))
    assert.equal(r.text, c.expect.text)
    assert.deepEqual(r.unresolved, c.expect.unresolved)
  })
}

// The streaming form: each delta is fed with isLast=false against ONE held
// tail and must yield exactly expect[i]; `end` is what the final flush
// (isLast=true, no more text) delivers — a partial token is just text.
for (const c of corpus.cases.stream) {
  test(`stream: ${c.name}`, () => {
    const r = createStreamRestorer(seeded(c.map))
    const state = { pending: "" }
    c.deltas.forEach((delta, i) => {
      assert.equal(r.feed(state, delta, false), c.expect[i], `delta ${i}`)
    })
    assert.equal(r.feed(state, "", true), c.end)
    assert.equal(state.pending, "")
  })
}
