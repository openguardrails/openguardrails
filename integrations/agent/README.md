# Agent integrations

Agent integrations sit inside the harness and speak the
[v0.8 Runtime API](../../specification/runtime-api.md) directly. Where the
harness exposes the model call, the plugin sends the paired
`step/request` / `step/response` events; where it only exposes a tool call
about to execute (hook-based hosts), the plugin sends the canonical
`step/response` for what it actually holds — each README states its vantage.

| Target | Source | Local secrets redaction |
|---|---|---|
| Claude Code | [`claude-code/`](claude-code/) | via [`ogr-local`](ogr-local/) — hooks are separate processes |
| Codex | [`codex/`](codex/) | via [`ogr-local`](ogr-local/) — the host is Rust |
| DeepSeek Harness (`dsh`) | [`dsh/`](dsh/) — the reference agent-direct integration | in-process |
| Hermes | [`hermes/`](hermes/) | in-process |
| LangGraph | [`langgraph/`](langgraph/) | — |
| litellm | [`litellm/`](litellm/) | — |
| OpenClaw | [`openclaw/`](openclaw/) | in-process |
| opencode | [`opencode/`](opencode/) | in-process |

Two shared libraries sit under these: [`local-redaction/`](local-redaction/)
(the reference `mask()`/`restore()`, the served-ruleset loader and the
in-process HTTP interceptor, beside the conformance corpus) and
[`ogr-local/`](ogr-local/) (the same masking behind a loopback proxy).

## Where the mask goes, and why it differs

**Six harnesses, two shapes.** Local secrets redaction
([OGR 1.4](../../specification/local-redaction.md)) replaces every credential
in the outbound model request with `${OGR_SECRET_n}` on the host, and restores
it into the reply's tool-call arguments after judgement. *Where* that happens
is decided by one question: **can code run inside the agent's own process?**

- **In-process (hermes, opencode, openclaw, dsh)** — the plugin installs an
  interceptor on the process's HTTP client. It covers the system prompt and
  tool schemas as well as the messages, needs no port, no lifecycle and no
  base-URL change, and cannot outlive the harness. **Always prefer this.**
- **A loopback proxy (Claude Code, Codex)** — their hooks are separate
  processes, and Codex's host is not even JavaScript, so there is no seam
  inside the agent to install anything on. [`ogr-local`](ogr-local/) sits in
  front instead, reached by a base URL the operator sets once.

⚠️ The two are not interchangeable, and the proxy is strictly the weaker
position: it is a second process that has to be running, and if it is down the
harness cannot reach its provider at all. Nothing that can host an in-process
plugin should be wired through it.
