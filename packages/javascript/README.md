# @openguardrails/core

The **OGR SDK for JavaScript/TypeScript** — a vendor-neutral protocol for AI
agent safety & security. Two layers in one zero-dependency package: the
**in-process reference runtime** (GuardEvent → Verdict, composed under a policy
you own) and **`RuntimeClient`**, the client for the OGR Runtime HTTP API. The
TS counterpart of the Python
[`openguardrails`](https://pypi.org/project/openguardrails/) package.

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
  kind: "tool_call", observationPoint: "invocation",
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

## Talk to an OGR Runtime

`RuntimeClient` wraps the Runtime HTTP API (`/v1/evaluate`, `/v1/ingest`,
`/v1/enroll`, `/v1/heartbeat`, `/v1/config`, `/v1/approvals`) so integrations
don't hand-roll their own fetch code. It appends the canonical `/v1/...` paths
to `baseUrl` — a deployment behind a prefix passes the prefix (e.g.
`https://host/api/public/ogr`). Defaults come from `OGR_RUNTIME_URL` /
`OGR_API_KEY`.

```ts
import { RuntimeClient, createNodeSigner } from "@openguardrails/core"

const client = new RuntimeClient({
  baseUrl: "https://host/api/public/ogr",
  apiKey: "ogr_...",
  // Optional: sign /evaluate and /ingest bodies with an enrolled Ed25519 key.
  signer: await createNodeSigner({ d, x }, keyId),
})

const verdict = await client.evaluate(event)          // one GuardEvent → Verdict
const results = await client.ingest(events)           // batched, per-event results
const { guardId, keyId } = await client.enroll({ publicKey })
```

`eventToWire` / `verdictFromWire` are exported as the single canonical
camelCase↔snake_case wire mapping. Errors surface as `RuntimeApiError`
(status, code, body) and `RateLimitedError` (limit). The client uses the
global `fetch` (Node >= 18, WASM/edge); only `createNodeSigner` requires Node
(`node:crypto`, lazily imported).

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

- [`@openguardrails/opencode-auto-mode`](https://www.npmjs.com/package/@openguardrails/opencode-auto-mode)
  — auto mode for opencode: permission prompts answered by OGR policy (no core changes).

## Status

Implements wire version `0.4` of the
[specification](https://github.com/openguardrails/openguardrails).
