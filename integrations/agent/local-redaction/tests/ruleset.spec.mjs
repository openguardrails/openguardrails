/**
 * The ruleset: self-verification at load, the tier filter, and the feed's
 * cache contract (ETag/304, 0600, atomic, fail-to-cache).
 */
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { compileRuleset, defaultCachePath, loadRuleset, LocalRedactor, mask, SessionMap } from "../dist/index.js"

const corpus = JSON.parse(readFileSync(new URL("../conformance/local-redaction.json", import.meta.url), "utf8"))

const rule = (over) => ({
  id: "entity_x",
  category: "security.secret_leak.api_key",
  severity: "critical",
  tier: "strong",
  flags: "",
  patterns: [{ id: "p", source: "AKIA[A-Z0-9]{16}" }],
  examples: { match: ["AKIAIOSFODNN7EXAMPLE"], nomatch: ["akia"] },
  ...over,
})
const ruleset = (rules) => ({ id: "rs_test", generated_at: "2026-08-28T00:00:00Z", family: "secrets", dialect: "ogr-re-1", rules })

test("a rule whose match example yields no span is disabled by id, with the reason, and the rest run", () => {
  const logged = []
  const c = compileRuleset(
    ruleset([rule({ id: "entity_bad", examples: { match: ["nothing here"], nomatch: [] } }), rule({ id: "entity_good" })]),
    { log: (m) => logged.push(m) },
  )
  assert.deepEqual(c.rules.map((r) => r.id), ["entity_good"])
  assert.equal(c.disabled.length, 1)
  assert.equal(c.disabled[0].id, "entity_bad")
  assert.match(c.disabled[0].reason, /match example yielded no span/)
  assert.match(logged[0], /rule entity_bad disabled/)
})

test("a rule whose nomatch example yields a span is disabled", () => {
  const c = compileRuleset(ruleset([rule({ examples: { match: [], nomatch: ["AKIAIOSFODNN7EXAMPLE"] } })]))
  assert.deepEqual(c.rules, [])
  assert.match(c.disabled[0].reason, /nomatch example yielded a span/)
})

test("a pattern that does not compile in this engine disables its rule instead of matching nothing", () => {
  const c = compileRuleset(ruleset([rule({ patterns: [{ id: "p", source: "(unbalanced" }] })]))
  assert.deepEqual(c.rules, [])
  assert.match(c.disabled[0].reason, /does not compile/)
})

test("a group names the span, and needs the d flag the compiler adds", () => {
  const c = compileRuleset(ruleset([rule({ patterns: [{ id: "p", source: "key=(AKIA[A-Z0-9]{16})" }], group: 1, examples: { match: ["key=AKIAIOSFODNN7EXAMPLE"], nomatch: [] } })]))
  assert.equal(c.rules.length, 1)
  const r = mask("key=AKIAIOSFODNN7EXAMPLE", new SessionMap("s"), c)
  assert.equal(r.text, "key=${OGR_SECRET_1}")
})

test("tiers: the heuristic tier is honoured by default and can be left out", () => {
  const rs = ruleset([rule({ id: "entity_strong" }), rule({ id: "entity_weak", tier: "heuristic" })])
  assert.deepEqual(compileRuleset(rs).rules.map((r) => r.id), ["entity_strong", "entity_weak"])
  const strongOnly = compileRuleset(rs, { tiers: ["strong"] })
  assert.deepEqual(strongOnly.rules.map((r) => r.id), ["entity_strong"])
  assert.deepEqual(strongOnly.skipped, ["entity_weak"])
  assert.deepEqual(strongOnly.disabled, [])
})

/** A fetch stand-in serving one ruleset with an ETag, counting calls. */
function feed(rs, opts = {}) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers })
    if (opts.fail) throw new Error("ECONNREFUSED")
    if (opts.status) return new Response(JSON.stringify({ error: "x" }), { status: opts.status })
    if (init.headers["if-none-match"] === `"${rs.id}"`) return new Response(null, { status: 304 })
    return new Response(JSON.stringify({ ruleset: rs }), { status: 200, headers: { etag: `"${rs.id}"` } })
  }
  return { fetchImpl, calls }
}

test("loadRuleset: fetched, cached at 0600, then 304 keeps the cache; a later id replaces it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ogr-rules-"))
  const cachePath = join(dir, "nested", "rules.json")
  const rs = corpus.ruleset
  const f = feed(rs)
  const first = await loadRuleset({ runtimeUrl: "http://rt/api/", apiKey: "k", cachePath, fetch: f.fetchImpl })
  assert.equal(first.source, "fetched")
  assert.equal(first.ruleset.id, rs.id)
  assert.equal(f.calls[0].url, "http://rt/api/v1/rules")
  assert.equal(f.calls[0].headers.authorization, "Bearer k")
  assert.equal(statSync(cachePath).mode & 0o777, 0o600)
  assert.equal(JSON.parse(readFileSync(cachePath, "utf8")).id, rs.id)

  const second = await loadRuleset({ runtimeUrl: "http://rt/api/", apiKey: "k", cachePath, fetch: f.fetchImpl })
  assert.equal(second.source, "cached")
  assert.equal(f.calls[1].headers["if-none-match"], `"${rs.id}"`)

  const rotated = { ...rs, id: "rs_rotated" }
  const g = feed(rotated)
  const third = await loadRuleset({ runtimeUrl: "http://rt/api/", apiKey: "k", cachePath, fetch: g.fetchImpl })
  assert.equal(third.source, "fetched")
  assert.equal(third.ruleset.id, "rs_rotated")
  assert.equal(JSON.parse(readFileSync(cachePath, "utf8")).id, "rs_rotated")
})

test("loadRuleset: a failed fetch answers with the cache, and with none when there is none", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ogr-rules-"))
  const cachePath = join(dir, "rules.json")
  const none = await loadRuleset({ runtimeUrl: "http://rt", apiKey: "k", cachePath, fetch: feed(corpus.ruleset, { fail: true }).fetchImpl })
  assert.equal(none.source, "none")
  assert.equal(none.ruleset, null)
  assert.match(none.error, /fetch failed/)
  await loadRuleset({ runtimeUrl: "http://rt", apiKey: "k", cachePath, fetch: feed(corpus.ruleset).fetchImpl })
  const denied = await loadRuleset({ runtimeUrl: "http://rt", apiKey: "k", cachePath, fetch: feed(corpus.ruleset, { status: 401 }).fetchImpl })
  assert.equal(denied.source, "cached")
  assert.equal(denied.ruleset.id, corpus.ruleset.id)
  assert.match(denied.error, /answered 401/)
})

test("the default cache path is per runtime URL under ~/.openguardrails", () => {
  const a = defaultCachePath("https://openguardrails.com")
  const b = defaultCachePath("https://other.example")
  assert.match(a, /\.openguardrails\/rules-[0-9a-f]{8}\.json$/)
  assert.notEqual(a, b)
})

test("LocalRedactor: start() awaits the first fetch when nothing is cached, then reports the id and refetches on a heartbeat's say-so", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ogr-rules-"))
  const cachePath = join(dir, "rules.json")
  const f = feed(corpus.ruleset)
  const logs = []
  const red = new LocalRedactor({
    source: () => ({ runtimeUrl: "http://rt", apiKey: "k" }),
    cachePath,
    fetch: f.fetchImpl,
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
  })
  assert.equal(red.ready, false)
  assert.equal(red.rulesetId, "")
  await red.start()
  assert.equal(red.ready, true)
  assert.equal(red.rulesetId, corpus.ruleset.id)
  assert.match(logs[0], /ruleset rs_conformance.* \(fetched\) — 3 rules/)

  const r = red.mask("sess", "AKIAIOSFODNN7EXAMPLE")
  assert.equal(r.text, "${OGR_SECRET_1}")
  assert.deepEqual(red.report("sess"), { ruleset: corpus.ruleset.id, masked: [{ token: "${OGR_SECRET_1}", rule: "entity_aws_key_id/aws_access_key_id" }] })
  assert.deepEqual(red.report("sess"), { ruleset: corpus.ruleset.id, masked: [] }) // drained

  // The same id on the heartbeat: nothing happens. A new id: one refetch.
  const before = f.calls.length
  red.onHeartbeat({ ok: true, rules: { id: corpus.ruleset.id } })
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(f.calls.length, before)
  red.onHeartbeat({ ok: true, rules: { id: "rs_new" } })
  await red.refresh()
  assert.equal(f.calls.length, before + 1)
})

test("LocalRedactor: a cached ruleset masks at once and start() does not wait on the network", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ogr-rules-"))
  const cachePath = join(dir, "rules.json")
  await loadRuleset({ runtimeUrl: "http://rt", apiKey: "k", cachePath, fetch: feed(corpus.ruleset).fetchImpl })
  let release
  const slow = new Promise((r) => { release = r })
  const red = new LocalRedactor({
    source: () => ({ runtimeUrl: "http://rt", apiKey: "k" }),
    cachePath,
    fetch: async () => { await slow; return new Response(null, { status: 304 }) },
    log: { info: () => {}, warn: () => {} },
  })
  const started = red.start()
  assert.equal(red.ready, true) // synchronously, from the cache
  await started
  release()
})
