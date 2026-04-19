# Plugin — OpenClaw-family host

A plugin that wires `thomas` into an OpenClaw-style agent via the
`preTool` and `postResponse` hooks. Every tool call and every model
response is checked before the agent acts on it.

## Install

```bash
# One-time: install the thomas CLI (closed-source; ships via npm)
npm install -g @openguardrails/thomas-security

# In your OpenClaw workspace
openclaw plugin install @openguardrails/plugin
```

Set your API key:

```bash
export OPENGUARDRAILS_API_KEY=ogr_live_...
```

## Wiring

```ts
import { createMoltguardPlugin } from "./index.ts";

const plugin = createMoltguardPlugin({
  apiKey: process.env.OPENGUARDRAILS_API_KEY!,
  failClosed: false,          // allow action when service unreachable
  allowlist: ["readFile"],    // tools never sent for check
});

openclaw.use(plugin);
```

## Behavior

| Hook           | What happens                                                |
| -------------- | ----------------------------------------------------------- |
| `preTool`      | Sends `{prompt, toolCall}` to the service before the call.  |
| `postResponse` | Sends the model's candidate response before it's delivered. |

The plugin returns one of:

- `{ action: "allow" }` — proceed
- `{ action: "block", reason }` — abort; surface `reason` to the user
- `{ action: "rewrite", rewrittenValue }` — substitute the redacted form

## Fail-open vs fail-closed

Default is **fail-open**: if the service is unreachable, the action
proceeds. This matches the common operational preference — a guardrail
that hangs the agent when it can't reach its server is a liability.

Flip `failClosed: true` in high-assurance environments.

## Source

The plugin source is [`index.ts`](./index.ts). It's small enough to read
in one sitting. Copy it into your own codebase if you want to fork.
