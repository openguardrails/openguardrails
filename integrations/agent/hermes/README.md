# openguardrails-instrumentation-hermes

Guard a [Hermes](https://github.com/NousResearch/hermes-agent) agent through
the [OpenGuardrails (OGR)](https://github.com/openguardrails/openguardrails)
**v0.8 Runtime API** — the agent-direct recipe
(`specification/runtime-api.md`): two `POST /v1/evaluate` calls per model
call, verdicts enforced before the answer is shown and before any tool call
or exec runs. Zero dependencies; the whole wire is hand-rolled over stdlib
`urllib` in [`src/.../wire.py`](src/openguardrails_instrumentation_hermes/wire.py).

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
| `OGR_REDACT_MASK` | keep placeholders | Replace redaction spans with this flat string (e.g. `[已隐去]`) instead of the verdict's `${OGR_PHONE_1}`-style placeholders. |

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
| `pre_tool_call` | ENFORCE on tool calls: a blocked `step/response` means the round's tool calls do not run. |
| `BaseEnvironment.execute` (wrapped) | The exec fragment — see below. |

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
the nine schema fields, no more, no fewer:

```bash
python -m pytest integrations/agent/hermes
```
