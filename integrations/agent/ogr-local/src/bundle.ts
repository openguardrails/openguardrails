/**
 * The single-file entry point: what esbuild turns into
 * `<plugin>/hooks/ogr-local.mjs`.
 *
 * ⚠️⚠️ **WHY THIS IS A BUNDLE AND NOT AN npm PACKAGE.** Claude Code and
 * Codex plugins install as a DIRECTORY out of this repo — no `npm install`,
 * no build step, each hook a file the host runs with `node`. A proxy the
 * user had to `npm i -g` separately would be a second install step in front
 * of a feature whose whole point is that it needs no thought, and the
 * commonest outcome of a second install step is that it does not happen: the
 * harness then runs with a base URL pointing at nothing, or — worse — with
 * masking quietly off. So the proxy ships INSIDE each plugin, already built.
 *
 * ⚠️ **The source lives in ONE place** (`integrations/agent/ogr-local/src`,
 * beside `local-redaction`), and both plugins get a build of it. Copying the
 * masking core into two plugin directories is the drift the conformance
 * corpus exists to prevent — two harnesses masking the same secret two ways
 * is worse than either behaviour on its own.
 *
 * This file is both a MODULE (a `SessionStart` hook imports {@link ensure})
 * and a SCRIPT (the daemon re-executes it with `serve`). The dispatch below
 * fires only in the second case; a top-level `main()` would otherwise run on
 * the hook's own argv every time it imports this to call `ensure`.
 */
import { pathToFileURL } from "node:url"

import { main } from "./cli.js"

export { main } from "./cli.js"
export { baseUrlFor, DEFAULT_PORT, ensure, port, probe, stateDir, type EnsureOptions, type Status } from "./daemon.js"
export { startProxy, upstreamFor, type ProxyOptions, type RunningProxy } from "./server.js"
export { Pipe, DEFAULT_SESSION, type Masked, type PipeOptions } from "./pipe.js"

/** Whether this file is what `node` was asked to run, rather than something imported. */
function invokedAsScript(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return pathToFileURL(entry).href === import.meta.url
  } catch {
    return false
  }
}

if (invokedAsScript()) {
  void main().catch((err: unknown) => {
    console.error(`[ogr-local] ${String(err)}`)
    process.exit(1)
  })
}
