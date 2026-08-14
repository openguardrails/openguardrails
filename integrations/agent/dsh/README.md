# @openguardrails/dsh-auto-mode

**Auto mode for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).**

dsh's chat client offers three permission modes: *Read Only · Workspace Write ·
Danger Full Access*. This plugin adds a fourth — **Auto** — where approval
prompts are answered by [OpenGuardrails (OGR)](https://openguardrails.com)
policy instead of a human: sandbox-escalation retries, tools that ask, wider
file access — granted or refused by **your own guardrails** (deterministic
text/regex rules, optionally your own model as the judge), with only the
genuinely ambiguous asks falling back to you.

**No dsh core changes.** dsh is an *everything is a plugin* harness, so this is
an ordinary [Cordis](https://github.com/cordiverse/cordis) plugin on dsh's
documented interception points. Underneath auto mode sits the full OGR guard
engine — every tool call is evaluated before it runs, whether or not the
session is on the Auto preset. It is *restrict-only* toward the agent: it can
stop a would-run tool call or withhold a result, never loosen a verdict.

## Quick start

This package is a dsh **bundle**: install it into a profile with dsh's own
plugin manager and its configuration layer activates by itself —

```sh
dsh plugin --profile web add @openguardrails/dsh-auto-mode
dsh --profile web
```

(`web` is dsh's default profile — `dsh web` is an alias for `--profile web`;
any other profile works the same way, and `dsh plugin` initializes a missing
one). The bundle's [`cordis.patch.yml`](cordis.patch.yml) contributes
two rows: the plugin itself, and an override of the base `permission` table
that adds the **Auto** entry to the Permissions selector. Open the selector,
pick **Auto Mode by OGR** — done.

To upgrade: `dsh plugin --profile web update @openguardrails/dsh-auto-mode`
(add `--latest` to cross a major version, or `add …@x.y.z` to pin — the
reliable form right after a release, before registry metadata caches catch
up). To remove: `dsh plugin --profile web remove @openguardrails/dsh-auto-mode`.

### The icon

The package also ships a browser half (dsh's `dsh.client` plugin capability —
still zero core changes): a shield-and-spark glyph in the Permission
selector's exact design-set geometry, decorating the **Auto Mode** row and
trigger the way the built-in presets carry theirs. It activates by itself in
`dsh web`; a client without the web module system simply shows the row
without an icon. The decorator is deliberately conservative — it only touches
a menu that provably renders the design-set shields, and any structural
surprise means "no icon", never a broken UI.

### Manual composition

A deployment that owns its whole plugin tree (or already customizes its
preset table) wires the same two halves by hand. The preset entry — same
knobs as workspace-write; the difference is entirely in who answers the asks:

```yaml
- id: permission
  name: '@deepseek-ai/dsh-permission-presets'
  config:
    presets:
      read-only: { sandbox: read-only, approval: ask }
      workspace-write: { sandbox: workspace-write, approval: ask }
      auto-mode:
        sandbox: workspace-write
        approval: ask
        name: Auto Mode by OGR
        description: OpenGuardrails answers approval prompts; only asks it cannot decide reach you.
      danger-full-access: { sandbox: danger-full-access, approval: never }
```

And the plugin (after `@deepseek-ai/dsh-tools`; auto mode is on by default,
`npm install @openguardrails/dsh-auto-mode` puts it on the resolution path):

```yaml
- id: openguardrails
  name: '@openguardrails/dsh-auto-mode'
  config:
    auto:
      preset: auto-mode
      unresolved: human   # or `reject` for headless deployments
```

A fully-commented config reference lives in
[`cordis.example.yml`](cordis.example.yml), usable directly as a `--patch`
overlay: `dsh web --patch cordis.example.yml`.

## How auto mode decides

The answerer is an ordinary `approval/request` waterfall listener in the same
claim-or-delegate shape as dsh's own ACP bridge: it claims a request only when
the session's folded `permission/preset` is the configured name, and delegates
every other session untouched — so a deployment that adds the preset without
loading this plugin degrades to plain workspace-write with human asks, the
fail-safe direction.

An `ApprovalRequest` carries no tool arguments, only a `callId` — which is
this plugin's `guard_id`, so the ask links back to the call already evaluated
at `tools/pre-execute`. The answerer re-evaluates rather than replaying that
verdict: provenance is fresh (the agent may have ingested untrusted content
since), the ask's own `reason` travels in the payload for a judge to weigh,
and guard-context correlation guarantees the answer can only tighten the
earlier decision. The mapping:

| Runtime verdict | Outcome |
| --- | --- |
| `allow` / `modify` / `redact` | `allowed-once` |
| `block` | `rejected` |
| `require_approval` | *undecided* — see below |
| no correlated call, or evaluation failed | *undecided* — a guard does not grant what it cannot see |

*Undecided* follows `auto.unresolved`: `human` (default) delegates onward so
the chat UI's gate still sees the genuinely ambiguous asks — including the
plugin's own `require_approval` escalations, where asking the runtime again
would be circular; `reject` refuses them, the strict stance for headless
deployments where no human will ever answer.

Grants are `allowed-once` only, per ask, never a durable rule. Note what auto
mode is: the user, by selecting the preset, delegates their own approval seat
to the runtime for that session. The plugin still never loosens an OGR
verdict — a `block` stays blocked at every altitude.

## The guard engine underneath

Auto mode's verdicts come from the same engine that guards every session, on
two of OGR's three altitudes — and the two halves are deliberately different
in kind:

| | **the sensor path** (`invocation`) | **the developer path** (`conversation`) |
|---|---|---|
| Kinds | `tool_call`, `tool_result` | `llm_request`, `llm_response` |
| dsh seam | `tools/pre-execute`, `tools/post-execute`, `ctx.tools.guard()` | `llm/stream` |
| Who judges | a **local** `Runtime`, tightened by **the runtime** when one is configured | **the runtime** you point it at |
| Needs a server | no | yes |
| Default | on | off |

There is deliberately **no observe mode** anywhere in this plugin: its user is
a *consumer* of the runtime, so every event that reaches the runtime goes
through `/v1/evaluate` and its Verdict participates in the decision — it can
tighten the local one, never loosen it. Fire-and-forget ingest is a gateway
posture (enterprise deployments observing traffic they do not control), not
an agent integration's.

The sensor path declares what the LLM wire cannot show — a pending invocation,
with its arguments, before dispatch — and a local detector chain judges it. The
developer path forwards the **untouched provider body** and decomposes nothing:
the runtime derives the new user words, the tool outcomes being fed back, the
model's prose, every tool call it asks for, and the declared tool inventory.
Classifying the conversation was every PEP's private burden through v0.5; v0.6
made it the runtime's job, and this plugin does not do it.

### The sensor path — tool calls

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
*decides*, the user *approves* through `ctx.approval` (or, on the Auto preset,
delegates that seat to the runtime), the registry *enforces*. A composition
with no approval service turns an `ask` into a denial, which is the correct
direction for a restrict-only guard.

`tools/pre-execute` is dsh's deliberately *reorderable* policy layer, so this
plugin registers there with `prepend` — it sees a call before a permissive
layer can short-circuit the waterfall. See [Fail-closed](#fail-closed) for the
case that ordering alone cannot cover.

## Configure your guardrails

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
  name: '@openguardrails/dsh-auto-mode'
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
still pass. This matters doubly under auto mode: an injection-influenced
escalation ask is *rejected*, not granted.

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

## The developer path — raw model traffic

`llmRequest` and `llmResponse` each take `off` (default) · `enforce` — no
observe, like everywhere else in this plugin.

```yaml
config:
  llmRequest: enforce     # judged BEFORE the request reaches the model
  llmResponse: enforce    # judged AFTER the answer, BEFORE the agent acts on it
```

| | `llm_request` | `llm_response` |
|---|---|---|
| Emitted | before each model call | when the answer is complete |
| Payload | the assembled request body — messages, the system slot, the tool inventory | the response body — prose, `tool_calls`, `finish_reason` |
| `enforce` blocks by | never calling the model | withholding the whole answer |
| Latency | one runtime round trip per step | one round trip, and the stream is buffered until the verdict lands |

Both need `OGR_RUNTIME_URL` + `OGR_API_KEY`. There is no local fallback and the
plugin will not pretend otherwise: switched on without a runtime, it logs why
and registers nothing. The bundled detectors judge commands, not conversations
— that is the whole point of the split.

**Auxiliary calls are skipped.** A `purpose` of `compaction` or `session-title`
is machinery, not the agent's conversation with the user; judging it would bill
a round trip to re-read history the runtime has already seen.

**An unreachable runtime does not fail the turn closed.** This altitude has no
human gate, and killing a whole turn because a server blinked would take the
agent down with it. The plugin says so in the log and proceeds; the tool-call
altitude — which *does* fail closed, see above — is what carries enforcement
in that window.

**`require_approval` blocks here.** `ctx.approval` keys a question to an agent
and a tool, and a model call is neither, so there is nothing to ask. Stopping
is the restrict-only direction.

### One honest caveat about "untouched"

The spec says these kinds carry the untouched provider body. A dsh plugin
cannot literally do that: `llm/stream` runs on `GenerateOptions`, dsh's
provider-**neutral** request, and each adapter (`dsh-llm-deepseek`,
`dsh-llm-pi-ai`, …) maps it to the wire afterwards. So what this plugin sends
is a faithful **projection** into `openai.chat`, and `llm_protocol` names the
shape actually emitted rather than the shape the adapter will send.

Everything the runtime classifies from survives the projection: the system
slot leads the message list, tool results become `tool`-role messages keyed by
`tool_call_id` (so "outcomes fed back" stay distinguishable from "new user
words"), and the tool inventory travels in `tools`. What is lost is
provider-specific transport — `reasoningEffort`, and the adapter's own
header/metadata mapping. `reasoning` blocks are dropped because no
`openai.chat` request body carries them.

## Where it deliberately does not hook

- **`fs/write-intent` / `fs/edit-intent`.** Filesystem mutations already flow
  through `tools/pre-execute` as their tool call. A dedicated
  `execution`-altitude sensor belongs in an eBPF or sandbox integration, not
  in an in-process plugin.
- **Per-token streaming content.** `llm_response` is judged once, whole. There
  is no partial-content mode: the runtime's `ogr-partial` header exists, but a
  guard that re-judges every delta pays a round trip per token for a verdict
  that can only tighten at the end anyway.

## Known limitations

- The bundled reference detectors judge a **`tool_result`** on its provenance
  only: `ConfigRulesDetector` declares `handles = [exec, tool_call, network]`,
  and `LLMJudgeDetector` reads `payload.text`, which a spec-shaped
  `{ name, result }` payload does not carry. The event this plugin emits is
  spec-conformant and complete — a deployment's own detector receives the whole
  payload — but `guardToolResults` gains you little until you plug one in.
- **`llmResponse: enforce` buffers the stream.** That is what makes "BEFORE the
  agent acts on it" literally true, and it costs the runtime round trip in
  first-token latency.
- **The projection is not the wire body** — see the caveat above.
- The OGR `Runtime` retains one entry per `guard_id` for altitude correlation
  and never evicts, so a long-lived harness process grows with the number of
  tool calls. This is SDK behavior, shared with every OGR integration.
- Taint is in-memory. A session resumed from persistence starts unmarked.

## Connecting the runtime — only the API key is yours to fill

Register at [openguardrails.com](https://openguardrails.com), get an API key,
and paste it into the dsh **Settings → openguardrails** card (the plugin
registers its own section there). Everything else defaults: the URL points at
the OpenGuardrails cloud, and the connection comes up **without a restart** —
the source is read live. The first time an Auto Mode session would ask for
approval with no key configured, the plugin says exactly this in the log,
once.

Every setting resolves **Settings → `cordis.yml` config → environment →
default**:

| Setting | Env var | Default |
|---|---|---|
| `runtime.url` | `OGR_RUNTIME_URL` | `https://openguardrails.com` |
| `runtime.apiKey` | `OGR_API_KEY` | — (unset = local policy only) |
| `runtime.workspace` | `OGR_AGENT_WORKSPACE` | absent → the API key's workspace |
| `runtime.owner` | `OGR_AGENT_OWNER` | the OS account |
| `runtime.user` | `OGR_AGENT_USER` | the OS account |

(dsh loads `~/.dsh/.env` and the invoking directory's `.env` as launch
environment, so the env route needs no shell exports.)

With a key configured, every tool call, tool result and auto-mode approval
ask is **evaluated** against the runtime through `/v1/evaluate` — its Verdict
tightens the local one, never loosens it, and an unreachable runtime leaves
local enforcement standing. Transport is `@openguardrails/core`'s
`RuntimeClient`: canonical `/v1/...` paths, with automatic fallback to
deployments that mount the API under `/api/public/ogr`.

Every event carries the **identity five-tuple**, filled automatically:

| Field | Value |
|---|---|
| `agent_id` | `dsh-<hostname>` — one harness process per machine, one Agent in the console |
| `agent_type` | `DeepSeekHarness` |
| `agent_workspace` | the platform policy/resource group this agent belongs to — **not a directory**; absent = the API key's workspace |
| `agent_owner` | configurable; defaults to the OS account the harness runs as |
| `agent_user` | configurable; defaults to the OS account — the best a local single-user harness can assert |

The per-session identity travels as `session_id`; the runtime clamps every
claim to what the attestation supports.

**Enrollment.** On first use the plugin enrolls a per-machine Ed25519 key
(`~/.ogr/dsh-ed25519.json`, override with `OGR_KEYFILE`) and signs each
request (spec: [`specification/attestation.md`](../../../specification/attestation.md)).
This is what lifts the identity claims from "anyone holding the API key" to
"the holder of this machine's enrolled key" (`client_key` attestation), and
what lets the platform revoke one machine without rotating the org key. Any
enrollment failure degrades silently to unsigned requests at the attestation
floor.

Every event carries `sensor_id = openguardrails-dsh`, `sensor_type =
in_process` — a deployment that stops loading the plugin stops being observed.
That is the honest reading of an in-process guard, and it is why the
`execution` altitude exists.

## Develop

```sh
npm install          # from the repository root
npm run build -w @openguardrails/dsh-auto-mode
npm test  -w @openguardrails/dsh-auto-mode
```

The tests boot a **real** dsh tool registry (`@deepseek-ai/dsh-tools` plus
`@deepseek-ai/dsh-system-prompt`) and drive `ctx.tools.execute()` through the
genuine pipeline, so a change in how dsh orders or short-circuits that pipeline
surfaces as a test failure rather than as a silently bypassed guard. The
auto-mode answerer is exercised through Cordis's real `approval/request`
waterfall, including the mid-execution escalation window.

## License

Apache-2.0
