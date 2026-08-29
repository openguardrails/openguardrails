/**
 * The session key a masked request is filed under.
 *
 * This is the one part of dsh's local redaction that can be wrong WITHOUT
 * anything failing: the mask still happens, the restore still succeeds, and
 * the value it splices in is another conversation's secret. So the test is
 * written against the failure, not the feature — it drives two conversations
 * concurrently through the same shape the plugin uses (`llm/stream` hands a
 * session id, the adapter's `fetch` happens several frames later inside a
 * downstream async generator) and asserts each fetch sees its OWN key.
 *
 * The companion assertion is the point: the same test run against the
 * obvious `als.run(key, () => next())` sees `undefined` at both fetches.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { AsyncLocalStorage } from "node:async_hooks"

import { currentSessionKey, scopeSession, sessionKeyFor } from "../dist/redaction.js"

/**
 * A stand-in for dsh's adapter: an async generator that makes its HTTP call
 * midway and reports the session key the interceptor would have read.
 */
async function* adapter(seen, chunks = 3) {
  await new Promise((r) => setTimeout(r, 4))
  seen.push(currentSessionKey()) // the interceptor's vantage: inside the fetch
  for (let i = 0; i < chunks; i += 1) {
    yield i
    await new Promise((r) => setTimeout(r, 2))
  }
}

/** Cordis puts other listeners between the plugin and the adapter. */
async function* between(inner) {
  for await (const c of inner) yield c
}

test("two conversations in one process do not share a session key", async () => {
  const seen = []
  const drive = async (id) => {
    const key = sessionKeyFor(id)
    for await (const _ of scopeSession(key, between(adapter(seen)))) {
      // the consumer sits OUTSIDE the scope, exactly as the loop does
      assert.equal(currentSessionKey(), "process")
    }
  }
  await Promise.all([drive("sess-a"), drive("sess-b")])
  assert.deepEqual([...seen].sort(), ["sess-a", "sess-b"])
})

test("the obvious scoping is what this replaces: it sees nothing", async () => {
  // Kept as an executable statement of WHY `scopeSession` pulls rather than
  // wraps. `als.run(key, () => next())` scopes the CONSTRUCTION of the
  // downstream iterable; the generator body runs when the consumer pulls,
  // after that scope has exited. Every session would collapse onto one key.
  const storage = new AsyncLocalStorage()
  const seen = []
  const naive = async (id) => {
    const it = storage.run(id, () => between(adapter(seen)))
    for await (const _ of it) { /* drain */ }
  }
  await Promise.all([naive("sess-a"), naive("sess-b")])
  assert.deepEqual(seen, ["process", "process"], "the naive form loses the key — this is the bug, pinned")
})

test("a model call outside the loop shares the process-wide key", () => {
  assert.equal(sessionKeyFor(undefined), "process")
  assert.equal(sessionKeyFor(null), "process")
  assert.equal(sessionKeyFor("sess-1"), "sess-1")
  assert.equal(currentSessionKey(), "process")
})

test("breaking out of the stream tears the adapter down", async () => {
  let closed = false
  async function* closing() {
    try {
      yield 1
      yield 2
    } finally {
      closed = true
    }
  }
  for await (const _ of scopeSession("sess-a", closing())) break
  assert.equal(closed, true, "an abandoned stream must release the underlying response")
})
