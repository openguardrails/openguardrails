# @openguardrails/dsh

**OpenGuardrails for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) — the v0.7 Recipe A reference integration.**

This plugin implements **Recipe A of the v0.7
[Runtime API](../../../specification/runtime-api.md#the-two-integration-recipes)**
— the reference **agent-direct** integration. dsh owns its loop, so the plugin
sits on the loop's documented seams (an ordinary
[Cordis](https://github.com/cordiverse/cordis) plugin, no core changes) and
judges every model step at the moments something can still be refused:

| Seam | Event | What a `block` does |
| --- | --- | --- |
| before the model call (`llm/stream`) | `step/request` — the assembled request, `openai.chat` projection | the model is never called; the step ends as an error and the turn closes |
| after the answer, before the agent acts | `step/response` — canonical `{text, reasoning?, tool_calls, model, usage, timing}` | the whole answer is withheld — or, when every blocking finding names a `payload.tool_calls.N` path, only those calls are refused: the prose reaches the user and each offending call is denied at the tool registry |
| tool results | *(no third call site)* | results travel in the NEXT step's request and are judged there |
| turn close (`session/event`) | `turn/end` via `/v1/ingest` | records the loop's own close reason (`completed` \| `max_tokens` \| `blocked` \| `aborted` \| `error`); a turn this plugin blocked reports `blocked` |

**Coordinates are declared, never derived.** Every event carries
`session_id` (the dsh session), `turn` and `step` (the loop's own 1-based
numbers, read off the `agent/request` dispatch), and `parent_session_id` for
subagent children — the platform's Trajectory view renders the loop exactly
as dsh ran it, and verdicts echo the coordinates back with
`attribution: "declared"`.

**No SDK.** The integration is two hand-rolled POSTs (`/v1/evaluate`,
`/v1/ingest`) in [`src/wire.ts`](src/wire.ts) — under 200 lines, and the
recommended starting point for anyone integrating their own harness.

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

## Degraded mode

`failMode` is the deployment's stated posture per
[the degraded-mode spec](../../../specification/degraded-mode.md), and it
covers every shape of "could not look":

- an unreachable runtime, an evaluate timeout, a 429;
- a verdict whose `unjudged` names paths that were never judged;
- a tool call that reached execution with **no step verdict at all** — the
  signature of a `tools/pre-execute` waterfall that short-circuited before
  this plugin ran (the monotonic `ctx.tools.guard`, which cannot be
  reordered away, is what catches it).

`open` (default) proceeds loudly; `closed` treats all of it as block.

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
  message objects is not implemented; the plugin warns once and sends content
  unredacted. The runtime's stored copy is masked regardless.
- **The request is a projection, not a byte-exact capture.** The `llm/stream`
  waterfall runs on `GenerateOptions`, dsh's provider-neutral request; the
  plugin projects it into `openai.chat` form. Everything the runtime
  classifies from — messages, tool schemas, tool calls, tool results —
  survives the projection.
- **Auxiliary model calls** (compaction, session titling) are machinery, not
  the agent's conversation, and are deliberately not judged.

## Development

```sh
npm install          # from the repo root (npm workspace)
npm run build        # tsc + the browser half
npm test             # node --test against a mock v0.7 runtime
```

The tests drive dsh's REAL tool registry and Cordis waterfalls (see
[`tests/harness.mjs`](tests/harness.mjs)) — a change in how dsh orders or
short-circuits its pipeline shows up as a failure, not a silently bypassed
guard.
