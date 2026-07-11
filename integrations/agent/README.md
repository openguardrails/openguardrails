# Agent integrations

Agent integrations turn tool and framework lifecycle events into OGR
`GuardEvent`s before the action is dispatched.

| Target | Source |
|---|---|
| Claude Code | [`claude-code/`](claude-code/) |
| Codex | [`codex/`](codex/) |
| Hermes | [`hermes/`](hermes/) |
| LangGraph | [`langgraph/`](langgraph/) |
| OpenClaw | [`openclaw/`](openclaw/) |
| opencode | [`opencode/`](opencode/) |

Hermes currently includes adapters for sandbox backends as part of its
end-to-end agent integration. Standalone sandbox examples belong under
`../sandbox/`.
