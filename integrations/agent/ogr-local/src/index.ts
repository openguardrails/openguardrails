/**
 * `@openguardrails/ogr-local` — local secrets redaction for harnesses whose
 * plugins run OUTSIDE the agent's process.
 *
 * hermes, opencode, openclaw and dsh install an in-process HTTP interceptor
 * (`@openguardrails/local-redaction`) and need nothing here. Claude Code and
 * Codex cannot: their hooks are separate processes — Codex's host is Rust —
 * so the seam moves one layer out, to a loopback proxy the harness's
 * provider base URL points at. Same ruleset, same session maps, same
 * `${OGR_SECRET_n}` contract; a different vantage.
 */
export { Pipe, DEFAULT_SESSION, type Masked, type PipeOptions } from "./pipe.js"
export { startProxy, upstreamFor, type ProxyOptions, type RunningProxy } from "./server.js"
export { baseUrlFor, DEFAULT_PORT, ensure, port, probe, stateDir, type EnsureOptions, type Status } from "./daemon.js"
