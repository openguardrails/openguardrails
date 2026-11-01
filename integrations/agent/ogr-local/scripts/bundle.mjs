/**
 * Build `<plugin>/hooks/ogr-local.mjs` for every plugin that ships the proxy.
 *
 * The two plugins that need a masking proxy install as directories out of
 * this repo, with no `npm install` and no build step — so the artifact has to
 * be CHECKED IN. A checked-in build can drift from its source silently, which
 * is the one real cost of doing it this way, so every bundle carries a STAMP:
 * a hash of the exact sources it was built from. `tests/bundle.spec.mjs`
 * recomputes that hash and fails when it does not match, which turns "someone
 * edited the source and forgot to rebuild" from an invisible state into a red
 * test.
 *
 * ⚠️⚠️ **THE STAMP IS DERIVED FROM WHAT ESBUILD ACTUALLY READ, NEVER FROM A
 * LIST OF DIRECTORIES** (2026-09-08). It used to be a `readdirSync` over the
 * top-level `*.ts` of two hard-coded `src/` folders. That covered both
 * packages — the bundled dependency included, which a note in the 0.2.0
 * CHANGELOG wrongly claimed it did not — and it was still the wrong shape:
 * the listing and the bundle are two independent answers to "what went in".
 * A subdirectory under either `src/`, a third package pulled in by an import,
 * or a file reached through a path the listing does not walk would all be
 * BUNDLED and UNHASHED — and the stamp would go on looking like coverage
 * while covering less. That failure is silent by construction, because the
 * only thing that would report it is the stamp itself. The metafile is
 * esbuild's own record of every input it read, so "the stamp covers exactly
 * what shipped" is now structural rather than a convention two directories
 * have to keep.
 */
import { build } from "esbuild"
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, "..")
const agents = join(root, "..")

/** Every plugin that ships a copy, and the file it ships it as. */
export const TARGETS = [
  join(agents, "claude-code", "hooks", "ogr-local.mjs"),
  join(agents, "codex", "hooks", "ogr-local.mjs"),
]

export const STAMP_MARKER = "OGR_LOCAL_SOURCE_STAMP"

/**
 * The stamp: 12 hex over every input esbuild read, keyed by a path relative to
 * `integrations/agent` so it does not depend on where the build ran (see
 * `absWorkingDir` below, which is the half that makes this true).
 */
function stampOf(metafile) {
  const paths = Object.keys(metafile.inputs)
    .map((p) => relative(agents, resolve(agents, p)).split(sep).join("/"))
    .sort()
  const h = createHash("sha256")
  for (const p of paths) {
    h.update(p)
    h.update(readFileSync(join(agents, ...p.split("/"))))
  }
  return { stamp: h.digest("hex").slice(0, 12), paths }
}

/**
 * Build once and return the artifact. ONE build, because the banner carries
 * the stamp and the stamp comes out of the build: the banner is plain text
 * prepended to the output, so it is prepended here rather than handed to
 * esbuild's `banner` option, which would have needed a second pass.
 */
export async function buildBundle() {
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version
  const result = await build({
    entryPoints: [join(root, "src", "bundle.ts")],
    // ⚠️ PINNED, because esbuild keys `metafile.inputs` relative to its working
    // directory and defaults that to `process.cwd()` — and this runs from the
    // package dir (`npm --prefix … run bundle`), from the repo root
    // (`npm test --workspaces`) and from wherever a test chdir'd to. Left to the
    // default, one set of sources hashes to a different stamp per caller, which
    // is a guard that fails for a reason that has nothing to do with the code.
    absWorkingDir: agents,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node18",
    // Readable on purpose: this file is checked in, and a reviewer who can
    // open it is the only review a build artifact ever gets.
    minify: false,
    legalComments: "inline",
    write: false,
    metafile: true,
    // ⚠️⚠️ **THE DEPENDENCY IS BUNDLED FROM ITS TYPESCRIPT SOURCE, NOT FROM
    // ITS `dist/`** (2026-09-08). Its `exports` points at `dist/index.js`, so
    // without this the artifact inlined a COMPILED copy while the stamp
    // hashed `src/*.ts` — two different answers to "what is in this file".
    // Both directions lied: edit `src` without running `tsc` there and the
    // stamp moved while the shipped bytes did not; rebuild `dist` without
    // touching `src` and the bytes moved while the stamp did not. Reading the
    // source removes the intermediate entirely — esbuild compiles TS, and
    // `verbatimModuleSyntax` in that package means every type-only import is
    // already marked, so nothing is lost. ⚠️ It also drops a build-ORDER
    // dependency nobody had written down: this used to need
    // `npm run build --workspaces` to have compiled local-redaction FIRST,
    // which is true only because of the order its `workspaces` array happens
    // to list. Type checking is unaffected — that package still runs `tsc` in
    // its own `pretest`.
    alias: { "@openguardrails/local-redaction": join(agents, "local-redaction", "src", "index.ts") },
  })
  const { stamp, paths } = stampOf(result.metafile)
  const banner = [
    "// GENERATED — do not edit. Source: integrations/agent/ogr-local/src",
    "// Rebuild: npm --prefix integrations/agent/ogr-local run bundle",
    `// ${STAMP_MARKER}=${stamp}`,
    `// version=${version}`,
  ].join("\n")
  return { stamp, version, paths, code: `${banner}\n${result.outputFiles[0].text}` }
}

/** The stamp the checked-in bundles OUGHT to carry. Builds, by design. */
export async function sourceStamp() {
  return (await buildBundle()).stamp
}

export async function bundle() {
  const { stamp, version, paths, code } = await buildBundle()
  for (const target of TARGETS) writeFileSync(target, code)
  return { stamp, version, paths, bytes: code.length }
}

if (process.argv[1] && process.argv[1].endsWith("bundle.mjs")) {
  const { stamp, version, paths, bytes } = await bundle()
  console.log(
    `ogr-local ${version} (${stamp}, ${paths.length} inputs) → ` +
      `${(bytes / 1024).toFixed(0)} KB × ${TARGETS.length}`,
  )
}
