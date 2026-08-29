# openguardrails-instrumentation-openclaw

Guard an [OpenClaw](https://github.com/openclaw/openclaw) assistant through an
[OpenGuardrails](https://openguardrails.com) runtime, on **OGR v1.0**. It is
the multi-channel counterpart of
[`@openguardrails/opencode-auto-mode`](../opencode/).

**No OpenClaw core changes, and no SDK.** This is a pure plugin on OpenClaw's
in-process hooks that speaks the Runtime API directly
(`specification/runtime-api.md`): one hand-rolled `POST /v1/evaluate` per
held action plus an optional heartbeat. It is *restrict-only*: it can stop a
would-run tool call or a would-send message, never loosen one.

## The vantage, honestly

The v1.0 recipe pairs two events per **model call**: `step/request` holding
the raw provider request, `step/response` holding the raw response.
OpenClaw's plugin hooks expose **tool calls and channel messages, not the
model byte path** — this plugin never holds a provider body, so it cannot
implement that pairing. What it does hold, at the host's two refusable
moments, is model-produced output about to be acted on; each becomes a
single **canonical `step/response`** (`llm_protocol: "canonical"`) carrying
exactly what is in hand, with a fresh `step_id` per event and no request
half. Consequences, stated plainly:

- the model's prompt-side and reasoning are never judged — only its tool
  calls (one per event, as the host surfaces them) and its outbound channel
  messages;
- the runtime derives session/turn/step from much less context than a
  loop-owning integration (like [`@openguardrails/dsh`](../dsh/)) provides;
- no `timing` is sent — this vantage observes no byte path, and fabricating
  wall-clock facts would be worse than omitting them;
- redaction spans on a verdict cannot be applied yet (same stance as the dsh
  reference): the plugin warns once and the content proceeds unredacted —
  the runtime's own record is masked either way.

**Local secrets redaction** (OGR 1.4, `specification/local-redaction.md`)
cannot ride OpenClaw's hooks for the masking itself: there is no hook that
rewrites the outbound provider request (`llm_input` is `=> void`,
observer-only — `src/plugins/hook-types.ts`) and none that sees the system
prompt (`before_prompt_build`'s `systemPrompt` result is an override, not a
rewrite). So the plugin masks at the one layer every harness shares —
**this process's HTTP client**, in-process, from the plugin you already
installed. No proxy, no `base_url` change. When the runtime is configured,
`@openguardrails/local-redaction` wraps `globalThis.fetch` (and, when
`undici` is resolvable from the host, composes undici's global dispatcher
too — Node's built-in `fetch` and the npm `undici` share it — so an SDK
dispatching through its own undici client, or a `fetch` reference captured
before this plugin loaded, is still covered). What it covers: **everything
in the request body** — the system prompt, every message, tool results,
tool definitions — for `openai.chat`, `anthropic.messages` and
`openai.responses` bodies, matched by hostname or by the body's own shape.
The reply is restored **inside tool-call arguments only** — streamed or not —
never in prose, never in a channel delivery. The harness's own provider
credential passes through untouched and nothing is added to the request.
With a gateway enforcement point on the same path the plugin still sends its
events exactly as if alone; the runtime recognises the gateway's copy of the
same step by content and does not judge it twice.

The **ingress hooks are the fallback**: `tool_result_persist` and
`before_message_write` tokenise text as it enters the session history until
the interceptor has seen a model call go through, then step aside (nothing
is masked twice); restore in `before_tool_call`, below the guard, stays
either way. **Two ways the interceptor can silently miss**, and how you
would know: a `fetch` reference captured before the plugin loaded (undici's
dispatcher usually still catches it; a host bundling its own HTTP client
will not), or a non-`fetch` HTTP client. The plugin checks: a tool call is
downstream of a model call, so if `before_tool_call` fires before any
traffic was intercepted it warns ONCE — "model traffic is not passing
through the HTTP interceptor" — and, unless the ingress hooks are masking,
sends **no `redaction` field**, so the runtime never reads the step as
protected. On the fallback path the system prompt and text injected by
other plugins are **not covered**, and the warning says so.
`interceptorStatus()` from `@openguardrails/local-redaction` says the rest:
whether `fetch` is wrapped, whether undici was installed / unavailable,
`sawTraffic`, request and stream counts, and which session keys are in use.

The session key is a stated trade-off: a request carries no OpenClaw
`sessionKey`, so the interceptor keys its map by the session the host
*stamped* on the request (`metadata.user_id` / `user`) when it did, else by
one per-process default — under which every conversation this gateway
process holds shares one map: a value is masked identically everywhere, and
a token minted in one conversation restores into a tool call of another.
Token numbers are allocated once per process, so a token names one value
whichever map minted it, and the restore hook consults both. Restore into a
channel reply is not done: OpenClaw delivers to Telegram, Slack, Discord —
each an egress — and the specification's default (`restore_output: false`)
is off.

## Local secrets redaction

| moment | where | what happens |
| --- | --- | --- |
| a model request leaving the process | the HTTP interceptor (`fetch`, + undici's dispatcher when resolvable) — **the primary path** | the whole body masked, system prompt included; nothing added; the provider credential untouched |
| a model reply arriving | the same interceptor | placeholders restored **inside tool-call arguments only**, streamed or not; prose keeps them; an unrestorable token is left in place for the tool hook to refuse |
| a tool result being persisted | `tool_result_persist` (sync) — **fallback** | every string leaf of the message masked until the interceptor has seen traffic; returned as `{ message }` |
| any message being written | `before_message_write` (sync) — **fallback** | same — the user's words, the assistant's, all roles |
| a tool about to run | `before_tool_call` at priority **50** (the guard) then **10** (the restorer) | the self-check (traffic seen?), judged with placeholders, then `params` restored against the host session's map and the interceptor's; an unrestorable token → `{ block }` with the notice |
| every event to the runtime | `wire.ts` | known values → tokens first (the OGR client is an egress too); the event carries `redaction: { ruleset, masked }` only while something provably masks |

The plugin ships **no patterns**: the org's ruleset is fetched from the
runtime with the API key (`GET /v1/rules`), cached at
`~/.openguardrails/rules-<hash>.json` (mode 0600), verified against each
rule's own examples in this engine (a rule that fails is disabled by id and
logged), and refetched when the heartbeat's reply names a new id. `register`
is synchronous and so are the two ingress hooks, so nothing awaits the first
fetch: with a cache the plugin masks from the first message; without one,
the first texts of a fresh install enter history unmasked and are warned
about — once per text and once per model call — until the ruleset lands,
reporting `ruleset: ""` meanwhile. `failMode: "closed"` cannot refuse a
model call on this host (there is no hook that could); it keeps its meaning
for the two actions it can refuse.

The map is in memory, per process, never on disk (256 values per session;
over that a new value is still masked, with the fixed non-restorable
`${OGR_SECRET_X}`).

## What it enforces

| Hook | `allow` | `block` | no verdict (outage, timeout, 429) |
| --- | --- | --- | --- |
| **`before_tool_call`** | proceed | `{ block }` — the tool never runs | `failMode`: `open` proceeds loudly, `closed` blocks |
| **`message_sending`** (outbound) | deliver | `{ cancel }` — the reply never leaves | `open` delivers loudly, `closed` cancels |

Fail-open is the default (`specification/degraded-mode.md`): guardrails earn
the right to stop production traffic through explicit configuration, never
as a side effect of a network blip. A deployment gating dangerous actions
sets `failMode: "closed"` and accepts that an outage pauses the assistant.

## Install

```bash
openclaw plugins install openguardrails-instrumentation-openclaw
```

## Configure

In your OpenClaw config under `plugins.entries.openguardrails.config`; every
field falls back to the environment (`OGR_RUNTIME_URL`, `OGR_API_KEY`,
`OGR_AGENT_ID`, `OGR_AGENT_WORKSPACE`, `OGR_AGENT_USER`),
then to `""` — the explicit "no assertion", which the runtime resolves from
the API key. Only the API key is required; without one the plugin runs
unguarded and says so once.

```json
{
  "plugins": {
    "entries": {
      "openguardrails": {
        "config": {
          "runtime": {
            "url": "https://openguardrails.com",
            "apiKey": "ogr_...",
            "agentId": "invoice-bot",
            "agentType": "openclaw",
            "workspace": "finance-agents",
            "owner": "payments-team",
            "user": "u-8232"
          },
          "failMode": "open",
          "timeoutMs": 5000,
          "guardMessages": true,
          "localRedaction": { "enabled": true, "http": true, "report": "auto", "tiers": ["strong", "heuristic"] }
        }
      }
    }
  }
}
```

An unasserted `agentId` falls back to the agent id the host supplies on each
hook (a fact, not an invention), then to `""`. `localRedaction` falls back
to `OGR_LOCAL_REDACTION` (`0|false|off` turns it off),
`OGR_LOCAL_REDACTION_HTTP` (`0` keeps only the ingress hooks),
`OGR_RULES_CACHE` and `OGR_LOCAL_REDACTION_TIERS`. While a runtime is connected, a heartbeat
(`integration: "ogr-openclaw/<version>"`, plus `events_sent`/`evaluate_errors`
counters and the `ruleset` id this process is on) goes out immediately and
every 60 s — how the runtime tells "assistant idle" from "integration went
dark", and where the build id lives in v0.8. Its reply carries
`rules: { id }`; an id that moved triggers a refetch.

## Test

Offline, against a strict in-process mock runtime that rejects anything but
the exact v1.0 GuardEvent field set:

```bash
npm install && npm test     # from the repo root (workspace) — no network in the tests
```

The tests replay the host's `before_tool_call` priority merge (higher
first, stop at the first block) and drive the ingress hooks against the
conformance corpus in [`@openguardrails/local-redaction`](../local-redaction/).

## Status

`v0.4` — local secrets redaction (OGR 1.4): masking at the HTTP client
(the in-process `fetch` / undici interceptor — system prompt included,
restore inside tool-call arguments streamed or not), the ingress hooks `tool_result_persist` /
`before_message_write` as the fallback, restore in `before_tool_call` below
the guard, the `redaction` report on every event and the ruleset id on the
heartbeat. Depends on `@openguardrails/local-redaction`.

`v0.3` — the v0.8 rewrite. The v0.2 local policy engine
(`@openguardrails/core`, regex rules, bring-your-own-model judge, the taint
tracker, `require_approval`, the enrolled Ed25519 reporter and
`<workspace>/openguardrails.json`) is gone with the SDK layer; policy now
lives in the runtime, where you configure it once for every integration.
The plugin no longer imports the `openclaw` package — it exports the same
plain `{id, name, description, register}` entry `definePluginEntry` used to
brand, so it builds and tests standalone.

## License

Apache-2.0
