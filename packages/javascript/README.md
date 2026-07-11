# @openguardrails/core

The **OpenGuardrails (OGR) reference runtime** for JavaScript/TypeScript — a
vendor-neutral protocol for AI agent safety & security. The TS counterpart of the
Python [`openguardrails`](https://pypi.org/project/openguardrails/) package.

OGR is a neutral **enforcement** contract: each agent action becomes a
`GuardEvent`, runs past whatever detectors you choose, and gets back a `Verdict`
that can **allow, block, or require approval** *before* the action runs. Detectors
plug in behind one interface, and you compose them with one policy you own.

```bash
npm install @openguardrails/core
```

Zero runtime dependencies.

## The contract

```ts
import { Runtime, ConfigRulesDetector, LLMJudgeDetector } from "@openguardrails/core"

const policy = {
  composition: { "security.*": { strategy: "deny-wins", on_all_failed: "block" } },
  config_rules: {
    command_rules: [
      { id: "rm-rf-root", regex: "rm\\s+-rf\\s+/", category: "security.malicious_command",
        decision: "block", score: 1.0, why: "destructive recursive delete" },
    ],
  },
}

const rt = new Runtime(
  [new ConfigRulesDetector(policy.config_rules), new LLMJudgeDetector()],
  policy,
)

const verdict = await rt.evaluate({
  kind: "tool_call", observationPoint: "agent_hook",
  subject: {}, payload: { name: "bash", arguments: { command: "rm -rf /" } },
  eventId: "e1", guardId: "g1", timestamp: new Date().toISOString(),
  provenance: [{ source: "user", trust: "trusted" }],
})
// verdict.decision === "block"
```

- **`GuardEvent`** — a normalized observation of an agent action plus the
  **provenance** (trust labels) of the inputs that produced it.
- **`Detector`** — the vendor surface: map a `GuardEvent` to a `Verdict`. Two are
  shipped: `ConfigRulesDetector` (deterministic **text + regex** rules — an agent
  can configure these for itself, no model) and `LLMJudgeDetector` (a pluggable
  model backend — *use your own model as the guardrail*).
- **`Runtime`** — the PDP: fans out to detectors, **composes** verdicts
  (`deny-wins` / `quorum` / `first-available`), propagates provenance, and
  correlates altitudes by `guardId` so a later observation can only *tighten*.

## Bring your own model

```ts
import { LLMJudgeDetector, type LLMBackend } from "@openguardrails/core"

const backend: LLMBackend = {
  name: "my-model",
  async complete(system, user) { /* call any model; return the JSON verdict */ return "..." },
}
new LLMJudgeDetector(backend)
```

## Instrument an agent

This is the SDK. To guard a real agent, use an instrumentation package:

- [`openguardrails-instrumentation-opencode`](https://www.npmjs.com/package/openguardrails-instrumentation-opencode)
  — guard an opencode agent's tool calls (no core changes).

## Status

`v0.1` — reference implementation of the
[specification](https://github.com/openguardrails/openguardrails).
