# Integrations (the plugin layer)

Integrations are the **plugin layer** of OGR's API → Plugin stack: a plugin
is a hook for one surface that observes steps, builds `GuardEvent`s, and
enforces `Verdict`s — speaking the
[Runtime API](../specification/runtime-api.md) (`/v1/evaluate`,
`/v1/ingest`) directly. There is no SDK layer: each plugin implements one of
the two normative
[integration recipes](../specification/runtime-api.md#the-two-integration-recipes),
and its README says which.

Two hook categories:

| Category | Recipe | Purpose |
|---|---|---|
| [`agent/`](agent/) | A (agent-direct) | Inside the harness loop: declares `session_id`/`turn`/`step` on every event and reports each turn's close. |
| [`gateway/`](gateway/) | B (gateway) | An LLM proxy: one proxied model call = one step; mints a `step_id`, declares no coordinates, forwards raw provider bodies. |

## Status (2026-08-14)

Protocol v0.7 retired the SDK layer; plugins are being rewritten against the
API one by one:

- **[`gateway/higress`](gateway/higress/)** — the v0.7 reference gateway
  integration, Recipe B (Go/WASM, CI-covered).
- **[`agent/dsh`](agent/dsh/)** — the v0.7 reference agent-direct
  integration, Recipe A (npm workspace, CI-covered).
- Everything else is **v0.6-stale** (built on the retired SDKs), excluded
  from the workspaces and CI, and treated as historical until its rewrite.
