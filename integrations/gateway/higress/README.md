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
`subject.principal`. **`subject.agent_id` is deliberately left unset** — the
runtime recognises the agent from the system prompt, and naming the gateway
consumer as the agent would collapse every agent behind one key into one row. A
promptless chat application becomes a `chatbot`, one per (principal, sensor).
`session_id` is derived from (principal + system prompt + first user message), so
it is stable across turns with no stored state.

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

Requirements, all of them load-bearing:

- **A gateway-side Redis, not the runtime's.** The runtime's Redis is the
  platform's (queues, counters); this map belongs to the data plane, where the
  plaintext is already flowing.
- **Persistence off** (`--appendonly no --save ""`) and the 30-minute TTL.
- **`session_key` is required** whenever `redis_cluster` is set. Missing or short
  ⇒ the plugin refuses to load, rather than falling back to storing the session
  in the clear.
- Rotating the key invalidates live sessions — their placeholders stop restoring,
  visibly. GCM authenticates, so a stale key can never silently decrypt into the
  wrong conversation.

Without `redis_cluster` the plugin still masks and restores within one request;
it logs a warning that later turns may reach the model unmasked.

⚠️ Concurrent turns of ONE conversation are last-write-wins. Turns of a chat are
sequential by nature, so the race costs a re-mask, not a leak.

**The token is the runtime's.** `evaluate` already mints `${OGR_<TYPE>_<n>}` per
span from a session-scoped counter and returns it in
`modifications.spans[].replacement`; the plugin uses that and only mints its own
as a fallback. Two numbers for one value would put two names for one person in
the model's context.

## Configuration

| Key | Default | Notes |
|---|---|---|
| `runtime_cluster` | — | Envoy cluster, e.g. `outbound\|80\|\|openguardrails-runtime.static` |
| `runtime_base_url` | — | used for the Host header |
| `api_key` | — | the runtime API key; authenticates the SENDER, resolves org + workspace |
| `mode` | `observe` | `enforce` to act on verdicts |
| `timeout_ms` | `30000` | the OUTER hop: one call fans out to several detectors |
| `fail_mode` | `open` | `closed` refuses when the PDP is unreachable |
| `redact` | `true` | masking/restoration (enforce only) |
| `principal_header` | `x-mse-consumer` | which header carries the caller |
| `redis_cluster` / `redis_host` | *(unset)* | the shared session store; without it, masking is per-worker |
| `session_key` | — | **required with `redis_cluster`**: 32 bytes, hex or base64 |
| `redis_username` / `redis_password` | *(empty)* | |
| `session_ttl_s` | `1800` | matches the runtime's run-pointer idle TTL |

⚠️ `timeout_ms` is 30000, not the runtime's own 800ms detector budget. A tight
budget plus fail-open is the silent-failure shape: every request passes and the
logs look healthy.

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

⚠️ Priority must stay BELOW `key-auth` (310): the consumer header this plugin
reads as the principal is written by key-auth, and a plugin that runs first sees
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
gzipped layer to `docker.io/openguardrails/higress` under both the version and
`latest`. Higress then pulls it straight:

```yaml
url: oci://docker.io/openguardrails/higress:1.0.1
```

The workflow needs two repository secrets — `DOCKERHUB_USERNAME` and
`DOCKERHUB_TOKEN` (a Docker Hub **access token** scoped Read & Write to this one
repository, never an account password). `workflow_dispatch` runs the build and
packaging without pushing, so the release path can be exercised before a tag
exists.

## Support

thomas@openguardrails.com
