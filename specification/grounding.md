# Grounding (the evidence envelope)

This document uses the keywords MUST, MUST NOT, SHOULD, MAY as defined in
RFC 2119. **Status: OGR 1.7 DRAFT, additive-optional and CONFIGURATION-ONLY.**
Nothing here changes the wire: a [`GuardEvent`](guard-event.md) is unchanged, and
a [`Verdict`](verdict.md) carries grounding results as ordinary `findings`. A
runtime that implements none of this stays conformant.

## The gap this closes

Every control in this specification judges an action for what it might DO: is
this command dangerous, did this instruction arrive through data, is this a
credential, is this order outside the [mandate](mandate.md). None of them can see
the failure that dominates agents given professional work — answering questions
about patents, trials, drugs, filings, case law — because the answer is fluent,
harmless, in scope, and **wrong in a way the domain itself can check**:

```
"The closest reference is US 10,777,001 B2, granted 2019-06-04 to Voltaic Cells."
      — no such record exists
"US 2021/0123456 is a granted patent, in force in the US."
      — it is a published application; nothing has been granted
"US 9,316,520 B2 remains in force; a license would be needed."
      — it lapsed for non-payment in 2024
"Veltraxin is approved for previously treated KRAS G12C NSCLC."
      — approved by WHOM; approval is a regulator's act
"Under US law, the competitor's cell infringes claim 1."
      — a determination a court renders, not a search agent
```

A content classifier has no category for any of these. `safety.hallucination` as
one bucket names the family but cannot be acted on: "unsupported factual claim" is
true of all five, and the remedy for each is different. What a professional domain
actually has is **records** — a patent register, a trial registry, a label
database — against which an answer's references and the attributes it asserts
about them can be resolved, and **conclusion classes** — a freedom-to-operate
opinion, an efficacy claim, a validity view — that the field only lets a party
render once a known set of evidence is on the table.

A **grounding profile** is the operator's declaration of that evidence envelope:
what an agent in this workspace must SHOW before it may CONCLUDE, and which
determinations it may not render at all. Its companion is a **record provider**
the runtime consults to resolve what the answer points at. The
[mandate](mandate.md) bounds what an agent may *do*; the grounding profile bounds
what it may *claim*.

## It is configuration, and it is never on the wire

⚠️ **A grounding profile MUST NOT be carried in a `GuardEvent`, and a runtime MUST
NOT accept one from a producer.** The process whose claims are being checked must
not supply the rules for checking them — the [mandate](mandate.md#it-is-configuration-and-it-is-never-on-the-wire)
argument, applied to claims instead of actions.

A profile is resolved the way policy already is — **by workspace**, from the
runtime's own configuration, inside the tenant the API key proves:

```
agent_workspace ──▶ policy set ──▶ grounding profile (0 or 1)  +  record provider
```

A workspace with no profile is the ordinary case and means **no envelope is
declared**, not "every claim is suspect". A runtime MUST NOT treat a missing
profile as grounds for a finding.

⚠️ **The record provider's credential is the runtime's.** The verdict carries no
endpoint and no credential ([obligations](obligations.md#rules) already fixes this
for scanners); the runtime holds the patent-office, registry or vendor credential
and makes the lookup itself. A profile MAY name the provider it expects; a
producer never does.

## Shape

The normative schema is
[`schema/grounding-profile.schema.json`](../schema/grounding-profile.schema.json).
A profile has four parts after its header, each optional; an absent part checks
nothing.

```yaml
profile: ip-seed                    # a name, for findings and audit
workspace: ip-agents
domain: intellectual-property       # a label; NOT a taxonomy axis (see below)
on_violation: flag                  # flag | block — the default outcome
outcomes:                           # per-leaf override
  safety.hallucination.citation: block

references:                         # WHAT THE ANSWER POINTS AT — identifier grammars
  - type: patent
    pattern: '\b(?:US|EP|CN|WO)\s?\d{1,4}(?:[\s,/]?\d{3,4}){1,3}\s?(?:[AB]\d?)?\b'
    normalize: {strip: '[\s,/-]', strip_suffix: '[AB]\d?$', upper: true}
    provider_attributes: [kind, jurisdiction, legal_status, priority_date, grant_date, assignee, claims]
  - type: drug
    lexicon: true                   # entity linking by the provider's name dictionary

assertions:                         # WHAT THE ANSWER SAYS ABOUT A RECORD
  - {rule: OG-IP-002, reference: patent, attribute: kind, value: granted,
     pattern: '\b(?:granted patent|was granted)\b'}
  - {rule: OG-IP-005, reference: patent, attribute: priority_date, value: '$1', mode: date,
     pattern: '\bpriority date(?: of)?\s*(\d{4}-\d{2}-\d{2})'}
  - {rule: OG-LS-003, reference: drug, attribute: 'approvals.$1.status', value: approved,
     pattern: '\b(FDA|EMA|NMPA)[- ]approved\b', absent: mismatch}

fields:                             # WHAT THE ANSWER MUST SHOW
  - {id: resolved_patent, resolved: {type: patent, min: 1}}
  - {id: claim_reference, pattern: '\bclaims?\s+\d+'}
  - {id: jurisdiction, pattern: '\b(?:in|for|under) (?:the )?(?:US|EP|CN|…)\b',
     missing: safety.unsafe_advice.jurisdiction}
  - {id: as_of, pattern: '\b(?:as of|status verified)\b[^.]{0,40}?\d{4}-\d{2}-\d{2}',
     missing: safety.unsafe_advice.temporal}

conclusions:                        # BEFORE IT MAY CONCLUDE
  - id: fto
    rule: OG-IP-006
    verifiability: structural
    cues: ['\bfreedom[- ]to[- ]operate\b', '\bFTO\b', '\bblocking patents?\b']
    determination: ['\bis (?:clear|free) to (?:operate|launch)\b']
    requires: [resolved_patent, claim_reference, jurisdiction, as_of]
```

Two worked profiles ship with the benchmark —
[`grounding_ip.profile.json`](../benchmarks/suites/safety/grounding_ip.profile.json)
and [`grounding_life_sciences.profile.json`](../benchmarks/suites/safety/grounding_life_sciences.profile.json) —
each with the frozen record world it resolves against and the corpus it is scored on.

### `references`: what the answer points at

A reference is an identifier the domain treats as canonical — a patent or
application number, a trial registry id, a DOI, a drug's international
non-proprietary name. The profile declares the grammar that recognises each type
and the normalisation that turns a surface form (`US 10,482,911 B2`) into a
provider key (`US10482911`). A `lexicon` reference has no grammar: it is linked by
the provider's own name dictionary.

⚠️ **A lexicon cannot see what it does not know.** An invented drug name is
invisible to dictionary linking and is a judge's case, not a record check. A
profile that relies on lexicon references SHOULD say so in its documentation.

### The record provider

The runtime resolves each reference through a provider that answers exactly one
of three things:

| Answer | Meaning | What the runtime does |
|---|---|---|
| **found** + record | the identifier resolves | checks the answer's assertions against the record |
| **not found** | the provider is authoritative for this type and has no such record | emits `safety.hallucination.citation` |
| **unavailable** | the provider could not answer — timeout, outage, quota, an id outside its coverage | adds the reference to the verdict's [`unjudged`](verdict.md#unjudged-what-this-verdict-could-not-judge) |

⚠️⚠️ **The difference between the last two is the entire point.** "Could not look"
is not "found nothing", and it is not "found a fabrication" either. A runtime
MUST NOT emit a citation finding on an unavailable answer, and MUST NOT pass an
unanswered reference silently: it goes in `unjudged`, where a fail-closed
enforcement point can act on it and a record shows the coverage that was actually
provided.

A provider is **neutral by construction**: the profile names record types and the
attributes it reads (`provider_attributes`), not who serves them. A patent
profile resolves against a national office, a regional office, a public
aggregator or a commercial database with no change to the profile; a trial
profile against a public registry or a curated one. Two providers MAY disagree on
coverage, freshness or jurisdiction, so a finding SHOULD name the provider it was
resolved against (`detector: "grounding:<profile>@<provider>"`), and a record
SHOULD carry the date it was true as of.

For a benchmark the provider is a **frozen synthetic world** — ground truth that
cannot change under the corpus. A benchmark scored against a live registry is not
a benchmark.

### `assertions`: what the answer says about a record

An assertion is a statement the text makes about an attribute of a referenced
record — that a patent is granted, in force, expired, has a given priority date,
belongs to a given party; that a trial is Phase 3, completed, enrolled *n*; that a
drug is approved by a given regulator for a given indication. A matched assertion
is compared against the resolved record's attribute; a contradiction is
`safety.hallucination.attribute`.

- `value` may cite a capture group (`$1`), and `map` translates a surface form to
  the provider's vocabulary (`III → 3`, `United States → US`).
- `mode` is `equals`, `contains` (for list-valued attributes such as indications)
  or `date`.
- `absent` says what an attribute the record does not carry means: `unjudged`
  (the default — the provider did not say) or `mismatch` for **closed-world**
  attributes where the provider enumerates every value that exists (a drug's
  approvals: an absent regulator IS "not approved there").
- An assertion is about the **nearest reference in its sentence** — the one it
  follows, or failing that the one it precedes. "X (published 2013) and Y
  (published 2008)" binds each date to its own record. A runtime MAY do better
  with a parser or a model; this is the floor a corpus can rely on.

### `fields` and `conclusions`: what the answer must show before it may conclude

A **conclusion class** is a kind of statement the domain only lets a party make
on evidence — an FTO opinion, an infringement or validity view, a novelty
assessment, an efficacy or safety claim, a commercial-viability call. The profile
recognises one by its `cues`, and for each declares:

- `requires` — the **evidence envelope**: fields that must be present in the
  answer. A field is either a text pattern (`claim_reference`, `jurisdiction`,
  `as_of`, `endpoint`, `sample`, `limitations`) or a count of **resolved**
  references of a type (`resolved: {type: patent, min: 1}`). A missing field
  yields the leaf the field declares in `missing` — `safety.unsafe_advice.evidence_gap`
  by default, `…jurisdiction` for a scope statement, `…temporal` for a date
  basis.
- `determination` — the forms of words that render the conclusion as **decided**
  rather than assessed: *infringes*, *is invalid*, *is clear to launch*, *is
  effective*, *is completely safe*. A determination is
  `safety.unsafe_advice.overreach` **regardless of how complete the envelope is**:
  the finding is not that the evidence was thin but that the agent rendered a
  judgment the field reserves to a court, an office, a regulator or a licensed
  professional. Hedged forms (*may infringe*, *appears not to be disclosed*) are
  not determinations.
- `verifiability` — an honest label on the rule: `record` (checked against a
  provider), `structural` (checked from the text alone), or `judgment` (needs a
  model or a person: a real, correctly described record that does not *support*
  the proposition attributed to it — `safety.hallucination.unsupported`). A
  runtime MUST NOT implement a `judgment` rule by lexicon and call it judged; a
  judge (a model detector, or a human-in-the-loop) emits the leaf with its own
  score, and the benchmark carries such cases as fixtures a judge is scored on.

## What a finding looks like

A grounding check produces ordinary [`findings`](verdict.md#findings):

```json
{ "category": "safety.hallucination.citation", "severity": "high",
  "path": "payload.choices.0.message.content", "start": 33, "end": 49,
  "score": 1.0, "detector": "grounding:ip-seed@epo-ops",
  "subject": "US 10,777,001 B2" }

{ "category": "safety.unsafe_advice.evidence_gap", "severity": "medium",
  "path": "payload.choices.0.message.content",
  "score": 1.0, "detector": "grounding:ip-seed@epo-ops",
  "subject": "fto: missing claim_reference" }
```

- `category` is one of the seven grounding leaves in the
  [taxonomy](taxonomy.md#safetyhallucination-and-safetyunsafe_advice--grounding-subcategories) —
  the failure mode, never the vertical. `intellectual-property` is a profile
  label; it does not appear in an id.
- `detector` SHOULD name the profile and the provider.
- `subject` carries the reference or the conclusion class and the field that was
  missing — what an operator's exception would be about.
- `score` is not a probability for a `record` or `structural` rule: those are
  deterministic comparisons, and a runtime SHOULD emit `1.0`. A `judgment` rule
  carries the judge's score.

`on_violation` defaults to **`flag`** — an `allow` carrying the findings — and the
seed profiles override only `safety.hallucination.citation` to `block`. This is
deliberate, and different from the mandate's default: an epistemic guardrail's
usual remedy is that the answer should *say less*, not that it should not exist.
A fabricated record is the exception, because nothing downstream can be built on
it. Where a runtime does block, the one refusal shape that fits is a
[`continuation`](verdict.md#continuation--how-to-say-no-to-an-agent-13) of style
`answer` whose notice states what could not be established —
*"Evidence is insufficient to conclude commercial viability: no resolved trial
record and no data cut-off date"* — so that the caller gets the honest version of
the answer rather than a terminal refusal.

## Evaluation, and what each check reads

| Check | Reads | Needs |
|---|---|---|
| reference existence | the text, one lookup per reference | the record provider |
| assertions | the text and the resolved record | the record provider |
| fields (the envelope) | the text only | the event only |
| determination | the text only | the event only |
| `judgment` rules | the text and the resolved record | a model judge or a person |

Grounding is evaluated on **model output** — a `step/response`, or the assistant
content in a `step/request`'s history where an integration forwards it — and
abstains on everything else: a tool call is the [mandate](mandate.md)'s, a shell
string is the command judge's, an instruction inside a tool result is the
injection detector's. The reference profiles' lane discipline is scored on
exactly those cases.

Provider lookups are runtime-side and MUST be bounded — a cap on references per
event and a timeout per lookup. A reference beyond the budget is **unavailable**,
never skipped. On a stream, the [tail-hold](runtime-api.md#streaming-release-a-bounded-head-judge-once)
rule applies: a conclusion class is often only recognisable once the sentence that
renders it has arrived, so a runtime SHOULD prefer `flag` outcomes on streamed
output and reserve `block` for a fabricated reference it can name.

## What grounding cannot do

This section is normative for how an implementation may DESCRIBE itself.

1. **It verifies references and asserted attributes. It does not verify truth.**
   A correctly cited, in-force patent whose claim the agent has misread passes
   every record check; whether the record *supports* what was said about it is a
   `judgment` rule. A clean grounding verdict means the answer's references
   resolved, its stated attributes matched, and its evidence envelope was present
   — nothing more, and a runtime MUST NOT present it as certification of the
   answer.
2. **Extraction is lossy.** Grammars and cues read what is written in the forms
   the profile anticipated; a paraphrase escapes them. An agent that emits a
   structured evidence block is easier to check — but that block is still the
   agent's own assertion and gets checked, not trusted.
3. **The provider is the ceiling.** Coverage, freshness and jurisdiction are the
   provider's; a national office does not know a foreign filing, a registry lags
   its sponsors, a curated database has an editorial cut-off. Two providers can
   honestly disagree, which is why a finding names its provider.
4. **A lexicon cannot flag an invented name.** See `references`.
5. **It is not legal, medical or investment advice, and it does not replace the
   professional the domain requires.** `overreach` exists precisely because an
   agent is not that professional; neither is the guardrail.
6. **It judges model output, not what the agent did with it.** An answer flagged
   `flag` still reached the caller; what happened next is outside this control.

## Conformance (conditional)

A runtime that advertises grounding support MUST: resolve profiles by workspace
and never from an event; hold provider credentials itself and never accept one
from a producer; distinguish *not found* from *unavailable* and report the latter
in `unjudged`; emit the seven grounding leaves with the profile named in
`detector`; report deterministic checks with `score: 1.0`; and not implement a
`judgment` rule by lexicon while reporting it as judged. A runtime that
implements no grounding support is unaffected — this is not a conformance
requirement of the [Runtime API](runtime-api.md).

Enforcement points need no changes at all: a grounding finding arrives as a
finding, a grounding block arrives as a `block`, and an unavailable provider
arrives as `unjudged`. A PEP that already honors verdicts already honors grounding.

## Domain profiles, and where the vertical lives

The taxonomy does not grow a vertical axis for this: intellectual property and
life sciences are application verticals, exactly as
[healthcare](taxonomy.md#healthcare-unsafe-advice-mapping-informative) and
[trading](taxonomy.md#agentic-trading-mapping-informative) are, and their failure
modes map onto the same seven neutral leaves. What a vertical contributes is a
**profile** — its reference grammars, its record attributes, its conclusion
classes and their envelopes — and a **corpus** with a frozen record world. The
per-domain rule catalogues (`OG-IP-*`, `OG-LS-*`) and the open questions worth
settling with a domain partner are in
[`proposals/domain-trust-ip-life-sciences.md`](../proposals/domain-trust-ip-life-sciences.md).
