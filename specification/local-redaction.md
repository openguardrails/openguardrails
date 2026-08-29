# Local redaction

This document uses the keywords MUST, MUST NOT, SHOULD, MAY as defined in
RFC 2119. **Status: OGR 1.4, additive-optional.** A 1.0–1.3 producer or
runtime is unaffected by everything here: an integration that does not
implement it sends the events it always sent, and a runtime that does not
serve rules answers the endpoints it always answered.

## What it is

An integration standing INSIDE the agent's process — a harness plugin, a
developer's own loop — holds the one copy of a request that has not yet left
the machine. **Local redaction** is what that vantage can do and no other can:
mask every secret in the outbound provider request ON THE HOST, before it
leaves for the model provider, and put the value back into a tool's arguments
after the call has been judged — so the model, the runtime, and every channel
between them see `${OGR_SECRET_3}` where the credential was, and only the tool
that needs the bytes ever gets them.

```
harness loop
  outbound request ──▶ mask(ruleset, session map) ──▶ provider
                          │
                          ├──▶ step/request  { …, "redaction": {ruleset, masked[]} } ──▶ runtime
                          │
  model reply  ◀──────────┘         (tokens in the reply, tokens in the record)
  tool call    ──▶ judge (step/response) ──▶ approvals ──▶ restore(session map) ──▶ execute
```

It has three parts, and all three are this document:

1. a **mask** applied to the outbound request and to every event sent to the
   runtime — the same value→token map, in both directions;
2. a **restore** applied to a tool's arguments, and to nothing else by default;
3. a **rule feed** — [`GET /v1/rules`](runtime-api.md#get-v1rules) — from which
   the integration obtains the patterns it masks with, so that the open-source
   plugin ships none.

## What it is NOT

- **Not a decision.** Nothing here changes `decision`, takes part in
  [composition](composition.md), or is a second axis beside the verdict. A
  masked request is judged exactly as an unmasked one would be; a runtime that
  judges tokens judges *that a credential is flowing to a named host*, which is
  the question its tool-call judge asks, and needs the bytes for none of it.
- **Nothing on the gateway path.** At a gateway the secret has already left
  the agent's host. That path keeps the contract it has: the runtime answers
  with [`modifications.spans`](verdict.md#modifications), the enforcement point
  splices and restores. A gateway MUST NOT fetch `/v1/rules` and has no use for
  it — the runtime masks on its behalf.
- **`pii` is excluded.** A secret is OPAQUE: the model has no use for the bytes
  of a token, only for the fact that there is one and where it goes, so
  masking it is lossless for the model and can be done blind, before any
  judgement. A PII value has SEMANTICS — a name, a city — and masking it changes
  what the model can do. PII stays a runtime-side, judged redaction; this
  contract covers the `security.secret_leak.*` family and nothing else.

## Why the v0.4 local-redaction specification was deleted, and this is different

v0.3–v0.4 carried a specification of this name (`content_encoding`,
`redactions[]`, a normative `POST /analyze` redactor contract) and v0.7 removed
it whole. It specified a redactor SERVICE — a sidecar the adapter called before
emitting an event — and a wire field describing what that service had done,
which made the transported payload a form the runtime could not fully judge
and the redactor a second decision point with its own policy. This document
specifies a CLIENT BEHAVIOUR and a RULE FEED: the integration masks in-process
with rules the runtime itself served and still runs; the runtime judges the
masked body as an ordinary event; and the only new wire field is a per-step
success report that carries tokens, never values, and is an input to nothing.

## Placeholders

A masked value is replaced by a **placeholder** in the existing OGR shape,
`${OGR_<TYPE>_<n>}` — the shape `modifications.spans[].replacement` already
carries (`${OGR_EMAIL_1}`). For this contract the type is `SECRET` and every
secret category maps to it: **`${OGR_SECRET_n}`**, one type, one counter.

- The map from value to token is **session-scoped and value-stable**: a value
  seen twice in one session MUST get the same token, and a token MUST NOT be
  reused for a different value within a session. `n` MUST be unique across the
  model's whole context, so that two tokens in one request never name one
  value and one token never names two.
- The map lives in the integration's process, **in memory, never on disk**.
  Persisting it would write the secrets to the very storage the mask exists to
  keep them off. An integration MAY bound it (the reference bound is 256 values
  per session); what happens at the bound is in [failure modes](#failure-modes).
- ⚠️ **Two allocators share this namespace.** A runtime mints the same shape for
  its own redactions (`${OGR_EMAIL_n}` on every path, `${OGR_SECRET_n}` on the
  gateway path), and a collision restores the WRONG value at whichever end
  restores. A runtime that allocates placeholders into a body MUST first scan
  that body for `\$\{OGR_([A-Z_]+)_([0-9]+)\}` and seed each type's counter
  ABOVE the highest number present. No wire field carries this: the body is
  already in hand.

## Mask — on the way out

The mask is applied to the **complete outbound provider request**, at the
last point the integration can rewrite it before it is sent — every string
leaf: the system prompt, every message of every role, tool results, tool
definitions. Where a harness exposes no outbound-request hook, an integration
MAY instead mask every text at the point it ENTERS the history, so that the
request is masked by construction; it MUST then state which texts that
vantage does not cover.

1. **Normalise for matching only.** Zero-width and control characters MAY be
   stripped from a working copy so a token split by a zero-width space is
   still a token; the splice MUST remove them with the value, and offsets MUST
   be kept against the original.
2. **Known values first.** Every occurrence of every value already in the
   session map is replaced with its token, **longest value first** — a value
   that is a substring of another cannot then corrupt it.
3. **Then the ruleset.** Every enabled rule is run over the remaining text,
   **in the order served**. A match mints a token, enters the map, and is
   spliced. Overlapping matches resolve **longest-wins**, ties broken by rule
   order — order is content, and the ruleset id hashes it.
4. **Never inside an existing placeholder.** A rule MUST NOT match inside a
   `${OGR_…}` token already in the text (every served rule excludes `${`; an
   integration SHOULD additionally skip token ranges outright).
5. **Replace in place, never remove.** Message count, roles, tool ids and
   array indexes are untouched — the [media elision](guard-event.md#media-parts-ogr-11)
   rule, applied to text.

An integration records, per step, the tokens it minted **in this step** — new
values only; tokens already in the history are just text now. That list is the
[`redaction.masked[]`](#the-redaction-report) report.

### The OGR client is an egress too

⚠️⚠️ **Every event the integration sends to the runtime MUST pass through the
same map**, immediately before serialisation — step 2 above, known values to
tokens. Without this rule the feature protects the secret from the model
provider and hands it to the runtime, which on the agent path is off-host as
well. This is also what makes a later vantage safe: an integration reporting
what a tool DID (an exec fragment, a command as run — which runs after
restore) re-masks it from the same map before it leaves. A consequence the
runtime relies on: **the runtime judges tokens.** A `${OGR_SECRET_1}` inside a
`curl -H "Authorization: Bearer …"` still says a credential is being sent to
that host, which is the judgement the egress position exists to make.

## Restore — on the way into a tool

- **Where.** The last mutable point before dispatch, **after every judgement
  and approval gate** — after the runtime has judged the `step/response` that
  carries the call, and after any human approval the harness offers. The
  runtime sees the token, the approval prompt shows the token, the tool gets
  the value. Restoring BEFORE judgement would send the value to the runtime
  (the rule above); restoring EARLIER than the approval would show it to the
  person deciding.
- **What.** Every string leaf of the call's arguments. **Whole-token exact
  match only**, with one tolerance: the markdown-escaped spelling a model
  emits (`${OGR\_SECRET\_1}`) restores, and nothing else does. ⚠️ **Never
  fuzzy, never prefix.** A restorer that guesses — completing `${OGR_SECRET_`,
  accepting a near-miss, mapping by position — is an exfiltration oracle: a
  model, or whatever is steering it, can enumerate the map by emitting shapes
  and reading what comes back.
- **An unrestorable token MUST block the call.** A `${OGR_…}` shape in the
  arguments with no entry in this session's map — a resumed session, a
  hallucinated number, a token minted by the gateway path — MUST NOT be
  forwarded to the tool. A shell expands `${OGR_SECRET_7}` to the empty string
  and the call fails somewhere downstream with nothing naming why; forwarding
  the literal is worse than refusing. The refusal SHOULD carry a notice the
  model can act on:

  > `${OGR_SECRET_7}` could not be restored: it is not a placeholder this
  > session issued. Placeholders must be used exactly as they appear in your
  > context; if the value was shown in an earlier session, ask the user to
  > provide it again.

- **Never into** the final answer, streamed deltas, channel deliveries, logs,
  or the session file — by default. The user asked the agent to USE the
  secret, not to read it back, and a harness that delivers to Telegram, Slack
  or Discord has an egress on every one of those. An integration MAY offer a
  setting that restores into the final answer for a local-only deployment; it
  MUST default to off.

## The `redaction` report

On every `step/request` and `step/response` it sends, an integration doing
local redaction SHOULD carry the OPTIONAL [`redaction`](guard-event.md#redaction)
field:

```json
"redaction": {
  "ruleset": "rs_9f2c1e0a7b3d4c5e8f1a2b3c4d5e6f70",
  "masked": [
    { "token": "${OGR_SECRET_3}", "rule": "entity_api_key/gitlab" }
  ]
}
```

- `ruleset` — the id of the ruleset it ran, exactly as served. The empty
  string means local redaction is ON but no ruleset was ever obtained — the
  fail-open state, which a runtime SHOULD show as *protected by nothing*.
- `masked[]` — the tokens MINTED in this step, never values; at most 256
  entries. `rule` is the `check_id`, or `check_id/pattern_id` where the rule
  names its patterns — the coverage statistic per issuer, not per check.
- **Absent** ⇒ the integration does not do local redaction (an older build) or
  it is switched off. A runtime MUST draw no conclusion from an absent report
  and MUST NOT refuse the event.
- ⚠️ **A CLAIM, per the [`integration`](guard-event.md#integration) rule.**
  Self-declared, never an input to a decision. A runtime SHOULD verify that
  each reported token occurs in the body before counting it, and MUST count
  it nowhere else.

What the report buys is a DIAGNOSIS. Tokens in traffic are a success record:
a runtime MUST NOT raise a finding on a `${OGR_SECRET_n}` placeholder. A
secret the runtime still finds on a step that carries `redaction` is still a
finding — the value DID leave the host — and the report is what lets the
runtime say WHY: the integration's ruleset is stale (`ruleset` ≠ the runtime's
current id), the integration missed (same ruleset, a served rule fired at the
runtime), or no rule covers the shape (only the runtime's model check fired —
the candidate for a new rule). An event without the report gets ordinary
findings and no diagnosis.

The same id rides the [heartbeat](runtime-api.md#post-v1heartbeat) as
`ruleset`, so a runtime's per-instance record can say which ruleset each
reporting process is on.

## The rule feed

An integration obtains its ruleset from [`GET /v1/rules`](runtime-api.md#get-v1rules):
authenticated with the organization key, bounded by the same tenant, advisory
to the producer and authoritative at the runtime. The shape is
[`schema/ruleset.schema.json`](../schema/ruleset.schema.json):

```jsonc
{ "ruleset": {
    "id": "rs_9f2c1e0a7b3d4c5e8f1a2b3c4d5e6f70",   // "rs_" + 32 hex, a hash of the rules
    "generated_at": "2026-08-28T09:00:00.000Z",     // display only; not part of the id
    "family": "secrets",
    "dialect": "ogr-re-1",
    "rules": [
      { "id": "entity_api_key",                     // the check_id
        "category": "security.secret_leak.api_key",
        "severity": "critical",
        "tier": "strong",                           // strong | heuristic
        "flags": "",                                // ⊆ "ims"
        "patterns": [ { "id": "openai", "source": "…" },
                      { "id": "gitlab", "source": "…" } ],
        "group": 1,                                 // OPTIONAL: the capture group that IS the span
        "examples": { "match": ["…"], "nomatch": ["…"] } }
    ] } }
```

- **`id` hashes the rules, canonically ordered, and nothing else.** Two
  deployments composing the same set at different moments agree on the id;
  that is what lets an integration's reported id be compared to the runtime's.
  An integration MUST report the id it was SERVED and MUST NOT recompute it.
- **Order is content.** `rules[]` is applied in the order served (it is the
  overlap tie-break), and reordering changes the id.
- **`tier`.** `strong` is an issuer's format or a standard carrier — the shape
  IS the claim. `heuristic` is a shape ordinary text produces by accident
  (`password = …`); a runtime gates it because a false positive there is a
  finding a person triages, while a REVERSIBLE mask over-masking costs only the
  model's view of one value and the tool still gets the real one. An
  integration SHOULD mask both tiers by default and MAY let a deployment turn
  the heuristic tier off.
- **`group`** — the 1-based capturing group that IS the span; absent ⇒ the
  whole match. This is how a rule says *the credential, not the header*
  WITHOUT a lookbehind, which the dialect could not otherwise express.
- **Caching.** An integration SHOULD cache the ruleset locally (the reference
  caches with owner-only permissions), MUST send `If-None-Match` with the
  cached id on refresh, and MUST treat `304` as *unchanged*. The heartbeat
  response carries `rules: {"id": …}`; an integration that beats learns of a
  change within one interval without polling the feed, and SHOULD refresh
  when the advertised id differs from the one it holds.
- ⚠️ **A fetch that failed means UNKNOWN**, never *no rules*. An integration
  falls back to its cache, and with no cache to its configured
  [fail mode](degraded-mode.md).

## Dialect `ogr-re-1`

Rules are written once and run in several regex engines — the reference
runtime and its TypeScript integrations under V8, a Python integration under
CPython `re`. Dialects drift silently: one engine rejects at compile time what
another accepts, and an integration that turns an uncompilable pattern into
one that matches nothing has a rule that silently finds nothing. `ogr-re-1`
is the INTERSECTION, and a served rule MUST stay inside it:

| Construct | Rule |
|---|---|
| lookbehind | fixed-width only; a variable-width lookbehind is a compile error in one engine |
| capturing groups | numbered only — one engine spells a named group `(?<v>…)`, the other `(?P<v>…)` |
| possessive quantifiers, atomic groups | none |
| inline flag groups (`(?i:…)`) | none; flags are the rule's `flags` field, a subset of `i` `m` `s` |
| `\p{…}` | none |
| `\b`, `\d`, `\w` | none — ASCII in one engine and Unicode in the other, so the same rule matches different text; spell the class out (`[0-9]`, `(?<![A-Za-z0-9_])`) |
| character classes | ASCII |

### Self-verification

⚠️⚠️ **Every rule carries `examples`, and an integration MUST run them at
load.** `match` strings MUST each produce a match and `nomatch` strings MUST
each produce none, in the integration's OWN engine. A rule that fails its
examples, or will not compile, MUST be DISABLED by id and logged — never run
in the state the failure left it — and the rest of the ruleset MUST run. The
integration still reports the served `ruleset` id: a miss the runtime then
finds is attributed to the rule that was off, which is a fact worth having.
The examples are part of the id: a rule whose corpus changed is a different
rule to an integration that verifies against it.

## Together with a gateway

An agent-side integration and a gateway enforcement point (the higress plugin, or
any PEP implementing [runtime-api.md](runtime-api.md) § the recipe) MAY both be
deployed on one path. The integration sends its events exactly as if it were alone.
The runtime recognises the gateway's copy of the same step by CONTENT and does not
judge it twice; what it records is one step carrying both halves — the
integration's `redaction` and whatever the gateway found. The runtime masks and
restores at the gateway ONLY what it found unmasked: a placeholder raises no
finding, so a body full of `${OGR_SECRET_n}` produces no `modifications.spans`,
and the runtime numbers its own placeholders above any already in the body (see
*Placeholders*). Nothing travels between the integration and the gateway for
this, by design — anything client-written would be assertable.

## Failure modes

| Situation | Behaviour |
|---|---|
| start with a cached ruleset | mask with the cache immediately; refresh in the background |
| start with no cache, runtime unreachable | the integration's configured fail mode: `open` proceeds unmasked, SHOULD warn on every request until a ruleset arrives, reports `ruleset: ""`; `closed` refuses model calls |
| `GET /v1/rules` fails on refresh | keep the cached ruleset; the fetch means UNKNOWN, not *no rules* |
| a rule fails its `examples` in this engine | disable that rule by id, log it, run the rest; report normally |
| a rule will not compile | the same |
| the session map is full | keep masking KNOWN values; a NEW value is still masked, with a fixed non-restorable placeholder `${OGR_SECRET_X}` and a warning — over the bound, refusing to mask is the wrong side to fail on |
| a token in tool arguments has no map entry | block the call with the notice above; never forward the literal |
| local redaction is off | send no `redaction` field; everything else as before |

## Conformance

An **integration** claiming local redaction MUST: mask every string leaf of the
outbound request and of every event it sends through one session-scoped,
value-stable, in-memory map; apply rules in the order served, longest-wins,
never inside a placeholder, replacing in place; restore whole tokens only, into
tool arguments only, after every judgement and approval; block a call carrying
an unrestorable token; run every rule's examples at load and disable by id what
fails; report `redaction` with the served id; and fall back cache → fail mode
when the feed is unavailable.

A **runtime** serving the feed MUST: serve one ruleset per organization whose
id hashes its ordered rules; answer `If-None-Match` with `304`; stay inside the
dialect; carry examples on every rule; run the identical ruleset on the events
it receives; raise nothing on a placeholder; treat the report as a claim; and
seed its own placeholder allocator above any number a body already carries.
