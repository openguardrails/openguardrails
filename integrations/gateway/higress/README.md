# OpenGuardrails Runtime — the Higress plugin

A Higress WASM plugin that speaks **OGR v0.7 directly to an OpenGuardrails
runtime**. It implements **Recipe B of the v0.7 Runtime API**
([`specification/runtime-api.md`](../../../specification/runtime-api.md)): the
gateway integration.

It is called **OpenGuardrails Runtime** in the Higress console;
`openguardrails-runtime` is its plugin name.

```
   client ──▶ Higress ──▶ OpenGuardrails Runtime (WASM) ──▶ runtime
                              │                    POST {base_path}/v1/{evaluate,ingest}
                              ▼                    (base_path defaults to "", the canonical /v1/* root)
                          LLM upstream
```

## The v0.7 shape: a raw forwarder

One proxied model call is one **step**, reported as two events:

| flow | event | payload |
|---|---|---|
| request | `step/request` | the provider request body, **verbatim** |
| response | `step/response` | the provider response body verbatim; for a streamed reply, the canonical `{text, reasoning?, tool_calls?, model?, timing?}` shape reassembled from the SSE frames |

Both share a plugin-minted `step_id`. The gateway declares **no coordinates** —
no `session_id`, no `turn`, no `step` numbers. A proxy sees one stateless call
at a time; the runtime derives session/turn/step server-side and echoes them on
the verdict (`attribution: "derived"`).

**Nothing is decomposed client-side.** Earlier versions classified the
conversation into turns, actions and outcomes, itemised history, fingerprinted
the tool set, and carried a transcript envelope — roughly 900 lines of the
plugin doing the runtime's job, twice. All of it moved runtime-side; what
remains here is what only the thing in the byte path can do: hold the bytes,
enforce the verdict, splice the redactions, reassemble and time the stream, and
render a refusal in the caller's own protocol.

An unreadable body still produces an event (`{"unparsed": true, "reason",
"bytes"}` under the matching step kind): silence is indistinguishable from
health, and traffic that passes unjudged must at least pass *counted*.

## One switch

```yaml
mode: observe   # report only: never pauses a request, never touches a body
mode: enforce   # evaluate each step half before it proceeds, honour the verdict
```

| mode | where events go |
|---|---|
| `observe` | **everything to `/ingest`.** Nothing waits; nothing is refusable, because the request is already gone. |
| `enforce` | **each step half to `/evaluate`** — one event, blocking. |

**Observe still detects.** The runtime evaluates on ingest too, so the console
fills with findings while the gateway stays a mirror. That is what makes the
migration safe: watch for a week, then flip the switch. Rolling back is
flipping it back, not redeploying.

⚠️ **The two modes compute events identically; only the dispatch differs.**
⚠️ **Observe never buffers and never pauses.** Only enforce buffers, because
only enforce can still change the reply.

## Mirror

A second runtime can receive a COPY of every event and decide nothing:

```yaml
mirror_cluster: "outbound|80||openguardrails-candidate.static"
mirror_base_url: "http://openguardrails-candidate.static"
mirror_api_key: "ogr_..."      # falls back to api_key
mirror_base_path: ""           # falls back to base_path
```

⚠️ **Dispatched, never awaited, in every mode — including enforce.** A mirror is
not in the decision, so a slow or dead candidate must cost the caller nothing.
It rides `/ingest`: the mirror runtime evaluates on ingest anyway.

## Which protocols it reads

Three, natively, each with its own adapter under
[`protocol/`](protocol/README.md):

| client speaks | path | `llm_protocol` |
|---|---|---|
| Chat Completions | `…/chat/completions` | `openai.chat` |
| Responses | `…/responses` | `openai.responses` |
| Anthropic Messages | `…/messages` | `anthropic.messages` |

Detected per request from the path, falling back to the body shape, and
reported on every event. Each adapter renders its own refusal, its own SSE
reader and its own restore paths — a refused Anthropic caller gets an Anthropic
reply.

⚠️ It is the **client's** protocol, never the upstream provider's. The plugin
runs at priority 200 and ai-proxy at 100, so on the request it sees the body
before ai-proxy translates it and on the response after ai-proxy has translated
back — both times, the shape the caller chose.

## Identity

The consumer header (`x-mse-consumer` by default) becomes **`agent_id`** — the
consumer the gateway authenticated IS the agent. The consumer-group header
(`x-mse-consumer-group`) becomes **`agent_workspace`** — a group of agents plus
one policy set. Three more renameable headers carry `agent_type`,
`agent_owner`, `agent_user`. Owner and user are attributes; they never select
policy. A route that sends none of these still works: the runtime derives the
agent from the API key.

Every event also carries `integration: "ogr-higress/<version>"` — which build
observed it, for fleet coverage and bad-rollout triage.

⚠️ **The identity headers are only as trustworthy as the edge that writes
them.** The plugin reports whatever arrives. A forged `agent_id` misattributes
the audit trail; a forged **workspace** changes WHICH POLICY SET applies. Strip
the consumer headers from client requests at the edge, before AUTHN, or use
headers no client can reach — and verify it on your own deployment; ours did
not.

## Judging a STREAMED answer

**Not while it grows.** The pipeline measured mid-stream judgement directly: at
25% of the reply visible, false positives on `mt_harm_correct` are 0.353
against 0.000 on the whole reply — all of it the answer that agrees on the
surface and corrects underneath ("是的，很多人有这种念头——但这个想法是错的").
Early detection is a fit prefilter and an unfit blocking criterion.

### Two lanes, decided by the INPUT verdict (`output_mode`)

```
question ─┬─► model prefill ──────────────► first token ──► …
          └─► input check (parallel, off the TTFT path)
                ├─ buffer → WITHHOLD the answer, judge it whole, release or refuse
                │           (a true block: the caller never saw it)
                └─ stream → PASS THROUGH, judge whole at end of stream,
                            on a hit emit finish_reason: "content_filter"
                            (a retraction: the caller may already have read it)
```

⚠️ **Which lane is the RUNTIME's decision**, carried on the input verdict as
`output_mode`. A gateway that picked its own lane would be a second place
policy lives.
⚠️ **Both lanes get the final check** — 11.5% of real violating replies have a
question the input side never flags.
⚠️ **The retraction lane cannot un-deliver bytes.** A deployment that can accept
no exposure forces the buffered lane (or `stream: false`) and pays the latency.
⚠️ Interim judgments carry **`ogr-partial: 1`** (decide, answer, record
nothing); the answer is reported once, whole, at end of stream.

The streamed `step/response` also carries **`timing`**
(`started_at`/`first_token_at`/`completed_at`) — facts only the thing in the
byte path can measure, feeding the platform's TTFT-vs-decoding split.

## Redaction: applying the verdict's spans

The runtime never returns plaintext: a verdict carries
`modifications.spans[] = {path, start, end, replacement}` — offsets and a
token, never the matched text. The party that already holds the plaintext does
the splicing — this plugin, before the body is forwarded.

v0.7 made this **generic**. A span's `path` names a location in the body we
sent (`payload.messages.3.content`, bracket form accepted), and the runtime —
which holds the session — returns spans for everything in the body that must
not reach the model: this turn's findings AND values bound on earlier turns
that the client re-sent in the clear. There is no registration table, no
protocol-specific mask paths and no gateway-side session store: the whole
conversation is in the body, so the spans cover it.

- Spans on one string apply **highest offset first**, so a splice cannot shift
  the offsets a later span was computed against.
- **Offsets are CHARACTERS, not bytes.** The detectors count code points and Go
  indexes bytes; on Chinese text a byte splice masks a fragment that matches
  nothing while the value travels on. Found live 2026-07-30.
- What each splice displaced becomes the token→value map that **restores the
  reply** (buffered and streamed — the SSE restorer handles tokens split
  across deltas and markdown-escaped tokens, and flushes its pending tail
  before the stream closes).
- ⚠️ A span that does not resolve — an unknown path, a non-string, offsets out
  of range — is **dropped and counted** (`unresolved_spans`), never applied
  somewhere else. Silent, that disagreement looks exactly like a workspace
  with no redaction policy; the counter is the only signal.
- ⚠️ Spans against a streamed reply's canonical payload cannot be spliced into
  SSE frames the caller already received; they are counted unresolved rather
  than half-applied.

## No state survives a request

The plugin keeps nothing across requests — no Redis, no session store, no
"already reported" marks. Each request re-derives everything from the bytes it
carries; the runtime holds the session, numbers the placeholders, and answers
each request with the spans that apply to it. An exact replay is judged again,
which is the safe direction: the opposite (suppressing a turn we believe we
have seen) is how a retried blocked prompt reaches the model unjudged.

## Liveness

Silencing a PEP is the cheapest bypass: uninstall the plugin and every request
is unguarded, with nothing in the console to say so. So the plugin heartbeats
every 30s as its **integration** (`{integration, interval_s, counters}`).
Silence past `interval_s` is a coverage loss, not an absence of risk.

| counter | meaning |
|---|---|
| `evaluated` | verdicts asked for and received |
| `unchecked` | **traffic that passed with no verdict behind it** |
| `ingested` | events reported asynchronously |
| `mirrored` | batches copied to the candidate runtime |
| `stream_stopped` | streamed answers refused or retracted at end of stream |
| `unresolved_spans` | **modification spans that named nothing this body holds** |
| `unreadable` | bodies recognised but not parseable — NOT judged |
| `refused` | requests this filter refused (block, fail-closed, partial-closed) |

`unchecked` is the one to alert on: it is what a tight `timeout_ms` plus
`fail_mode: open` produces, and it is invisible in any other signal.
`unresolved_spans` is the second, and it fails the other way — nothing masked,
no error, indistinguishable from a deployment with no redaction policy.

### Partial verdicts, and what `fail_mode: closed` really promises

The promise to an operator who sets `closed` is: *if we could not judge it, it
does not go through.* That must hold one level deeper than transport. The
runtime fans out per text — a reply with five tool calls is five judge calls —
and one failing under the runtime's OWN fail-open produces a verdict that
looks complete: four actions judged, one never looked at, `decision: allow`,
HTTP 200.

**`unjudged` on the verdict** (first-class in v0.7) is what separates those:
the payload paths that reached a detector and got no judgement. Absent or
empty means everything routed was judged — the one assertion fail-closed hangs
on. Coverage, not attendance: a path appears if ANY guardrail routed to it
failed. The plugin does not interpret the entries — the security property is
non-emptiness, and entries go to the log verbatim.

Under `closed` a non-empty list refuses the event (with a message distinct
from the transport-failure one — the service answered, it just did not answer
about everything); under `open` it passes and bumps `unchecked`.

Also treated as failures, never as allows: a non-200, a timeout, a 429, and **a
200 whose body is not a verdict** (an empty body, an HTML error page — found
live by pointing the plugin at a cluster with nothing behind it and watching
the traffic pass with `decision=` empty).

## Configuration

| Key | Default | Notes |
|---|---|---|
| `runtime_cluster` | — | Envoy cluster, e.g. `outbound\|80\|\|openguardrails-runtime.static` |
| `runtime_base_url` | — | used for the Host header |
| `base_path` | `""` | the mount prefix the canonical `/v1/*` endpoint paths are joined onto |
| `api_key` | — | the runtime API key; authenticates the SENDER, resolves the org |
| `mode` | `observe` | `enforce` to act on verdicts |
| `timeout_ms` | `5000` | the PDP budget, enforce only. A CEILING for the worst case, not a target; the runtime's `OGR_MODEL_TIMEOUT_MS` must fit strictly inside it |
| `fail_mode` | `open` | `closed` refuses when the PDP is unreachable, answers garbage, or reports unjudged paths |
| `agent_id_header` | `x-mse-consumer` | which header carries the agent's identity |
| `agent_workspace_header` | `x-mse-consumer-group` | which header carries the agent's workspace |
| `agent_type_header` | `x-ogr-agent-type` | which header carries the kind of agent |
| `agent_owner_header` | `x-ogr-agent-owner` | which header carries the agent's responsible party |
| `agent_user_header` | `x-ogr-agent-user` | which header carries who is using the agent this session |
| `agent_id` / `agent_type` / `agent_workspace` / `agent_owner` | *(unset)* | static fallbacks for a route fronting exactly one agent. No static `agent_user` — a constant user is already the runtime's default |
| `mirror_cluster` / `mirror_base_url` | *(unset)* | a candidate runtime that gets copies and gates nothing |
| `mirror_api_key` | `api_key` | the mirror's own credential, when it differs |
| `mirror_base_path` | `base_path` | the mirror's own mount, when it differs |
| `log_level` | `quiet` | `quiet` \| `info` \| `debug`. Quiet prints only what says the deployment is broken. Anything unrecognised is quiet — the failure mode of this setting is disk. |

### Which paths it calls

The canonical endpoint paths are rooted at **`/v1/`**: the plugin joins
`base_path` with `/v1/evaluate`, `/v1/ingest` and `/v1/heartbeat`, and
hard-codes no other prefix. The mount is **configuration, not discovery** — a
WASM filter cannot cheaply probe-and-fall-back, and a wrong `base_path` is
loud (every `/evaluate` comes back non-200, which is `fail_mode` territory,
not silence). What loaded is printed once, at startup, in the `[OGR-CONFIG]`
line.

### The budget, and why it is ordered

⚠️ **5s is a CEILING, not a target** — what a person tolerates once, on a bad
request. A 1s budget was tried and measured wrong: latency scales with
concurrency (12 concurrent: 619→1647ms), so a budget inside the working
distribution makes enforcement evaporate exactly when the gateway is busy.

⚠️ **The budgets must be ordered, outermost longest**: `timeout_ms` > the
runtime's `OGR_MODEL_TIMEOUT_MS` > the model gateway's own. Equal budgets are
a race, and when this filter wins it nothing can name what was slow. Order the
chain by lowering the INNER budgets, never by raising this one — that spends
the user's patience, which is the one resource in this chain that is not ours.

⚠️ **It is a fan-out budget too.** A response carrying N tool calls costs the
runtime N judge calls; fail-open then makes that failure *faster and quieter
than success*. `unchecked` is the number that tells you.

## Build and test

```bash
make test    # ordinary Go tests — the span applier, the SSE restorer, wire shapes
make build   # GOOS=wasip1 GOARCH=wasm -> plugin.wasm
```

Nothing in this plugin may depend on being inside a Wasm VM: `go test` builds
the package for the host, which is what keeps the parts that are easy to get
wrong (offsets, chunk boundaries, verdict reading) testable in a second.

### The local lab

Sideload rather than an OCI pull (the docker bridge on the dev box has no
egress):

```bash
cp plugin.wasm references/higress_root/openguardrails-runtime.wasm
# WasmPlugin CR with url: file:///data/openguardrails-runtime.wasm, priority 200
```

⚠️ Priority must stay BELOW `key-auth` (310): the consumer headers this plugin
reads are written by key-auth, and a plugin that runs first sees no caller at
all.
⚠️ Bumping the version in the CR name is what forces a reload; editing config
in place does not always take.

## Releasing

Bump `VERSION`, then push the matching tag:

```bash
git tag higress-v2.0.0 && git push origin higress-v2.0.0
```

`.github/workflows/publish-higress.yml` refuses a tag whose version does not
match `VERSION`, runs the tests, builds `plugin.wasm`, and `oras push`es the
gzipped layer under both the version and `latest`:

```yaml
url: oci://docker.io/openguardrails/higress:2.0.0
```

Publishing needs `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` (a Docker Hub
**access token** scoped to that one repository). Missing secrets fail the
publish job rather than skipping it — a tag with no artifact behind it is
worse than a red run. (GHCR was tried first and lost: a GHCR package created
by Actions stays private until someone flips it by hand, and a reference a
gateway cannot pull anonymously is not a release.)

## Support

thomas@openguardrails.com
