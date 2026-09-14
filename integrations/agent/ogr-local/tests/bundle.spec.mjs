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
 *
 * ⚠️⚠️ **THE STAMP IS ONLY WORTH ANYTHING IF IT COVERS WHAT ACTUALLY SHIPPED**,
 * and for a while it did not: it hashed a `readdirSync` of two `src/`
 * directories while esbuild inlined the dependency's compiled `dist/*.js`.
 * The two could move independently in BOTH directions, and either way this
 * test stayed green over a wrong artifact. It is derived from esbuild's own
 * metafile now, so the last case below asserts the property that makes the
 * first one mean something.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { LocalRedactor, writeCachedRuleset } from "@openguardrails/local-redaction"

import { TARGETS, STAMP_MARKER, sourceStamp, buildBundle } from "../scripts/bundle.mjs"

test("every plugin's bundle was built from the current source", async () => {
  const want = await sourceStamp()
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

test("the stamp covers every input the bundle is made of, from source", async () => {
  const { paths, stamp } = await buildBundle()
  // ⚠️ A `dist/` here means the artifact carries a COMPILED copy of the
  // dependency while a reviewer reads its TypeScript — and it means the stamp
  // can go stale in a direction nothing reports (edit src, skip tsc, rebuild:
  // same bytes, different stamp). The alias in bundle.mjs is what keeps this
  // true; deleting it turns this red rather than turning the guard into a lie.
  const compiled = paths.filter((p) => p.includes("/dist/"))
  assert.deepEqual(compiled, [], `bundle inlines compiled copies: ${compiled.join(", ")}`)
  // Both packages, or the stamp is watching one of them.
  assert.ok(paths.some((p) => p.startsWith("ogr-local/src/")), "no ogr-local sources")
  assert.ok(
    paths.some((p) => p.startsWith("local-redaction/src/")),
    "the bundled dependency is not in the stamp",
  )
  // ⚠️ The stamp must not depend on WHERE the build ran: esbuild keys its
  // metafile relative to the process cwd, and this script runs from the
  // package dir (`npm --prefix … run bundle`) AND from the repo root
  // (`npm test --workspaces`). Two stamps for one source is a red test that
  // means nothing, so this rebuilds from a directory that is neither.
  const cwd = process.cwd()
  process.chdir(tmpdir())
  try {
    assert.equal(await sourceStamp(), stamp, "the stamp changed with the working directory")
  } finally {
    process.chdir(cwd)
  }
})

/**
 * ⚠️⚠️ **AND ONE ROUND TRIP THROUGH THE ARTIFACT ITSELF.** `proxy.spec.mjs` is
 * thorough and imports `../dist/index.js` — the SOURCE build. Nothing ran the
 * checked-in bundle beyond asking whether it imports and exports the right
 * names, so the behaviour the plugins depend on was asserted about a different
 * build of the thing we ship. That is the same blindness that let the stamp
 * defect above sit unnoticed: every green test was about the source.
 *
 * ⚠️ **WHAT THIS DOES AND DOES NOT COVER, because a test that overstates its
 * reach is worse than none.** The redactor is constructed from the PACKAGE, so
 * the mask/restore ALGORITHM under test is the package's, not the bundle's
 * inlined copy of it — that half is already covered by `local-redaction`'s own
 * suite. What is the ARTIFACT's here is everything between: the server, the
 * `/http/<host>/<path>` routing, the body round trip, the delegation to the
 * redactor on both legs, and putting the real value back into the tool's
 * arguments. Confirmed to go red when the artifact's route prefix is mutated.
 */
const KEY = "sk-proj-abcdefghijklmnopqrstuvwx"

test("the shipped bundle proxies a redaction round trip end to end", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ogr-bundle-"))
  const seen = []
  const provider = createServer((req, res) => {
    let body = ""
    req.on("data", (c) => { body += c })
    req.on("end", () => {
      seen.push(body)
      const payload = Buffer.from(JSON.stringify({
        id: "msg_1",
        content: [{ type: "tool_use", id: "t1", name: "deploy", input: { token: "OGRK00000001" } }],
      }))
      res.writeHead(200, { "content-type": "application/json", "content-length": String(payload.length) })
      res.end(payload)
    })
  })
  await new Promise((r) => provider.listen(0, "127.0.0.1", r))
  const upstreamPort = provider.address().port

  const redactor = new LocalRedactor({
    source: () => null,
    cachePath: join(dir, "rules.json"),
    log: { info: () => {}, warn: () => {} },
  })
  writeCachedRuleset(join(dir, "rules.json"), {
    id: "rs_bundletest",
    generated_at: "2026-08-29T00:00:00Z",
    family: "secrets",
    dialect: "ogr-re-1",
    rules: [{
      id: "entity_api_key",
      category: "secrets",
      severity: "critical",
      tier: "strong",
      flags: "",
      patterns: [{ id: "openai_project", source: "sk-proj-[A-Za-z0-9_-]{20,}" }],
      examples: { match: [KEY], nomatch: ["sk-proj-short"] },
    }],
  })
  await redactor.start()
  redactor.fallbackActive = true

  // The BUNDLE, not ../dist — that is the whole point of this case.
  const { startProxy } = await import(TARGETS[0])
  const proxy = await startProxy({ redactor, hosts: ["127.0.0.1"], log: { info: () => {}, warn: () => {} } })
  try {
    const res = await fetch(`${proxy.url}/http/127.0.0.1:${upstreamPort}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sk-ant-user-key" },
      body: JSON.stringify({
        model: "claude",
        system: `use ${KEY}`,
        messages: [{ role: "user", content: "deploy" }],
      }),
    })
    const back = await res.json()
    assert.equal(seen[0].includes(KEY), false, "the credential reached the provider")
    assert.match(seen[0], /OGRK00000001/)
    assert.equal(back.content[0].input.token, KEY, "the harness did not get the value back")
  } finally {
    await proxy.close()
    await new Promise((r) => provider.close(r))
    rmSync(dir, { recursive: true, force: true })
  }
})
