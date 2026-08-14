/**
 * Build the browser half into dsh's client-bundle handoff shape: a classic
 * script that registers a closure factory with the page's module loader —
 * `window.__ModuleLoader__.load({ id, factory })`, where `factory(require)`
 * returns the bundle's exports (`@deepseek-ai/dsh-client-modules` contract).
 * The bundle has no externals, so the injected `require` is never called.
 */
import { build } from "esbuild"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const { name } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))

await build({
  entryPoints: [`${root}src/client.ts`],
  outfile: `${root}dist/client.js`,
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(name)}, factory: function (require) { "use strict"; var module = { exports: {} }; var exports = module.exports;`,
  },
  footer: { js: "return module.exports; } });" },
})
