# Integrations (the plugin layer)

Integrations are the **plugin layer** of OGR's API → Plugin stack: a plugin
is a hook for one surface that observes steps, builds `GuardEvent`s, and
enforces `Verdict`s — speaking the
[Runtime API](../specification/runtime-api.md) (`/v1/evaluate`) directly.
There is no SDK layer: each plugin implements
[the recipe](../specification/runtime-api.md#the-recipe) — the same one for
every vantage since v0.8.

Two hook categories — same protocol, different seat:

| Category | Seat | Purpose |
|---|---|---|
| [`agent/`](agent/) | inside the harness loop | Holds the model call itself (or, at fragment vantages, the tool call about to execute); fills the four-tuple from its own config. |
| [`gateway/`](gateway/) | an LLM proxy | One proxied model call = one step; forwards raw provider bodies, fills the four-tuple from its own caller authentication. |

## Status (2026-08-15)

Protocol v0.8 merged the two recipes into one; plugins rewritten against it:

- **[`gateway/higress`](gateway/higress/)** — the v0.8 reference gateway
  integration (Go/WASM, CI-covered).
- **[`agent/dsh`](agent/dsh/)** — the v0.8 reference agent-direct
  integration (npm workspace, CI-covered).
- **[`agent/litellm`](agent/litellm/)** — v0.8 litellm hook (proxy
  enforcing, SDK observe-only).
- **[`agent/langgraph`](agent/langgraph/)**, **[`agent/hermes`](agent/hermes/)**,
  **[`agent/claude-code`](agent/claude-code/)**, **[`agent/codex`](agent/codex/)**,
  **[`agent/openclaw`](agent/openclaw/)**, **[`agent/opencode`](agent/opencode/)**,
  **[`gateway/mitmproxy`](gateway/mitmproxy/)**,
  **[`gateway/openai-anthropic`](gateway/openai-anthropic/)** — rewritten
  against v0.8.
