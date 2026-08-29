# openguardrails-instrumentation-hermes

Guard a [Hermes](https://github.com/NousResearch/hermes-agent) agent through
the [OpenGuardrails (OGR)](https://github.com/openguardrails/openguardrails)
**v1.x Runtime API** — the agent-direct recipe
(`specification/runtime-api.md`): two `POST /v1/evaluate` calls per model
call, verdicts enforced before the answer is shown and before any tool call
or exec runs — and, since **2.0**, [local secrets redaction](#local-redaction-20):
secrets are masked to `${OGR_SECRET_n}` **before the request leaves the host**
and restored only into a tool's arguments, after judgement. Zero dependencies;
the whole wire is hand-rolled over stdlib `urllib` in
[`src/.../wire.py`](src/openguardrails_instrumentation_hermes/wire.py) and
[`local_redaction.py`](src/openguardrails_instrumentation_hermes/local_redaction.py).

Installing the Python package does **not** activate a Hermes plugin by
itself. Hermes discovers plugins from `$HERMES_HOME/plugins` (normally
`~/.hermes/plugins`) and the plugin must be enabled:

```bash
# Development checkout of the OpenGuardrails repository
python -m pip install -e integrations/agent/hermes
mkdir -p "${HERMES_HOME:-$HOME/.hermes}/plugins"
ln -sfn "$PWD/integrations/agent/hermes/src/openguardrails_instrumentation_hermes" \
  "${HERMES_HOME:-$HOME/.hermes}/plugins/ogr-guard"
hermes plugins enable ogr-guard
hermes plugins list
```

Run these from the OpenGuardrails repository root, then restart Hermes.

## Configuration

Everything is environment variables (constructor kwargs override them, for
embedding):

| Variable | Default | Meaning |
| --- | --- | --- |
| `OGR_RUNTIME_URL` | — | Runtime base URL. Canonical `/v1/...` paths are joined onto it; a deployment prefix belongs in the URL, never in code. Unset = no runtime, and the **fail mode decides** (default open = pass-through). |
| `OGR_API_KEY` | — | Organization API key (`Authorization: Bearer`). |
| `OGR_FAIL_MODE` | `open` | What an unanswered evaluate means (timeout, 429, 5xx, network, unconfigured): `open` proceeds and counts the gap; `closed` denies until the runtime answers. An unrecognized value degrades to `closed` — a deployment that touched the knob wanted more than the default. |
| `OGR_TIMEOUT` | `4.0` | Per-evaluate budget, seconds. Deliberately short: every call sits between the agent and its next action. |
| `OGR_REFUSAL_TEXT` | a generic sentence | What the user sees instead of a blocked answer. Says nothing about why by design — categories and rule text are internals (and a map of what to route around); they stay in the runtime's record and this plugin's log. |
| `OGR_SESSION_TAG` | `on` | 1.1.0: stamp an opaque session tag (`user` = `hermes_session_<sha256[:32]>` on OpenAI modes, `metadata.user_id` on the Anthropic mode) onto every OUTBOUND model request, via Hermes' `llm_request` middleware. This is for the GATEWAY in front of the model: an OGR runtime observing there reads the tag and reassembles the session exactly instead of inferring it from conversation prefixes — which survives context compaction and history trimming. Never overwrites a value the deployment already set; `off` disables. Attribution only, like every self-declared OGR field. |
| `OGR_REDACT_MASK` | keep placeholders | Replace redaction spans with this flat string (e.g. `[已隐去]`) instead of the verdict's `${OGR_PHONE_1}`-style placeholders. |
| `OGR_LOCAL_REDACTION` | `true` | 2.0: mask secrets to `${OGR_SECRET_n}` before the request leaves the host ([below](#local-redaction-20)). `false` = exactly the 1.x wire: no `redaction` field on events, no restore middleware registered. |
| `OGR_RULES_CACHE` | `~/.openguardrails/rules-<sha256(runtime_url)[:8]>.json` | Where the fetched ruleset is cached (mode 0600, written atomically). Rules only — the value↔token map is never written to disk. |
| `OGR_RESTORE_OUTPUT` | `false` | Restore this session's tokens in the FINAL answer. Off by default: Hermes gateways deliver the answer to Telegram/Slack/Discord, each one an egress. The user asked the agent to USE the secret, not to read it back. |
| `OGR_LOCAL_REDACTION_TIERS` | `strong,heuristic` | Which rule tiers to mask. Both by default — a reversible mask over-masking costs the model its view of one value; the tool still gets the real one. |

### The identity four-tuple

All four ride on **every** event; the empty string is the explicit "no
assertion", never an error. Everything defaults to `""` except `agent_type`
— the one fact this plugin does know about itself:

| Variable | Default | Example | Field |
| --- | --- | --- | --- |
| `OGR_AGENT_ID` | `""` (derived from the API key — the identity floor) | `hermes-laptop-tom` | WHICH agent; the inventory and policy resolution key on it |
| `OGR_AGENT_TYPE` | `hermes` | `hermes` | what KIND — a harness label, never an identity |
| `OGR_AGENT_WORKSPACE` | `""` (the key's workspace) | `research-agents` | agent GROUP — one workspace, one policy set |
| `OGR_AGENT_USER` | `""` (every session is one user) | `u-8232` | who is USING it this session |

## How Hermes' hooks land on the recipe

One model call = one `step_id` = two events, both
`llm_protocol: "canonical"` — Hermes hands its hooks message lists and an
assistant-message object, never the provider's raw body, and the canonical
shape is exactly the vocabulary for that vantage. Nothing is fabricated to
look raw.

| Hermes hook | Recipe role |
| --- | --- |
| `pre_api_request` | `step/request` evaluate — canonical `{messages}`, the full conversation being sent. Tool results need no call of their own: this is the event that carries and judges them. |
| `post_api_request` | `step/response` evaluate — canonical `{text, reasoning?, tool_calls, timing}`. `timing` is the two wall-clock facts this vantage observes; `usage` is omitted, not zeroed (the hook holds no token counts). |
| `transform_llm_output` | ENFORCE on the answer: withholds a block, applies `modifications.spans` in place. |
| `pre_tool_call` | ENFORCE on tool calls: a blocked `step/response` means the round's tool calls do not run; a call carrying a token this session never issued is refused (2.0). |
| `BaseEnvironment.execute` (wrapped) | The exec fragment — see below. |
| `llm_request` (middleware) | 2.0: MASK the outbound provider request — every string leaf — and stamp the session tag. Runs before `pre_api_request`, so the event above is the masked one. |
| `tool_execution` (middleware) | 2.0: RESTORE tokens into the tool's arguments, after `pre_tool_call`, the guardrails and the approval gate. |
| `llm_execution` (middleware) | 2.0: with `OGR_FAIL_MODE=closed` and no ruleset at all, refuse the model call. |

**Why the decide/enforce split:** Hermes discards what
`pre/post_api_request` return (`agent/conversation_loop.py` invokes them for
effect only), so the hooks that hold the step's content cannot act, and the
hooks that can act hold only fragments. Verdicts are therefore obtained
where the content is, parked per session, and enforced at the two seams
Hermes provides.

### The exec fragment

Hermes has no environment-level hook, so the plugin wraps the one exec
chokepoint (`tools.environments.base.BaseEnvironment.execute` — every
backend routes through it; optional, idempotent, fails open on layout
drift). The wrapper holds exactly one command about to run — not the model
call that produced it — so it sends what it actually holds: a canonical
`step/response` whose `tool_calls` is that one command, under its own fresh
`step_id`. What it buys over `pre_tool_call` is the **real argv**: a script
that shells out to something its tool arguments never mentioned is seen
here and only here.

## Local redaction (2.0)

**What it does.** Today, on the agent path, every `sk-…` in a system prompt,
every `.env` an agent reads, every `Authorization:` header in a curl it
composes goes to the model provider verbatim — the runtime sees it
*afterwards*, as a finding, from a copy that has already left. Since 2.0 the
plugin masks each secret to a `${OGR_SECRET_n}` token **on the host, before
the request leaves**, and restores the value **only into a tool's
arguments, after every judgement** — so the provider, the runtime and the
human approval prompt all see `curl -H "Authorization: Bearer
${OGR_SECRET_1}"`, and the tool runs with the real value. A secret is
opaque to the model (it has no use for the bytes, only for the fact that
there is one and where it goes), which is exactly why the mask is lossless
and can be applied blind.

- **Rules live in the runtime, not here.** The plugin ships no patterns: it
  fetches the org's ruleset from `GET /v1/rules` with the API key
  (`If-None-Match` on the cached id → `304`), caches it at
  `OGR_RULES_CACHE` (mode 0600), and reports the ruleset id on every event
  and heartbeat. The heartbeat (every 30 s) answers with the id the runtime
  currently serves; a mismatch refetches in the background, so a rule change
  reaches a running plugin within one interval.
- **Every rule is self-verifying.** At load each pattern is compiled with
  CPython `re` and its `examples` are run; a rule that fails them in this
  engine — or will not compile here — is **disabled and logged by id**,
  never run wrong. Both tiers (`strong`, `heuristic`) are masked by default.
- **The map is per session, in memory, never on disk.** A value seen twice
  in one session gets the same token; the map holds 256 values, past which a
  new value is still masked, with the fixed non-restorable `${OGR_SECRET_X}`
  and a warning — over the bound, refusing to mask is the wrong side to fail
  on.
- **Restore is exact.** Whole-token match against this session's map,
  longest key first, with markdown-escape tolerance (`${OGR\_SECRET\_1}`
  restores) — never fuzzy, never prefix: a restorer that guesses is an
  exfiltration oracle. A `${OGR_…}` shape with no map entry (a resumed
  session, a hallucinated number, a token from the gateway path) **refuses
  the call** with a notice the model can act on, at `pre_tool_call` and again
  in `tool_execution`. Forwarding the literal would be worse: a shell expands
  it to nothing and the call fails downstream with nothing naming why.
- **The OGR client is an egress too.** Every event this plugin sends —
  `step/request`, `step/response`, the exec fragment (which runs *after*
  restore) — passes the same value→token map before it leaves. The runtime
  judges tokens; a secret it still finds is a **miss with a name** (its
  ruleset is stale, the plugin missed, or no rule covers the shape), which is
  the loop that improves the ruleset. Events carry
  `redaction: {ruleset, masked: [{token, rule}]}` — tokens minted in this
  step, never values.
- **No ruleset at all** (no cache, runtime unreachable): `OGR_FAIL_MODE`
  decides. `open` proceeds **unmasked and warns on every request** until a
  ruleset arrives, reporting `ruleset: ""`; `closed` refuses the model call
  (`llm_execution` returns no response, which Hermes routes through its own
  retry/fallback path).

**The interaction with Hermes's own redaction, honestly.** Hermes runs a
LOSSY mask *inside* its tools (`agent/redact.py`, via `terminal_tool.py` and
`file_tools.py`) before any plugin hook sees the output — a `ghp_…` read from
`.env` arrives as `«redacted:ghp_…»`, deliberately non-reusable. That is
correct for what Hermes protects (the disk: logs, session files) and it is
not this plugin's regression, but with `ogr-guard` ≥ 2.0 it is now the thing
that stops an agent from *using* a key it legitimately read: **the values
Hermes's own prefix table knows are destroyed before we can tokenise them;
everything else is tokenised by us** and remains usable through a tool call.
The upstream ask — expose the tool-boundary mask as a replaceable hook
(`register_redaction_patterns` is additive-only) — is filed as a follow-up.

**Limits, stated:**

- Streamed deltas show tokens; the final answer shows tokens unless
  `OGR_RESTORE_OUTPUT=true`. Nothing is restored into channel deliveries,
  logs or the session file, ever.
- A resumed session re-masks its raw history with a fresh map (consistent
  again), but tokens the MODEL emitted before the restart are unmapped: a
  tool call carrying one is refused with the notice above, and the user is
  asked for the value again. There is no map persistence by design.
- Local redaction needs Hermes's `register_middleware` (the request is not
  mutable from a hook). On an older Hermes the plugin logs that it cannot
  run and sends no `redaction` field.
- The provider request's TRANSPORT keys (`extra_headers`, `default_headers`,
  `api_key`, `extra_query`) are not masked: a credential the deployment
  itself put there must reach the provider intact.

## Vantage limitations (stated, not papered over)

- **A `step/request` block cannot prevent the model call.** Hermes gives no
  seam to skip it (the hook's return is discarded), so the block is enforced
  on the call's effects: the answer is withheld and the round's tool calls
  are denied. The provider round-trip itself still happens.
- **A blocked `step/response` denies ALL of the round's tool calls**, even
  when `findings[].path` names just one. Per-call selectivity needs
  call-index bookkeeping `pre_tool_call`'s arguments don't carry;
  conservative beats clever at a deny seam.
- **Spans on tool-call arguments degrade to a block** — `pre_tool_call` can
  block or pass, never rewrite — with a message telling the agent to strip
  the flagged value and retry.
- **Spans on the request cannot be applied** for the same reason; a
  request-side redaction requirement surfaces as the block above.
- **The exec fragment is a synthetic step** from the runtime's point of
  view: v0.8 has no cross-event correlation to declare, so the wrapper's
  event is not linked to the step whose tool call spawned it.
- **In-process, like every agent-direct integration**: an agent that stops
  calling its hooks stops being seen.

## Streaming

Not applicable at this vantage: `post_api_request` fires with the complete
assistant message — Hermes reassembles any provider stream before the hook
— so each step is already judged exactly once, whole, and there is no tail
for this plugin to hold.

## Deleted in the v0.8 rewrite (not ported)

The v0.6 plugin was built on the retired `openguardrails` SDK; everything
below was machinery for wire concepts v0.8 removed, and was deleted rather
than rewritten:

- **The SDK dependency** — enrollment, Ed25519 body signing, the batching
  reporter, `/v1/ingest` (evaluate records; the heartbeat's counters make an
  outage gap visible instead).
- **The local reference runtime + `policy.json`** — there is no client-side
  PDP; the runtime is the decision point, full stop.
- **`guard_id` chains and the thread-local guard-context** correlating
  `pre_tool_call` with the exec wrapper — no correlation field exists on the
  v0.8 wire.
- **Observation points / altitudes** (`conversation`/`invocation`/
  `execution`) — v0.8 has one observed plane: LLM messages, two kinds.
- **Provenance/taint tracking, `post_tool_call`, `transform_tool_result`** —
  tool results are judged inside the next `step/request`, where the wire
  puts them; there is no third content kind and no client-side taint model.
- **`require_approval` handling** — the decision no longer exists (two
  decisions: `allow` | `block`).
- **Declared coordinates** (`session_id`/`run_id`/`turn` stamping, the
  subagent lineage reporting, per-instance `OGR_INSTANCE` identity naming) —
  sessions, turns and step numbering are derived server-side, always;
  identity is the four-tuple.
- **The `srt`/OpenShell sandbox backends and policy compilation**
  (`OGR_SANDBOX`) — OS-level isolation is a fine idea, but it was driven by
  the local policy file, which is gone. The exec wrapper's evaluate remains.
- **The selftest module** — it drove the local PoC detectors; the offline
  test suite (a strict mock runtime) is the replacement.

## Tests

Fully offline — a stdlib mock runtime that asserts every event is exactly
the eight required schema fields plus the optional ones this integration
sends (`integration`, `session_hint`, `redaction` — whose `masked[]` must name
tokens, never values), no more, no fewer, and serves a three-rule inline
ruleset over `GET /v1/rules`:

```bash
python -m pytest integrations/agent/hermes
# the pure local-redaction cases are plain unittest too:
python -m unittest discover -s integrations/agent/hermes/tests -p "test_local_redaction.py"
```
