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
 */
import { build } from "esbuild"
import { createHash } from "node:crypto"
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, "..")
const agents = join(root, "..")

/** Every plugin that ships a copy, and the file it ships it as. */
export const TARGETS = [
  join(agents, "claude-code", "hooks", "ogr-local.mjs"),
  join(agents, "codex", "hooks", "ogr-local.mjs"),
]

/** The sources the bundle is made of — both packages, in a stable order. */
function sourceFiles() {
  const dirs = [join(root, "src"), join(agents, "local-redaction", "src")]
  const files = []
  for (const dir of dirs) {
    for (const name of readdirSync(dir).sort()) {
      if (name.endsWith(".ts")) files.push(join(dir, name))
    }
  }
  return files
}

/** The stamp: 12 hex of a hash over every source byte. */
export function sourceStamp() {
  const h = createHash("sha256")
  for (const file of sourceFiles()) {
    h.update(file.slice(agents.length))
    h.update(readFileSync(file))
  }
  return h.digest("hex").slice(0, 12)
}

export const STAMP_MARKER = "OGR_LOCAL_SOURCE_STAMP"

export async function bundle() {
  const stamp = sourceStamp()
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version
  const result = await build({
    entryPoints: [join(root, "src", "bundle.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node18",
    // Readable on purpose: this file is checked in, and a reviewer who can
    // open it is the only review a build artifact ever gets.
    minify: false,
    legalComments: "inline",
    write: false,
    banner: {
      js: [
        "// GENERATED — do not edit. Source: integrations/agent/ogr-local/src",
        "// Rebuild: npm --prefix integrations/agent/ogr-local run bundle",
        `// ${STAMP_MARKER}=${stamp}`,
        `// version=${version}`,
      ].join("\n"),
    },
  })
  const code = result.outputFiles[0].text
  for (const target of TARGETS) writeFileSync(target, code)
  return { stamp, version, bytes: code.length }
}

if (process.argv[1] && process.argv[1].endsWith("bundle.mjs")) {
  const { stamp, version, bytes } = await bundle()
  console.log(`ogr-local ${version} (${stamp}) → ${(bytes / 1024).toFixed(0)} KB × ${TARGETS.length}`)
}
