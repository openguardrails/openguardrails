/**
 * The checked-in bundles.
 *
 * ⚠️⚠️ **A BUILD ARTIFACT IN THE REPO CAN GO STALE WITHOUT ANYTHING
 * FAILING**, and that is the one real cost of shipping the proxy inside the
 * plugins instead of publishing it. Nothing about editing `src/` makes
 * `hooks/ogr-local.mjs` wrong in a way a typecheck, a lint or the proxy's own
 * tests would notice — those all read the SOURCE. The plugins run the
 * BUNDLE. So the bundle carries a hash of the sources it was built from, and
 * this recomputes it.
 *
 * If this fails: `npm --prefix integrations/agent/ogr-local run bundle`.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import { TARGETS, STAMP_MARKER, sourceStamp } from "../scripts/bundle.mjs"

test("every plugin's bundle was built from the current source", () => {
  const want = sourceStamp()
  for (const target of TARGETS) {
    const text = readFileSync(target, "utf8")
    const m = new RegExp(`${STAMP_MARKER}=([0-9a-f]+)`).exec(text)
    assert.ok(m, `${target} carries no source stamp — was it hand-edited?`)
    assert.equal(
      m[1],
      want,
      `${target} is stale. Run: npm --prefix integrations/agent/ogr-local run bundle`,
    )
  }
})

test("the two plugins ship the identical build", () => {
  const [a, b] = TARGETS.map((t) => readFileSync(t))
  // Two harnesses masking the same secret two ways is worse than either
  // behaviour on its own — that is why the source lives in one place.
  assert.ok(a.equals(b), "the plugins' bundles differ")
})

test("the bundle is a module the hooks can import, and a script the daemon can run", async () => {
  const mod = await import(TARGETS[0])
  for (const name of ["ensure", "probe", "port", "baseUrlFor", "startProxy", "main"]) {
    assert.equal(typeof mod[name], "function", `the bundle does not export ${name}`)
  }
  // Importing must NOT run the CLI: a SessionStart hook imports this file to
  // call `ensure`, and a top-level dispatch would fire on the hook's argv.
  assert.equal(typeof mod.DEFAULT_PORT, "number")
})

test("the bundle carries no dependency the plugins cannot satisfy", () => {
  const text = readFileSync(TARGETS[0], "utf8")
  // A plugin installs as a directory: no node_modules, no npm install. A
  // surviving bare import would fail at the user's first session start.
  const imports = [...text.matchAll(/^import\s+.*?from\s+["']([^"']+)["']/gm)].map((m) => m[1])
  const bare = imports.filter((i) => !i.startsWith("node:"))
  assert.deepEqual(bare, [], `bundle still imports ${bare.join(", ")}`)
})
