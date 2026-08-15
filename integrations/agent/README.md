# Agent integrations

Agent integrations sit inside the harness and speak the
[v0.8 Runtime API](../../specification/runtime-api.md) directly. Where the
harness exposes the model call, the plugin sends the paired
`step/request` / `step/response` events; where it only exposes a tool call
about to execute (hook-based hosts), the plugin sends the canonical
`step/response` for what it actually holds — each README states its vantage.

| Target | Source |
|---|---|
| Claude Code | [`claude-code/`](claude-code/) |
| Codex | [`codex/`](codex/) |
| DeepSeek Harness (`dsh`) | [`dsh/`](dsh/) — the reference agent-direct integration |
| Hermes | [`hermes/`](hermes/) |
| LangGraph | [`langgraph/`](langgraph/) |
| litellm | [`litellm/`](litellm/) |
| OpenClaw | [`openclaw/`](openclaw/) |
| opencode | [`opencode/`](opencode/) |
