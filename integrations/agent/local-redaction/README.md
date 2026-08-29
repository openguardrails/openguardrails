# @openguardrails/local-redaction

The reference `mask()` / `restore()` for **OGR local secrets redaction**
(OGR 1.4, `specification/local-redaction.md`): the secret never leaves the
host. An agent integration masks every credential in the outbound provider
request with a `${OGR_SECRET_n}` placeholder, judges the model's tool calls
on the placeholder, and restores the real value into the tool's arguments —
on the host, after judgement, and nowhere else.

Zero runtime dependencies. Used by
[`@openguardrails/opencode-auto-mode`](../opencode/) and
[`openguardrails-instrumentation-openclaw`](../openclaw/); a direct API
caller uses it with `GET /v1/rules` and the contract below.

## The ruleset is served, not shipped

This package contains **no patterns**. The org's secret ruleset is fetched
from the runtime with the org key (`GET /v1/rules`), cached at
`~/.openguardrails/rules-<sha256(url)[:8]>.json` (mode 0600, atomic write),
sent back as `If-None-Match` on the next start, and refetched when the
heartbeat response's `rules.id` moves.

Every rule carries `examples`; `compileRuleset` runs them in **this** engine
and **disables** a rule whose examples fail — by id, with the reason logged —
rather than run it wrong. Dialects drift silently, and a pattern that
compiles to "matches nothing" looks exactly like one doing its job.

```ts
import { LocalRedactor, UNRESTORABLE_NOTICE } from "@openguardrails/local-redaction"

const redactor = new LocalRedactor({ source: () => ({ runtimeUrl, apiKey }) })
await redactor.start()                          // cache first, one fetch if there is none

// on the way OUT — the whole provider request, every string leaf
const { value: masked } = redactor.maskValue(sessionId, request)

// on every event sent to the runtime (D6): known values → tokens, no rules
const { value: event } = redactor.maskKnown(sessionId, guardEvent)
event.redaction = redactor.report(sessionId)    // { ruleset, masked: [{token, rule}] }

// on the way INTO a tool — after every judgement and approval gate
const r = redactor.restoreArgs(sessionId, args)
if (r.unresolved.length) throw new Error(UNRESTORABLE_NOTICE(r.unresolved[0]))
run(r.args)
```

## The HTTP interceptor — masking at the layer every harness shares

Harness plugin hooks differ and have holes: one host cannot rewrite the
outbound request at all, another's messages hook is experimental, none of
them sees the system prompt. What every harness shares is the process's
HTTP client, so that is where `installHttpInterceptor` masks — in-process,
from the plugin the user already installs, no proxy and no `base_url`
change.

```ts
import { installHttpInterceptor, interceptorStatus } from "@openguardrails/local-redaction"

const http = installHttpInterceptor({ redactor })   // wraps globalThis.fetch; composes undici's dispatcher when resolvable

// in the tool hook, before judging: a tool call is downstream of a model call
http.noteToolCall()          // false (and ONE warning) if no model traffic was ever intercepted
redactor.report(sessionId)   // undefined until something provably masks — send no `redaction` field
interceptorStatus()          // { fetch: "wrapped", undici: "installed" | "unavailable" | …, sawTraffic, requests, streams, sessions, … }
```

- **Request**: for every POST whose URL is a model API (`api.openai.com`,
  `api.anthropic.com`, `*.openai.azure.com`, `openrouter.ai`,
  `generativelanguage.googleapis.com`, plus `hosts`) or whose JSON body
  sniffs as one (`messages[]`, `input` + `model`, `instructions`), the body
  is masked whole with `maskValue` — system prompt, every message, tool
  results, tool definitions — and forwarded with the SAME headers: the
  harness's own `Authorization` passes through, nothing is added, and the
  interceptor never holds a provider key.
- **Response**: restored **inside tool-call arguments only** (D7) —
  `choices[].message.tool_calls[].function.arguments`, anthropic
  `content[].input`, responses `output[].arguments`; prose keeps its
  placeholders. A JSON reply is rebuilt with a correct `Content-Length`; an
  SSE reply is piped through a `TransformStream` that restores inside
  argument DELTAS (openai `tool_calls[].function.arguments` by index,
  anthropic `input_json_delta.partial_json` by block, responses
  `function_call_arguments.delta` by item) with one held tail per field, so
  a token straddling deltas still restores; everything else streams through
  byte-identical. A value restored into JSON text is JSON-escaped. An
  unrestorable token is left in place and recorded (`status().unrestorable`)
  for the tool hook to refuse with the notice.
- **The self-check** is the `integration` rule: never let "looks protected"
  and "is protected" look alike. `sawTraffic` is set by the first model call
  that actually passed through; `noteToolCall()` warns ONCE when a tool call
  arrives before that; `redactor.report()` answers `undefined` until the
  interceptor has seen traffic or the integration has set
  `redactor.fallbackActive` (its hook-based masking engaged).
- **The undici half is best-effort**: `undici` is resolved at runtime, never
  a dependency. Present, its global dispatcher — shared by Node's built-in
  `fetch` — is composed, so a `fetch` reference captured before install and
  an SDK's own undici client are covered; a request the `fetch` wrapper
  already handled is recognised by its body and passed through. Masked
  requests ask for `accept-encoding: identity` there,
  because that layer sees the reply before decompression. Absent, the
  status says `unavailable`.
- **The session key is a trade-off, stated**: a request carries no host
  session id, so the map is keyed by the session the harness STAMPED
  (`user` / `metadata.user_id`) when it did, else by a per-process default
  (`"process"`) under which every conversation in the process shares one
  map. Token numbers are allocated once per `LocalRedactor`, so a token
  names one value whichever map minted it, and `redactor.restoreArgs`
  consults the host session's map and the interceptor's together.

## What `mask` does, in order

1. **Normalise for matching only** — zero-width and control characters are
   stripped with an index map back to the original, so a token split by a
   ZWSP is still a token and the splice removes the splitter with the value.
   Line structure survives (`\n`, `\r`, `\t`).
2. **Known values first**, longest first — every occurrence of every value
   the session already holds becomes its token.
3. **Then the ruleset**, in served order. Overlaps: longest wins, ties to
   array order. Nothing is matched inside an existing `${OGR_…}` token.
4. **Splice**, highest offset first. Message count, roles, ids and array
   indexes are untouched — replace in place, never remove.

The session map is **in memory, per process, never on disk**, bounded at
256 values per session. Over the bound a new value is still masked, with the
fixed non-restorable `${OGR_SECRET_X}`, and a warning says so.

## What `restore` does — and refuses to do

Whole-token exact match, longest key first, tolerant of markdown escapes
(`${OGR\_SECRET\_1}` restores — the higress `Restorer`'s rule, ported).
**Never fuzzy, never prefix**: a restorer that guesses is an exfiltration
oracle. Any `${OGR_…}`-shaped token with no map entry is reported
`unresolved`, and the caller blocks the call with `UNRESTORABLE_NOTICE`
rather than forward a literal a shell would expand to nothing.

`createStreamRestorer(map)` is the streaming form — the higress
`Restorer.Feed` ported: `feed(state, text, isLast)` replaces every complete
key, holds back a partial key at the end of what has arrived (bounded by
the longest key, escapes included) until the next delta completes it, and
with `isLast` treats a partial token as text. Every streamed field needs
its own `state`.

## Conformance

`conformance/local-redaction.json` — a three-rule fixture (copied from the
AIRS catalog, one rule with `group`) plus mask, restore and stream cases — is
the corpus every implementation runs, in every engine. `npm test` runs it
here.

```bash
npm install && npm test
```

## License

Apache-2.0
