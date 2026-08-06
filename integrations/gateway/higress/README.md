# OpenGuardrails Runtime — the Higress plugin

A Higress WASM plugin that speaks **OGR directly to an OpenGuardrails runtime**.

It is called **OpenGuardrails Runtime** in the Higress console; `openguardrails-runtime`
is its plugin name.

```
   client ──▶ Higress ──▶ OpenGuardrails Runtime (WASM) ──▶ runtime
                              │                    POST /api/public/ogr/v1/{evaluate,ingest}
                              ▼
                          LLM upstream
```

It replaces the previous pair — the `og-connector-higress-go` plugin plus a
Python adapter process — which was written against the previous-generation
platform's HTTP contract, so every runtime concept had to be squeezed through it:

| Squeezed through the old contract | Here |
|---|---|
| Thirteen GuardEvent kinds became two (`user_input`, `model_output`) | every kind the traffic actually contains — see below |
| Streaming replies were never reported at all | the stream is reassembled and reported |
| `flag` had to become "pass", `require_approval` a refusal | the Verdict is read as-is |
| Batching had no place in the wire shape | `/ingest` takes up to 100 events per call |
| An extra network hop (adapter process) per request | gone |

## One switch

```yaml
mode: observe   # report only: never pauses a request, never touches a body
mode: enforce   # evaluate before the model sees the prompt, honour the verdict
```

**Observe still detects.** The runtime evaluates on ingest too, so the console
fills with findings while the gateway stays a mirror — the events go out
fire-and-forget and nothing waits for them. That is what makes the migration
safe: install this alongside the old plugin, watch for a week, then flip the
switch and retire the old one. Rolling back is flipping it back, not
redeploying.

⚠️ **Observe never buffers and never pauses.** It does not stop the request for a
verdict, does not hold the reply to read it, and does not rewrite a body. A
non-streamed answer flows through the streaming hook untouched while a bounded
copy is kept, so the reply can still be reported without the caller waiting for
anything. Only enforce buffers, because only enforce can still change the reply.

## Mirror

A second runtime can receive a COPY of every event and decide nothing:

```yaml
mirror_cluster: "outbound|80||openguardrails-candidate.static"
mirror_base_url: "http://openguardrails-candidate.static"
mirror_api_key: "ogr_..."      # falls back to api_key
```

It answers "what would the new policy have said" without anyone betting on the
answer. ⚠️ **Dispatched, never awaited, in every mode — including enforce.** A
mirror is not in the decision, so a slow or dead candidate must cost the caller
nothing; verified by killing the mirror mid-test, where the request kept its
normal latency and the plugin logged `[OGR-MIRROR] status=503` and moved on. It
rides `/ingest` rather than `/evaluate` for the same reason: the mirror runtime
evaluates on ingest anyway, so its console fills with the same findings and no
verdict is ever waited for.

## What one chat request becomes

A gateway sees ONE turn at a time and an OpenAI client re-sends the whole
conversation every request, so the only question is what is NEW:

| Evidence in the payload | Event |
|---|---|
| `tools[]` (first sight, and again whenever the set CHANGES — that is what a rug-pull looks like) | `tool_register` |
| `messages[].role == "tool"` not seen before | `tool_result` |
| `assistant.tool_calls[]` in the history | `tool_call` (already ran; reported, not gated) |
| the newest user message | `user_input` |
| the response's content | `model_output` |
| the response's `tool_calls` — **the only copy still stoppable** | `tool_call` |

The old shape (one `user_input` per request) is why a whole gateway deployment
was invisible to the tool_call guardrails: `permission`, `command-danger` and
`command-rules` judge an ACTION, and no action was ever reported.

Identity: the consumer header (`x-mse-consumer` by default) becomes
`subject.principal` — WHO the gateway authenticated, which the runtime treats as the
agent's owner. The consumer-GROUP header (`x-mse-consumer-group`) becomes
`subject.principal_group`, which the runtime maps to a policy boundary; it is sent
even when the consumer header is absent, because it still says which group's rules
apply. Two fields on purpose: a consumer authenticates, a group is where policy
attaches (see the note in `specification/guard-event.md`).

**`subject.agent_id` is deliberately left unset** — the runtime recognises the agent
from the system prompt, and naming the gateway consumer as the agent would collapse
every agent behind one key into one row. A promptless chat application becomes a
`chatbot`, one per (principal, sensor). `session_id` is derived from (principal +
system prompt + first user message), so it is stable across turns with no stored
state.

## Redaction

The runtime never returns plaintext: a verdict carries span OFFSETS and no
matched text, so no verdict store becomes a copy of the data it guards. The party
that already holds the plaintext does the masking — this plugin. It mints
`${OGR_<TYPE>_<n>}`, rewrites the outgoing prompt, and restores the reply
(streaming and buffered).

⚠️ **Offsets are CHARACTERS, not bytes.** The detectors count code points and
the runtime relays them; Go indexes bytes. On Chinese text — three bytes per
character — byte slicing lands a third of the way into the span, returns a
fragment that matches nothing, and the value goes to the model untouched *while
the log says "masked"*. `runeSlice` in `redact.go` is that fix, found by testing
with a Chinese prompt on 2026-07-30.

⚠️ Restoration matches the mapping's OWN KEYS, not a token syntax, and absorbs
markdown escaping (`${OGR\_EMAIL\_1}` — a model formatting its answer). A whole
token must still match: a restorer that guesses is an exfiltration oracle.

### Where the plaintext lives: sealed, in a gateway-side Redis

The session (token→value map, plus what has already been reported) **cannot live
in this process**. Envoy gives every worker thread its own Wasm VM and
round-robins connections across them, so turn 1 and turn 2 of one conversation
land in different VMs — measured, not theoretical: workers 712 then 701 on two
consecutive requests. A Go global re-masks nothing on turn 2 and re-reports the
whole history as new.

So it is shared through Redis, **sealed with AES-256-GCM** under a key that lives
only in the plugin configuration (`session_key`). The store holds ciphertext; a
dump of it is useless. That is what keeps the rule intact — a store must not
become a copy of the data it guards — while still crossing workers.

Requirements, in order of how load-bearing they are:

- **`session_key` is required** whenever `redis_cluster` is set. Missing or short
  ⇒ the plugin refuses to load, rather than falling back to storing the session
  in the clear. This is the one that actually protects the map.
- **The OGR deployment's own Redis is fine** — the same one the runtime uses. The
  sealing is what keeps the store from becoming a copy of the guarded data, not
  the choice of host: the key lives only in the plugin's configuration, so the
  runtime cannot read what the gateway wrote even though it owns the server.
  A separate instance buys operational isolation, not secrecy.
- What DOES matter operationally: `maxmemory-policy` must not evict these keys out
  from under a live conversation (an evicted session degrades to un-restored
  placeholders reaching the user — visible, not a leak), and the session traffic
  should not crowd out the runtime's queues. Persisting is harmless: what lands on
  disk is ciphertext.
- Rotating the key invalidates live sessions — their placeholders stop restoring,
  visibly. GCM authenticates, so a stale key can never silently decrypt into the
  wrong conversation.

⚠️ **The store is not only for masking, so `observe` needs it too.** `deriveRequest`
reads it to know what has already been reported; without it every worker re-reports
the whole conversation as new. Measured: six identical requests produced **four**
`user_input` and **four** `tool_call` events with no Redis, and **one each** with
it. A duplicated event stream is easy to mistake for traffic, so the plugin warns
about this at load in both modes.

Without `redis_cluster` the plugin still masks and restores within one request —
what it loses is everything that has to survive across them.

⚠️ Concurrent turns of ONE conversation are last-write-wins. Turns of a chat are
sequential by nature, so the race costs a re-mask, not a leak.

**The token is the runtime's.** `evaluate` already mints `${OGR_<TYPE>_<n>}` per
span from a session-scoped counter and returns it in
`modifications.spans[].replacement`; the plugin uses that and only mints its own
as a fallback. Two numbers for one value would put two names for one person in
the model's context.

## Liveness

Silencing a PEP is the cheapest bypass of an altitude: uninstall the plugin and
every request is unguarded, with nothing in the console to say so — "no events"
looks exactly like a quiet afternoon. So the plugin heartbeats every 30s, as the
**sensor** (`openguardrails-higress-connector`), which the runtime records in
`pep_sensors`. Silence past the declared `interval_s` is a coverage loss, not an
absence of risk.

It carries counters, which is the half that catches selective suppression — a PEP
claiming N sent while N−k arrived:

| counter | meaning |
|---|---|
| `evaluated` | verdicts asked for and received |
| `unchecked` | **requests that reached the model with no verdict behind them** |
| `ingested` | events reported asynchronously |
| `mirrored` | batches copied to the candidate runtime |

`unchecked` is the one to alert on: it is what a tight `timeout_ms` plus
`fail_mode: open` produces, and it is invisible in any other signal.

⚠️ **The counters and the beat live in proxy-wasm SHARED DATA, not Go globals.**
Envoy gives every worker thread its own Wasm VM, so a package-level counter is one
number per worker and the tick that reads it runs in yet another. The first cut
shipped exactly that: heartbeats on schedule carrying `{"evaluated":0}` while the
gateway was busily evaluating — a reconciliation signal that always says "nothing
happened", which is worse than none. Shared data is process-wide and CAS-guarded,
which is what these two facts actually are. The same CAS elects ONE beater per
period, or the runtime would receive one heartbeat per worker thread (eighteen of
them on the box this was found on).

⚠️ Process-wide means a multi-POD gateway sends one beat per pod under one sensor
id, and the runtime's row keeps the last pod's counters. Liveness stays correct —
silence means every pod is gone — but per-fleet reconciliation would need an
instance identity, which the OGR sensor does not model yet.

## Configuration

| Key | Default | Notes |
|---|---|---|
| `runtime_cluster` | — | Envoy cluster, e.g. `outbound\|80\|\|openguardrails-runtime.static` |
| `runtime_base_url` | — | used for the Host header |
| `api_key` | — | the runtime API key; authenticates the SENDER, resolves org + workspace |
| `mode` | `observe` | `enforce` to act on verdicts |
| `timeout_ms` | `5000` | the PDP budget, enforce only — nothing waits in observe |
| `fail_mode` | `open` | `closed` refuses when the PDP is unreachable |
| `principal_header` | `x-mse-consumer` | which header carries the caller |
| `principal_group_header` | `x-mse-consumer-group` | which header carries the caller's group |
| `mirror_cluster` / `mirror_base_url` | *(unset)* | a candidate runtime that gets copies and gates nothing |
| `mirror_api_key` | `api_key` | the mirror's own credential, when it differs |
| `redis_cluster` / `redis_host` | *(unset)* | the shared session store; without it, masking is per-worker |
| `session_key` | — | **required with `redis_cluster`**: 32 bytes, hex or base64 |
| `redis_username` / `redis_password` | *(empty)* | |
| `session_ttl_s` | `1800` | matches the runtime's run-pointer idle TTL |

⚠️ **There is no `redact` switch.** Whether to redact is the RUNTIME's decision,
carried by the verdict (`decision: redact` plus `modifications.spans`). A gateway
that could turn it off locally would be a second place policy lives — and the
harder of the two to change.

⚠️ **`timeout_ms` bounds latency by giving up detection**, and the number matters
more than it looks. Measured against this runtime:

| | latency |
|---|---|
| single request, warm | 233–332 ms |
| 12 concurrent | 619 ms → 1647 ms, eight of them past 1s |

A 1s budget was tried on those grounds — 3x the single-request figure — and lost
nine of twelve concurrent requests to the model **unchecked**. Latency scales with
concurrency, so a budget sitting inside the working distribution means enforcement
evaporates exactly when the gateway is busy. Hence 5s, and the advice to lower it
only against numbers from your own runtime.

Whatever the number, the timeout path logs

```
[OGR-REQ] request passed UNCHECKED (fail-open): evaluate returned 0 …
```

rather than a bare status code. Grep for it: if it is not rare, the budget is wrong
for that deployment — raise it, or accept that enforcement is best-effort there.

## Verified against the live lab (2026-07-30)

Local hermes -> Higress -> runtime, GLM-5.2 upstream:

| What | Evidence |
|---|---|
| every kind, from real agent traffic | `tool_register` 377, `user_input` 13, `tool_call` 13, `tool_result` 10, `model_output` 8 |
| the agent is RECOGNISED, not guessed | signature matched `hermes`, deployment_type `employee_service` — because the system prompt rides `payload.system` |
| streaming replies are reported | `model_output` from an SSE reply, reassembled chunk by chunk |
| refusal, both response shapes | JSON body and an SSE frame + `[DONE]`; the model never saw the prompt |
| redaction, end to end, real verdict | `decision=redact findings=2` from the runtime's own privacy guardrail (a tenant `custom_entities` regex, which needs no model), prompt masked, client got the plaintext back — buffered AND streamed |
| the platform stored nothing | every stored copy reads `${OGR_EMAIL_1}`; a `LIKE '%<address>%'` over `content_preview` and `payload` returns 0 rows |
| multi-turn across workers | turn 1 on worker 722 masked, turn 2 on worker 700 `re-masked 2` from the sealed store — and only the NEW user turn was reported, so the dedup markers crossed too |
| the store holds ciphertext | the Redis value is base64 AES-GCM; grepping it for the address returns 0 |

## Build and test

```bash
make test    # ordinary Go tests — event derivation, redaction, the SSE restorer
make build   # GOOS=wasip1 GOARCH=wasm -> plugin.wasm
```

Nothing in this plugin may depend on being inside a Wasm VM: `go test` builds the
package for the host, and that is what keeps the parts that are easy to get wrong
(offsets, chunk boundaries, what counts as new) testable in a second.

### The local lab

Sideload rather than an OCI pull (the docker bridge on the dev box has no egress):

```bash
cp plugin.wasm references/higress_root/openguardrails-runtime.wasm
# WasmPlugin CR with url: file:///data/openguardrails-runtime.wasm, priority 200
```

⚠️ Priority must stay BELOW `key-auth` (310): the consumer and consumer-group headers
this plugin reads are written by key-auth, and a plugin that runs first sees
no caller at all.

⚠️ Bumping the version in the CR name is what forces a reload; editing config in
place does not always take.

## Releasing

Bump `VERSION`, then push the matching tag:

```bash
git tag higress-v1.0.1 && git push origin higress-v1.0.1
```

`.github/workflows/publish-higress.yml` refuses a tag whose version does not
match `VERSION`, runs the tests, builds `plugin.wasm`, and `oras push`es the
gzipped layer under both the version and `latest`. Higress then pulls it straight:

```yaml
url: oci://docker.io/openguardrails/higress:1.1.0
```

Publishing needs two repository secrets, `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`
(a Docker Hub **access token** scoped Read & Write to that one repository, never an
account password). Missing secrets fail the publish job rather than skipping it — a
tag with no artifact behind it is worse than a red run.

⚠️ GHCR was tried first, because the workflow can push there with its own
`GITHUB_TOKEN` and store no credential at all. It lost on the thing that matters
more: a GHCR package created by Actions stays PRIVATE until someone flips it by
hand in the UI, and a reference a gateway cannot pull anonymously is not a
release.

`workflow_dispatch` runs the build and packaging without pushing, so the release
path can be exercised before a tag exists.

## Support

thomas@openguardrails.com
