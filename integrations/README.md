# Integrations

Drop-in glue so **other agents can invoke `thomas`** as a security
sub-agent inside their own loop. OpenClaw, Claude Code, Cursor, Hermes,
or any custom agent can wire `thomas` into its tool chain and delegate
per-action security checks.

Each subdirectory is a self-contained integration. Copy the one that
matches your agent's extension model.

```
integrations/
├── plugin/     # OpenClaw-family plugin (preTool / postResponse hooks)
└── sdk/        # TypeScript SDK — call thomas / OpenGuardrails from code
```

Skill-consuming agents (Claude Code, Cursor, etc.) load the canonical
skill directly from [`skills/thomas-security/`](../skills/thomas-security)
— there's no separate integration wrapper needed.

## Which one do I need?

| Your agent                           | Use                                                    |
| ------------------------------------ | ------------------------------------------------------ |
| OpenClaw (or any plugin-style host)  | [`plugin/`](./plugin)                                  |
| Claude Code / skill-consuming LLMs   | [`skills/thomas-security/`](../skills/thomas-security) |
| Custom agent you wrote in TypeScript | [`sdk/`](./sdk)                                        |

## How they fit together

```
┌───────────────────────────────────┐
│  host agent (OpenClaw, Claude…)   │
│                                   │
│   preTool ─────────►  plugin ──┐  │
│   postResponse ─────► plugin ──┤  │
│   /thomas  ─────────► skill  ──┤  │
│   myAgent.check() ──► sdk    ──┤  │
└────────────────────────────────┼──┘
                                 │
                                 ▼
                     ┌──────────────────────┐
                     │  thomas CLI (closed) │
                     │  + OpenGuardrails    │
                     │    service (closed)  │
                     └──────────────────────┘
```

Everything here is the **open-source wiring**. The CLI that enforces
policy and the service it talks to are shipped separately via
`npm i -g @openguardrails/thomas-security`. See
[`docs/PHILOSOPHY.md`](../docs/PHILOSOPHY.md) for the reasoning behind
that split.

## Contributing a new integration

Host agents come and go. If `thomas` doesn't have a drop-in for the agent
you're using, add one:

1. `mkdir integrations/<host>` (e.g., `integrations/cursor`).
2. Ship the smallest thing that plugs `thomas` into the host's extension
   surface. One file is fine — don't over-build.
3. Include a `README.md` with: what the host calls the extension point,
   how a user installs it, and what the failure mode is when `thomas` is
   unreachable.
4. Open a PR. See [`docs/CONTRIBUTING.md`](../docs/CONTRIBUTING.md).
