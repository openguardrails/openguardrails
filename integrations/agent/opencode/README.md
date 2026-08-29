# @openguardrails/opencode-auto-mode

**Auto mode for [opencode](https://github.com/anomalyco/opencode), on OGR
v1.0.** Whatever your opencode `permission` config would ask you — bash
commands, edits, webfetch — this plugin answers from an
[OpenGuardrails](https://openguardrails.com) **runtime verdict** instead of a
human, and every tool call is judged before it runs. Enforced as a pure
opencode plugin — no core changes, no fork, and **no SDK**: the plugin speaks
the Runtime API directly (`specification/runtime-api.md`), one hand-rolled
`POST /v1/evaluate` per held action plus an optional heartbeat.

Installation is one config edit — opencode installs plugins listed in its
config by itself on the next start:

```jsonc
// opencode.json (or the global ~/.config/opencode/opencode.json)
{
  "plugin": ["@openguardrails/opencode-auto-mode"],
  // auto mode answers whatever you tell opencode to ask about:
  "permission": { "bash": "ask", "edit": "ask", "webfetch": "ask" }
}
```

Then connect a runtime: set `OGR_API_KEY` (get one at
https://openguardrails.com). Without a key the plugin runs unguarded and says
so once — connecting a runtime is a deployment choice, not a crash.

## The vantage, honestly

The v1.0 recipe pairs two events per **model call**: `step/request` holding
the raw provider request, `step/response` holding the raw response.
opencode's plugin surface exposes **tool-call hooks, not the model byte
path** — this plugin never holds a provider body, so it cannot implement
that pairing. What it does hold, at the host's two refusable moments, is a
model-produced tool call about to be acted on. Each one becomes a single
**canonical `step/response`** carrying exactly the `tool_calls` in hand
(`llm_protocol: "canonical"`), with a fresh `step_id` per event and no
request half. Consequences, stated plainly:

- the model's prose and reasoning are never judged, only its tool calls —
  and only one call per event, as the host surfaces them;
- the runtime derives session/turn/step from much less context than a
  loop-owning integration (like [`@openguardrails/dsh`](../dsh/)) provides;
- no `timing` is sent — this vantage observes no byte path, and fabricating
  wall-clock facts would be worse than omitting them;
- redaction spans on a verdict cannot be applied yet (same stance as the dsh
  reference): the plugin warns once and the content proceeds unredacted —
  the runtime's own record is masked either way.

**Local secrets redaction** (OGR 1.4, `specification/local-redaction.md`)
does NOT depend on those hooks for the masking itself. Harness hooks differ
and have holes — opencode's messages hook is *experimental*, and no hook
anywhere sees the system prompt — so the plugin masks at the one layer every
harness shares: **this process's HTTP client**, in-process, from the plugin
you already installed. No proxy, no `base_url` change. At plugin load
`@openguardrails/local-redaction` wraps `globalThis.fetch` (and, when
`undici` is resolvable from the host, composes undici's global dispatcher
too, so an SDK that dispatches through its own undici client — or a `fetch`
reference captured before this plugin loaded — is still covered; Node's
built-in `fetch` and the npm `undici` share that dispatcher). What it covers:
**everything in the request body** — the system prompt, every message of
every role, tool results, tool definitions — for `openai.chat`,
`anthropic.messages` and `openai.responses` bodies, matched by hostname
(`api.openai.com`, `api.anthropic.com`, `*.openai.azure.com`,
`openrouter.ai`, `generativelanguage.googleapis.com`) or by the body's own
shape. The reply is restored **inside tool-call arguments only** — streamed
(a placeholder split across deltas still restores) or not — never in prose.
The harness's own `Authorization` passes through untouched, nothing is added
to the request, and the interceptor holds no provider key. With a gateway
enforcement point on the same path the plugin still sends its events exactly
as if alone; the runtime recognises the gateway's copy of the same step by
content and does not judge it twice.

The **hooks are the fallback**. `experimental.chat.messages.transform` and
`tool.execute.after` mask until the interceptor has seen a model call go
through, then step aside (nothing is masked twice); restore in
`tool.execute.before` stays either way. **Two ways the interceptor can
silently miss**, and how you would know: a `fetch` reference the host
captured before the plugin loaded (undici's dispatcher usually still catches
it; a host that bundles its own HTTP client will not), or a non-`fetch` HTTP
client. The plugin checks: a tool call is downstream of a model call, so if
`tool.execute.before` fires before any traffic was intercepted it warns ONCE
— "model traffic is not passing through the HTTP interceptor" — and, unless
the messages hook is masking, sends **no `redaction` field**, so the runtime
never reads the step as protected. `interceptorStatus()` from
`@openguardrails/local-redaction` says the rest: whether `fetch` is wrapped,
whether undici was installed / unavailable, `sawTraffic`, request and stream
counts, and which session keys are in use.

The session key is a stated trade-off: a request carries no opencode
`sessionID`, so the interceptor keys its map by the session the harness
*stamped* (`user` / `metadata.user_id`) when it did, else by one per-process
default — under which every conversation in the process shares one map.
Token numbers are allocated once per process, so a token names one value
whichever map minted it, and the tool hook restores against both. Restore
into the *final displayed answer* is not done: the specification's default
(`restore_output: false`) is off — the user asked the agent to *use* the
secret, not to read it back.

## Local secrets redaction

**The secret never leaves the host.** Every credential in the messages sent
to the model is replaced with a `${OGR_SECRET_n}` placeholder; the model
works with the placeholder; when it puts one in a tool call, the value is
restored into the arguments on this machine — *after* the runtime has judged
the call on the placeholder — and the tool runs with the real thing.

| moment | where | what happens |
| --- | --- | --- |
| a model request leaving the process | the HTTP interceptor (`fetch`, + undici's dispatcher when resolvable) — **the primary path** | the whole body masked, system prompt included; nothing added; the harness's `Authorization` untouched |
| a model reply arriving | the same interceptor | placeholders restored **inside tool-call arguments only**, streamed or not; prose keeps them; an unrestorable token is left in place for the tool hook to refuse |
| messages going to the model | `experimental.chat.messages.transform` — **fallback** | every string leaf of every part masked, until the interceptor has seen traffic |
| a tool's output | `tool.execute.after` — **fallback** | `output.output` tokenised before it enters history, on the same condition |
| a tool about to run | `tool.execute.before` | the self-check (traffic seen?), judged with placeholders, **then** `args` restored against the host session's map and the interceptor's; an unrestorable token throws the notice — the agent is told to use placeholders exactly as shown or ask the user |
| every event to the runtime | `wire.ts` | known values → tokens first (the OGR client is an egress too); the event carries `redaction: { ruleset, masked }` — the ruleset id and the tokens minted in this step, never values — only while something provably masks |

The plugin ships **no patterns**: the org's ruleset is fetched from the
runtime with the API key (`GET /v1/rules`), cached at
`~/.openguardrails/rules-<hash>.json` (mode 0600), verified against each
rule's own examples in this engine (a rule that fails is disabled by id and
logged), and refetched when the heartbeat's reply names a new id. On a fresh
install the first fetch is awaited at plugin load (bounded by `timeoutMs`);
with a cache the plugin masks at once and refreshes in the background. With
no ruleset anywhere, `failMode: "open"` proceeds unmasked and warns on every
request, reporting `ruleset: ""`; `"closed"` refuses the model call.

The map is in memory, per process, never on disk (256 values per session;
over that a new value is still masked, with the fixed non-restorable
`${OGR_SECRET_X}`). A resumed session starts with a fresh map, so a
placeholder the model remembers from an earlier process cannot be restored
— the call is refused with the notice rather than run with an empty value.

## How it works

**`tool.execute.before`** — the held call is judged before it runs:

| Verdict | opencode behavior |
| --- | --- |
| `allow` | proceed (findings, if any, are recorded runtime-side) |
| `block` | throw → the agent sees a tool error and must find a safer path |
| no verdict (outage, timeout, 429) | `failMode`: `open` proceeds loudly, `closed` refuses |

**`permission.ask`** — opencode's own permission prompt, the human gate.
An ask correlated to an already-judged call (same `callID`) is answered from
that verdict — the same action never earns two answers. An uncorrelated ask
is judged from the permission's own metadata (opencode's bash asks carry the
command there). `allow` → `"allow"`, `block` → `"deny"`, nothing to judge →
*undecided*: `auto.unresolved: "human"` (default) leaves the prompt for you,
`"reject"` denies it — the strict stance for headless runs.

Auto mode stays **restrict-only** toward the agent: it automates *your* seat
at the prompt, never overrides a verdict, and a `block` stays blocked
everywhere.

## Configure

Plugin options (opencode passes them through), each falling back to the
environment, then to `""` — the explicit "no assertion", which the runtime
resolves from the API key:

```jsonc
{
  "runtime": {
    "url": "https://openguardrails.com",   // or your own runtime; env OGR_RUNTIME_URL
    "apiKey": "ogr_...",                   // env OGR_API_KEY
    "agentId": "invoice-bot",              // WHICH agent; env OGR_AGENT_ID
    "agentType": "opencode",               // what KIND (the default)
    "workspace": "finance-agents",         // policy group; env OGR_AGENT_WORKSPACE
    "user": "u-8232"                       // who is using it; env OGR_AGENT_USER
  },
  "failMode": "open",                      // "closed" = an outage pauses the agent
  "timeoutMs": 5000,
  "auto": { "enabled": true, "unresolved": "human" },
  "localRedaction": {                      // env OGR_LOCAL_REDACTION=0|false|off turns it off
    "enabled": true,
    "http": true,                          // the fetch/undici interceptor; env OGR_LOCAL_REDACTION_HTTP=0 keeps only the hooks
    "cachePath": "~/.openguardrails/rules-<hash>.json",   // env OGR_RULES_CACHE
    "tiers": ["strong", "heuristic"]       // env OGR_LOCAL_REDACTION_TIERS
  }
}
```

While a runtime is connected, a heartbeat
(`integration: "ogr-opencode-auto-mode/<version>"`, plus
`events_sent`/`evaluate_errors` counters and, once masking is live, the
`ruleset` id this process is on) goes out at boot and every 60 s —
that is how the runtime tells "agent idle" from "integration went dark", and
where the build id lives in v0.8. Its reply carries `rules: { id }`; an id
that moved triggers a refetch of the ruleset.

## Test

Offline, against a strict in-process mock runtime that rejects anything but
the exact v1.0 GuardEvent field set:

```bash
npm install && npm test     # from the repo root (workspace) — no network in the tests
```

The tests drive the messages hook, the tool hooks and the mock's
`GET /v1/rules` end to end against the conformance corpus in
[`@openguardrails/local-redaction`](../local-redaction/).

## Status

`v0.4` — local secrets redaction (OGR 1.4): masking at the HTTP client
(the in-process `fetch` / undici interceptor — system prompt included,
restore inside tool-call arguments streamed or not), the experimental
messages hook as the fallback,
restore into tool arguments after judgement, the `redaction` report on every
event and the ruleset id on the heartbeat. Depends on
`@openguardrails/local-redaction`.

`v0.3` — the v0.8 rewrite. The v0.2 local policy engine
(`@openguardrails/core`, regex rules, bring-your-own-model judge,
`.opencode/guardrails.json`, `require_approval`) is gone with the SDK layer;
policy now lives in the runtime, where you configure it once for every
integration. Published before `v0.2` as
`openguardrails-instrumentation-opencode`.

## License

Apache-2.0
