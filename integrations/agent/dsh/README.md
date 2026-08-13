# openguardrails-instrumentation-dsh

Guard a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(`dsh`) agent through the **OpenGuardrails (OGR)** protocol — a vendor-neutral
enforcement layer for AI agent safety & security.

**No dsh core changes.** dsh is an *everything is a plugin* harness, so this is
an ordinary [Cordis](https://github.com/cordiverse/cordis) plugin on dsh's
documented interception points — no external hook protocol, no subprocess, no
patched loop. It is *restrict-only*: it can stop a would-run tool call or
withhold a would-be-returned tool result, never loosen one.

## What it does

Each intercepted event becomes an OGR `GuardEvent`, runs through a `Runtime`
built from **your own policy** (deterministic text/regex rules, plus optionally
your own model as an LLM judge), and the resulting `Verdict` is mapped onto the
[tool execution pipeline](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/tool-execution-pipeline.md)'s
typed decisions:

| Extension point | `allow` / `modify` / `redact` | `block` | `require_approval` |
| --- | --- | --- | --- |
| **`tools/pre-execute`** (invocation) | `next()` — delegate | `{ kind: 'deny' }` | `{ kind: 'ask' }` — the native `ctx.approval` human gate |
| **`tools/post-execute`** (result) | the downstream decision | `{ kind: 'block' }` | `{ kind: 'block' }` — no gate exists after the side effect |
| **`ctx.tools.guard()`** | — | monotonic re-assertion | — |

The human-confirm gate and enforcement stay **privilege-separated**: the plugin
*decides*, the user *approves* through `ctx.approval`, the registry *enforces*.
A composition with no approval service turns an `ask` into a denial, which is
the correct direction for a restrict-only guard.

`tools/pre-execute` is dsh's deliberately *reorderable* policy layer, so this
plugin registers there with `prepend` — it sees a call before a permissive
layer can short-circuit the waterfall. See [Fail-closed](#fail-closed) for the
case that ordering alone cannot cover.

## Install

```sh
npm install openguardrails-instrumentation-dsh
```

The package installs [`@openguardrails/core`](../../../packages/javascript/),
the JavaScript OGR core runtime, as a dependency. dsh itself
(`@deepseek-ai/dsh-*`, `@deepseek-ai/cordis`) is a peer dependency you already
have.

## Wire it up

Add an entry to the `cordis.yml` your deployment loads, or apply it as a patch
over the shipped `dsh web` profile. The plugin must load **after**
`@deepseek-ai/dsh-tools` — it injects the `tools` service and Cordis waits for
it, so ordering is a readability concern, not a correctness one.

```yaml
- id: openguardrails
  name: 'openguardrails-instrumentation-dsh'
  config:
    guardToolResults: true
    failClosed: false
```

As a patch overlay onto the Web profile (`dsh web --patch ogr.yml`):

```yaml
- insert:
    - id: openguardrails
      name: 'openguardrails-instrumentation-dsh'
```

A runnable example lives in [`cordis.example.yml`](cordis.example.yml).

## Configure

The agent configures its **own** guardrails. Resolution order (low → high):

1. A safe default policy (curl-pipe-to-sh, `rm -rf /`, secret-file reads, …).
2. `<workspace>/.dsh/guardrails.json` — an OGR `policy.json` the agent can edit
   to give itself guardrails. Override the path with `policyPath` (relative
   paths resolve against the workspace).
3. The plugin's `cordis.yml` `config:` block (highest precedence).

Resolution is **per session workspace**, not per process: dsh sessions each
carry their own `cwd` and one harness process serves many of them, so two
agents in two repositories get two policies. One OGR `Runtime` is built per
workspace and cached.

```yaml
- id: openguardrails
  name: 'openguardrails-instrumentation-dsh'
  config:
    # Use your own model as the guardrail — any OpenAI-compatible endpoint.
    judge:
      baseURL: https://api.deepseek.com/v1
      model: deepseek-v4-flash
      apiKey: !!js process.env.DEEPSEEK_API_KEY
    guardToolResults: true
    taint:
      toolResults: true
      toolResultPattern: 'web|fetch|search|browser|curl|http|^mcp_|_mcp_'
    failClosed: false
```

`judge` needs **both** `baseURL` and `model`; a half-written block is ignored
with a warning rather than turned into a failing fetch on every call. Without a
judge the deterministic `HeuristicBackend` runs instead, so tainting keeps its
teeth with no external model. The policy format is identical across every OGR
integration (opencode, openclaw, hermes, python), so one `policy.json` works
everywhere.

Config is declared as a [schemastery](https://github.com/shigma/schemastery)
schema, so the dsh Web UI renders it as a form.

## Untrusted-content tainting (indirect prompt injection)

Once an agent ingests **untrusted content** — a result from a
web/fetch/search/browser/MCP tool, matched by `taint.toolResultPattern` against
the tool name — its later tool calls carry `untrusted` provenance. The OGR
judge then escalates a privileged action (`curl … | sh`) from
`require_approval` to **block** as probable injection, while benign actions
still pass.

Taint is keyed by the live `Agent` object, exactly like dsh's own per-agent
guards: the tool registry is context-level and subagents interleave through the
same waterfall, so one agent's ingested content never escalates another's
calls, and object lifetime bounds the entry without a disposal listener. It is
cleared on `agent/session-start` for `startup` and `clear` — a `resume` or
`compact` keeps the ingested content in derived history, so the mark stays.

## Guard-context correlation

A call and its result are one logical action, so both events carry the dsh
`callId` as their OGR `guard_id`. The runtime correlates the two altitudes and
a later observation can only **tighten** the earlier decision, never loosen it.
Event identity itself is born at the runtime (OGR v0.6) — this plugin never
mints an `event_id`.

## Fail-closed

`failClosed: true` turns two soft spots hard:

- A registered [`ctx.tools.guard()`](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/cookbook/extension-cookbook.md)
  — the one denial that cannot be reordered away — refuses any call that
  reached it with no OGR verdict. That is the signature of a `tools/pre-execute`
  listener that returned `allow` without delegating, so OGR never saw the call.
- A detector failure (an unreachable judge endpoint, a malformed rule) denies
  the call instead of delegating.

Default `false`, because the failure mode is a denied call rather than a
missing guard, and that is the deployment's decision to make. The plugin's test
suite asserts both directions against a real dsh tool registry.

## Where it deliberately does not hook

- **Model output.** dsh's `llm/stream` is a waterfall over an `AsyncIterable`;
  guarding the assistant's text there means buffering the stream and paying for
  it in first-token latency. Enforcement stays at the tool boundary, which is
  the altitude that carries the side effect.
- **`fs/write-intent` / `fs/edit-intent`.** Filesystem mutations already flow
  through `tools/pre-execute` as their tool call. A dedicated
  `execution`-altitude sensor belongs in an eBPF or sandbox integration, not
  in an in-process plugin.

## Known limitations

- The bundled reference detectors judge a **`tool_result`** on its provenance
  only: `ConfigRulesDetector` declares `handles = [exec, tool_call, network]`,
  and `LLMJudgeDetector` reads `payload.text`, which a spec-shaped
  `{ name, result }` payload does not carry. The event this plugin emits is
  spec-conformant and complete — a deployment's own detector receives the whole
  payload — but `guardToolResults` gains you little until you plug one in.
- The OGR `Runtime` retains one entry per `guard_id` for altitude correlation
  and never evicts, so a long-lived harness process grows with the number of
  tool calls. This is SDK behavior, shared with every OGR integration.
- Taint is in-memory. A session resumed from persistence starts unmarked.

## Platform reporting with an enrolled identity (optional)

Set `OGR_RUNTIME_URL` + `OGR_API_KEY` and the plugin also ships every
GuardEvent to an OpenGuardrails runtime — fire-and-forget, local enforcement
stays authoritative. On first use it enrolls a per-machine Ed25519 key
(`~/.ogr/dsh-ed25519.json`, override with `OGR_KEYFILE`) and signs each batch
with `OGR-Batch-Signature` (spec: [`specification/attestation.md`](../../../specification/attestation.md)).
Transport is `@openguardrails/core`'s `RuntimeClient`: canonical `/v1/...`
paths joined to `OGR_RUNTIME_URL`, with automatic fallback to deployments that
mount the API under `/api/public/ogr`. The reporter is disposed with the
plugin, so a hot reload leaves no interval or undelivered batch behind.

dsh is the "one harness per machine" case: every session, agent and subagent
runs inside the same host process, so events assert
`agent_id = dsh-<hostname>` and the machine appears as one Agent in the
console. The per-session identity travels as `session_id`.

Every event carries `sensor_id = openguardrails-dsh`, `sensor_type =
in_process` — a deployment that stops loading the plugin stops being observed.
That is the honest reading of an in-process guard, and it is why the
`execution` altitude exists.

## Develop

```sh
npm install          # from the repository root
npm run build -w openguardrails-instrumentation-dsh
npm test  -w openguardrails-instrumentation-dsh
```

The tests boot a **real** dsh tool registry (`@deepseek-ai/dsh-tools` plus
`@deepseek-ai/dsh-system-prompt`) and drive `ctx.tools.execute()` through the
genuine pipeline, so a change in how dsh orders or short-circuits that pipeline
surfaces as a test failure rather than as a silently bypassed guard.

## License

Apache-2.0
