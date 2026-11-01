# Proposal: a value-shaped, minter-namespaced secrets placeholder — `OGRK<minter><nnnnnnn>`

> **Status: DRAFT — non-normative.** Proposes changing the placeholder shape that
> [local redaction](../specification/local-redaction.md) (OGR 1.4) mints for the
> `security.secret_leak.*` family from `${OGR_SECRET_n}` to **`OGRK` + a minter letter + seven zero-padded digits** (`OGRKF0000001`),
> and adding `redaction.unresolved[]` to the [`redaction`](../specification/guard-event.md#redaction)
> report. PII placeholders (`${OGR_EMAIL_n}`, …) are NOT in scope. Measured on
> 2026-09-14 by the OpenAFW project; scripts and raw results in
> `openafw/scripts/ph_*.py` and `openafw/docs/placeholder-experiment.md`.
>
> **Discussion:** to be opened.

## 1. The problem

The placeholder is shown to a model in place of a credential, and the model has
to carry it — unchanged — into a tool call where the host restores the value.
The shape `${OGR_SECRET_n}` was chosen for legibility to the tool-call judge and
for its delimiters. In practice models READ it: as a shell parameter expansion,
a template variable, or an unfilled placeholder — and act on that reading. A
model that "helpfully" writes `os.environ.get("OGR_SECRET_1")` or guards with
`if [[ -z "${OGR_SECRET_1:-}" ]]` has produced a call the restorer cannot answer
(no whole-token match) and the shell then expands to nothing. No system-prompt
instruction is an acceptable fix: an integration must not require the user to
explain the protocol to their model.

## 2. Measurement

Three rounds; the tables below are the first two, and §5 summarises the
third (off-host sends against real issuer hosts with a real-key baseline, and
on-host tasks with the credential in a file). Raw data: `openafw/docs/experiment-data/`.

8 candidate shapes × 4 realistic tasks (a bearer header in curl, appending
`KEY=value` to `.env`, a token in a clone URL, a Python script with the header)
× 1–3 samples, single turn, with a `run_shell` tool. Five model setups: DeepSeek
flash, DeepSeek v4-pro, Qwen3.8-27B (vLLM), Claude Code 2.1 with Sonnet (the
real harness), Codex CLI 0.153 (the real harness). Scored on the FIRST turn's
tool-call arguments.

Pooled, n = 44 per shape:

| shape | example | verbatim | used as env var | other rewrite | pre-check only | refused | verbatim % |
|---|---|---|---|---|---|---|---|
| `${OGR_…}` (current) | `${OGR_SECRET_1}` | 19 | 22 | 0 | 1 | 1 | 43 % |
| angle | `<OGR_SECRET_1>` | 20 | 12 | 9 | 1 | 0 | 45 % |
| double bracket | `[[OGR_SECRET_1]]` | 22 | 10 | 4 | 6 | 0 | 50 % |
| mustache | `{{OGR_SECRET_1}}` | 20 | 9 | 11 | 1 | 0 | 45 % |
| URI | `ogr://secret/1` | 29 | 0 | 9 | 2 | 0 | 66 % |
| fake key | `sk-ogr-1-Xk7Q…` | 39 | 0 | 0 | 3 | 2 | 89 % |
| credential id | `OGRK00000001` (letterless, round 1) | 39 | 0 | 0 | 4 | 1 | 89 % |
| **hyphen** | **`OGR-SECRET-1`** | **41** | **0** | **0** | 2 | 0 | **93 %** |

"Pre-check only" is a first turn spent on `ls .env` / `git --version`; it is a
limitation of the single-turn design, not a shape failure. The finding that
matters is the two zero columns: every shape whose core reads as an
IDENTIFIER (upper-case words joined by underscores, whatever surrounds it) is
rewritten into an environment-variable access on every model family; every
shape that reads as a VALUE is copied byte for byte.

Two shapes that copy well are still wrong: a fake key (`sk-…`) collides with
the issuer rules and is challenged by models that know issuer prefixes ("a
GitHub token is `ghp_`, not `sk-`"); a URI (`ogr://secret/1`) is treated as a
secret-manager reference and models go looking for an `ogr` binary.

A second run compared fixed and variable width of the hyphenated shape (a
candidate later superseded by `OGRK…` in the third round, but the width
finding carries over), ≥ 52 samples per shape on each API model and 12 per
shape on each harness:

| model | `OGR-SECRET-1` | `OGR-SECRET-000001` |
|---|---|---|
| deepseek-flash | 47 / 52 | 42 / 52 |
| deepseek-v4-pro | 50 / 52 | 52 / 52 |
| qwen3.8-27b | 48 / 52 | 47 / 52 |
| Claude Code (Sonnet) | 10 / 12 | 8 / 12 |
| Codex | 10 / 12 | 9 / 12 |

No sample on any model altered the digits of either shape (no leading zeros
dropped, no renumbering). Every miss is a pre-check or a refusal of the
scenario itself (`api.example.com` is a reserved domain; "a token does not
belong in a clone URL"), and those refusals land on both shapes alike.

## 3. The proposal

### 3.1 Placeholder shape (local-redaction.md, "Placeholders")

For the `security.secret_leak.*` family the placeholder is **`OGRK`, one
upper-case MINTER LETTER, then the registration number zero-padded to seven
digits**: `OGRKF0000001`. Matching regex `OGRK[A-Z][0-9]{7,}`; twelve
characters, and the width grows only past 9 999 999 per minter.

The letter names WHO minted the token — `F` the local firewall (OpenAFW),
`P` an in-process harness plugin, `R` the runtime — and it is not
decoration:

⚠️⚠️ **Two minters sharing one counter space fail as a WRONG VALUE, silently.**
A host's counter is per host and permanent; a runtime's is per agent and
expires; the "seed above the highest number in this body" floor only sees the
body in hand. A body carrying no host token therefore gives the runtime a
floor of zero, both mint number 1 for DIFFERENT values, and one model context
then holds one token naming two secrets — whichever side restores splices the
wrong credential into a tool call and nothing throws. With a letter each side
mints into its own space, a foreign token is plain text to every other reader,
and the worst case degrades to two names for one value, each independently
restorable. The floor and `occupiedPlaceholders` retire with it.

⚠️ A reader MUST match `OGRK[A-Z][0-9]{7,}` rather than enumerating letters, so
a new minter needs no code change: CI found five copies of the token regex in
the protocol repo alone and eight in the reference runtime.

A minter MUST restore only its own namespace, and MUST NOT report another
minter's token as unresolved — refusing a tool call over a token the next
restorer can answer is the failure this rule prevents.

- Letters and digits only: nothing a markdown renderer escapes (the
  underscore escape tolerance stays only for the legacy shape), not a valid
  identifier in any shell or language, not a template syntax, no legible
  word such as SECRET and no visible sequence — both of which the strictest
  harness (Claude Code) reads as a canary/honeytoken (§2, third round).
- **Fixed width makes it self-delimiting**, so a restorer stays what the
  specification already requires — whole-key exact match, longest first,
  nothing else — with no boundary rule and no stream-boundary hold. A
  variable-width shape scored the same but is a prefix of its own longer
  numbers, and the boundary rule that fixes it would have to be written
  identically in every restorer (Go, Python, TypeScript, Rust).
- Recognisable by regex, so a tool-call judge can be told the shape once (in
  the runtime's own prompt, never the user's) and reason about "a credential
  is going to host X" from the token alone.
- The number remains the value's registration number: sequential, never a hash
  of the value (a hash on the wire is an offline-guessable fingerprint).
- **Not an issuer-shaped fake key** (`sk-proj-ogr…`, `ghp_ogr…`): measured on
  Claude Code, a realistic-looking key triggers the harness's own rule against
  sending a credential pasted into chat off-host (1/9 sent, real key 0/9),
  gives nothing on on-host tasks (10/12 vs 11–12/12 for value-shaped
  placeholders), collides with the issuer rules, is challenged when a generic
  rule assigned the wrong issuer, and reads as a real leak to secret scanners.

PII placeholders keep `${OGR_<TYPE>_n}`: PII has semantics the model needs, and
the model is expected to read them.

### 3.2 Recognition of both shapes

Runtimes and integrations MUST recognise both shapes wherever they scan for
existing tokens (never match a rule inside one; seed counters above the
highest number present; the `placeholder` reject predicate) and MUST restore
whichever shape their map holds. Only the MINTED shape changes.

### 3.3 `redaction.unresolved[]` (guard-event.md, schema)

An OPTIONAL array beside `masked[]`: the placeholder-shaped tokens the
integration found in a tool call's arguments that no map entry answered, and
therefore blocked. Tokens only, at most 64. It makes the model's rewrite rate a
standing metric per integration and model instead of a lab number, and it is
a claim under the same rule as `masked[]`: never an input to a decision.

```json
"redaction": {
  "ruleset": "rs_9f2c1e0a7b3d4c5e8f1a2b3c4d5e6f70",
  "masked": [ { "token": "OGRKF0000003", "rule": "entity_api_key/gitlab" } ],
  "unresolved": [ "OGRKF0000007" ]
}
```

The `token` pattern in `guard-event.schema.json` becomes
`^(?:OGRK[0-9A-Z][0-9X]{7,}|\$\{OGR_[A-Z_]+_[0-9]+\})$` — the `$` outside the
alternation, so neither branch admits a trailing tail. Two details the
implementations found, both deliberate:

- ⚠️ **The run must admit `X`.** The overflow placeholder a full map mints
  (`OGRKFXXXXXXX`) is a FRESH grant, so it is reported in `masked[]` like any
  other; a pattern of `[0-9]` there turns a masking success into a rejected
  event at exactly the moment an integration is under pressure.
- **Position five stays `[0-9A-Z]`, admitting the letterless shape.** A schema
  is the tolerant end: one extra character class accepts a producer built
  during the window when the shape had no letter, and rejecting it buys
  nothing. Same reasoning as the optional-field rule.

## 4. Migration

- A body may carry both shapes during rollout (a runtime-masked history plus a
  host-minted new value). §3.2 makes that safe: they are distinct strings in
  one map.
- The conformance corpus keeps its `${OGR_SECRET_n}` cases (a restorer must
  still answer them) and gains namespaced cases for mask, restore and stream.
  It declares the minter it was produced under as a top-level `"minter"`, so a
  runner mints under that letter and compares tokens byte for byte instead of
  translating them; a case whose delta boundary falls INSIDE the prefix
  (`"cost: O"` + `"GRK0000"`) is re-split by hand, since only a whole run can
  be rewritten mechanically.
- `redaction.masked[].token` pattern widened as in §3.3; old integrations keep
  reporting the legacy shape and remain valid.

## 5. Consequences worth stating

- **Off-host sends are where harness policy, not shape, decides.** Claude
  Code refuses to curl a credential that was pasted into the conversation to
  any host — a REAL key 0/9, an issuer-shaped fake 1/9 — and it refuses
  Stripe keys under every shape ("even a real key should not go through
  curl"). Value-shaped placeholders are sent MORE often than real keys
  (`OGRK…` 21/27), never less. On on-host tasks where the credential comes from
  a file (config, `aws configure`, git remote, `.env`) every value-shaped
  placeholder behaves exactly like the real key (11–12/12 vs 12/12).
- **The token is opaque, so the judge must be told.** Nothing about
  `OGRK00000001` says "credential" to a model; a runtime's tool-call judge
  MUST carry the shape in its own prompt (never the user's), and a finding on
  a token MUST name it as a masked credential — so that a harness refusal
  and a runtime finding describe the same event.
- Models treat the token as a real credential in other ways too (one piped
  command output through `sed 's/OGR-SECRET-[A-Za-z0-9]*/***REDACTED***/g'`).
  That is the intended reading.

## 6. Recommendations on the two open points (converged between the OpenAFW
and AIRS sides, 2026-09-14; for the maintainer to ratify)

1. **Twelve characters: `OGRK` + letter + seven digits.** The letterless
   `OGRK00000001` was run through the first three rounds and the letter was
   re-measured in a fourth (§2): identical on DeepSeek (52/52 both) and Qwen
   (46 vs 45 of 52), and on Claude Code 16/16 vs 13/16, where all three misses
   are the scenario refusals every shape draws (a reserved documentation
   domain, a token in a clone URL) and none mentions the token's format. The
   counter is per minter per registry, so seven digits are never exhausted.
2. **The gateway path switches too.** The premise "no model writes a
   runtime-minted token back" does not hold: on the gateway path the
   runtime-minted token enters the model's context exactly as a host-minted
   one does, the model emits it into tool-call arguments, and the plugin
   restores from its per-request mapping. The same rewrite therefore has the
   same consequence there. One shape also keeps the two-allocator counter
   seed (`occupiedPlaceholders`) a single regex, and keeps the plugin/gateway
   duplicate-recognition path — which re-finds spans BY VALUE — from putting
   two spellings of one value into one body. PII stays `${OGR_<TYPE>_n}` on
   both paths.
