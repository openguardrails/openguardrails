# @openguardrails/dsh

**OpenGuardrails for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) — the v0.8 reference agent-direct integration.**

This plugin implements **[the recipe](../../../specification/runtime-api.md#the-recipe)**
of the v0.8 Runtime API — one decision endpoint, two evaluates per model
call, no SDK. dsh owns its loop, so the plugin sits on the loop's documented
seams (an ordinary [Cordis](https://github.com/cordiverse/cordis) plugin, no
core changes) and judges every model call at the moments something can still
be refused:

| Seam | Event | What a `block` does |
| --- | --- | --- |
| before the model call (`llm/stream`) | `step/request` — the assembled request, `openai.chat` projection | the model is never called; the step ends as an error and the turn closes |
| at stream end, before the agent acts | `step/response` — canonical `{text, reasoning?, tool_calls, model, usage?, timing}`, the WHOLE reassembled answer, judged exactly once while the stream's tail is still held back | the held tail is dropped and the stream ends in an error — or, when every blocking finding names a `payload.tool_calls.N` path, only those calls are refused: the prose reaches the user and each offending call is denied at the tool registry |
| tool results | *(no third call site)* | results travel in the NEXT step's request and are judged there |
| periodically | `/v1/heartbeat` — build id + degraded-mode counters | *(not a guarded action — liveness, so the runtime can tell "agent idle" from "integration went dark")* |

**One endpoint, every field required.** A v0.8 event is `kind`, `step_id`,
the identity four-tuple, `llm_protocol`, and the `payload` — nothing else on
the wire. The plugin mints one fresh `step_id` per model call (the
same value on the call's two events — the ONE coordinate the runtime cannot
derive) and fills the four-tuple on every event, with `""` as the explicit
"no assertion": `agent_id` is `dsh-<hostname>`, `agent_type` is `dsh`, owner
and user default to the OS account the harness runs as, and the workspace
stays empty unless the deployment names one (the API key's workspace is the
floor). Session, turn and step numbering, timestamps, turn-end marks — all
derived server-side; the plugin tracks none of it.

**Streaming: hold the tail, judge once.** The answer streams to the user
live; the final `streamTailChars` characters (default 200, the spec's
reference value) are withheld until the `step/response` verdict. `allow`
releases the tail; `block` drops it and the response never completes — and
since a stream only completes tool calls at its end, no tool call ever runs
ahead of the verdict. The accepted trade, stated by the spec: content ahead
of the tail has already been seen. A deployment that cannot accept that sets
`streamTailChars` huge, which degenerates to buffering the whole answer.

**No SDK.** The integration is hand-rolled `fetch` in
[`src/wire.ts`](src/wire.ts) — one evaluate, one heartbeat, under 200 lines,
and the recommended starting point for anyone integrating their own harness.

## Quick start

This package is a dsh **bundle**: install it into a profile with dsh's own
plugin manager and its configuration layer activates by itself —

```sh
dsh plugin --profile web add @openguardrails/dsh
dsh --profile web
```

Then paste your API key (get one at [openguardrails.com](https://openguardrails.com))
into the **openguardrails** card on the dsh Settings page, or set it in the
environment:

```sh
# ~/.dsh/.env
OGR_API_KEY=ogr_…
# self-hosted runtimes (a mounted prefix belongs in the URL):
OGR_RUNTIME_URL=https://ogr.example.com
```

No API key = the integration is off, and says so once in the harness log.
A fully-commented config reference lives in
[`cordis.example.yml`](cordis.example.yml), usable directly as a `--patch`
overlay: `dsh web --patch cordis.example.yml`.

## Degraded mode: the default is OPEN

`failMode` is the deployment's stated posture per
[the degraded-mode spec](../../../specification/degraded-mode.md), and it
covers every shape of "could not look":

- an unreachable runtime, an evaluate timeout, a 429;
- a verdict whose `unjudged` names paths that were never judged;
- a tool call that reached execution with **no step verdict at all** — the
  signature of a `tools/pre-execute` waterfall that short-circuited before
  this plugin ran (the monotonic `ctx.tools.guard`, which cannot be
  reordered away, is what catches it).

`open` — the spec's default and this plugin's — proceeds loudly: the harness
keeps working through an outage, and the heartbeat's `evaluate_errors`
counter is what makes the gap visible to the runtime (v0.8 has no replay
channel; the counters ARE the record). `closed` treats all of it as block,
for deployments where an unjudged action is worse than a stopped agent.

## Auto mode

dsh's chat client offers three permission modes: *Read Only · Workspace
Write · Danger Full Access*. This plugin adds a fourth — **Auto** — where
approval prompts (sandbox-escalation retries, tools that ask) are answered by
the **step verdict the call already earned** instead of a human: a
step-cleared call is granted once, a step-refused call is rejected, and
anything the verdict never covered follows `auto.unresolved` — back to the
human gate by default, or `reject` for headless deployments. Sessions on any
other preset are never claimed, so an unloaded plugin degrades the preset to
plain workspace-write with human asks — the fail-safe direction.

The bundle's [`cordis.patch.yml`](cordis.patch.yml) contributes the plugin row
and an override of the base `permission` table that adds the **Auto Mode by
OGR** entry to the Permissions selector (with the shield icon, via the
package's browser half — still zero core changes).

## Known limitations

- **Redaction spans are not applied yet.** A verdict's `modifications.spans`
  index the wire body this plugin sent, and splicing them back into dsh's own
  message objects is not implemented; the plugin warns once, counts each
  unapplied span on the heartbeat's `unresolved_spans`, and passes content
  unredacted. The runtime's stored copy is masked regardless.
- **The request is a projection, not a byte-exact capture.** The `llm/stream`
  waterfall runs on `GenerateOptions`, dsh's provider-neutral request; the
  plugin projects it into `openai.chat` form and says so in `llm_protocol`.
  Everything the runtime classifies from — messages, tool schemas, tool
  calls, tool results — survives the projection. The response side holds no
  raw provider body at all (it is reassembled from a chunk stream), which is
  exactly what `llm_protocol: "canonical"` is for.
- **Auxiliary model calls** (compaction, session titling) are machinery, not
  the agent's conversation, and are deliberately not judged.

## Development

```sh
npm install          # from the repo root (npm workspace)
npm run build        # tsc + the browser half
npm test             # node --test against a strict mock v0.8 runtime
```

The mock runtime validates every event against the exact v0.8 field set —
every field required, extras rejected — and any rejection fails the test, so the
suite doubles as a wire-conformance check. The tests drive dsh's REAL tool
registry and Cordis waterfalls (see [`tests/harness.mjs`](tests/harness.mjs))
— a change in how dsh orders or short-circuits its pipeline shows up as a
failure, not a silently bypassed guard.
