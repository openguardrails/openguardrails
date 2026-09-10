# Proposal: domain trust profiles for intellectual property and life sciences

> **Status: DRAFT — non-normative.** A discussion document, not part of the
> standard; it carries no RFC-2119 weight. Its purpose is to give a domain
> partner a concrete framework — two rule catalogues, two runnable profiles, two
> scored corpora — to react to. The neutral parts have been drafted into
> [`specification/grounding.md`](../specification/grounding.md),
> [`schema/grounding-profile.schema.json`](../schema/grounding-profile.schema.json)
> and the [taxonomy](../specification/taxonomy.md#safetyhallucination-and-safetyunsafe_advice--grounding-subcategories)
> as OGR 1.7 **draft**; if accepted they are ratified there and this file is retired.
>
> **Owner:** _(you)_ · **Discussion:** _(link the GitHub Discussion / Draft PR here)_

## 1. The claim, and what is wrong with the obvious version of it

The claim is that a guardrail protocol for professional agents is not mainly
about what an agent must not *say* — it is about **what an agent must be able to
show before it is entitled to conclude**. A patent-search agent asked "does our
design infringe?" is not in danger of being toxic; it is in danger of citing a
patent that does not exist, calling an application a grant, calling an expired
right a blocking one, and rendering "infringes" where only a court can. Every one
of those is checkable, and none of them is a content-safety category.

The obvious version of this — an `ip.*` taxonomy domain, `OG-IP-001 Patent
Existence` as a category id, a "Domain Trust Protocol" per vertical — is the
version OGR must **not** build, for three reasons the repo already settled:

1. **Verticals are not taxonomy axes.** The verdict schema admits only
   `safety.* | security.* | privacy.* | x.*`; healthcare and trading are
   informative *mappings* onto neutral ids. The same fabricated-reference failure
   is a patent in IP, a trial id in life sciences, a case citation in law and a
   ticker in finance. If each vertical gets its own leaf, the "cross-domain trust
   protocol" is a slogan; if they share seven neutral leaves, it is true.
2. **A guardrail that reads content alone cannot do this.** Existence, status,
   dates and jurisdiction live in a *register*, not in the answer. The new
   concept is therefore not a rule list but a **record provider** the runtime
   consults — and that is the piece that makes a data partner structurally
   important rather than decorative.
3. **Much of the value is in refusing to pretend.** A rule that cannot be
   machine-checked (does this claim *support* that proposition?) must be labelled
   as a judge's, not implemented by keyword and reported as judged.

So the shape is: seven neutral leaves in the taxonomy; a *grounding profile* as
runtime configuration (the mandate's sibling: the mandate bounds what an agent may
DO, the profile what it may CLAIM); a provider interface any register can serve;
and per-vertical profiles + corpora contributed by whoever knows the domain. The
pipeline the partner cares about — **spec → benchmark → runtime** — is exactly the
repo's existing shape (`specification/` → `benchmarks/` → the reference runtime),
so nothing new has to be invented to host it.

## 2. What already exists, so we don't re-litigate it

- **The framework** — [`specification/grounding.md`](../specification/grounding.md):
  references, the record provider (found / not found / **unavailable**), assertions,
  fields and conclusion classes, the `record | structural | judgment` verifiability
  label, `flag` as the default outcome, and what grounding cannot do.
- **The schema** — [`schema/grounding-profile.schema.json`](../schema/grounding-profile.schema.json).
- **The neutral leaves** — `safety.hallucination.{citation, attribute, unsupported}`,
  `safety.unsafe_advice.{overreach, evidence_gap, jurisdiction, temporal}`, plus the
  informative IP and life-sciences mapping tables in the taxonomy.
- **Two runnable profiles, two frozen worlds, two corpora** —
  `benchmarks/suites/safety/grounding_{ip,life_sciences}.{profile,records}.json` and
  `.jsonl`, scored by `benchmarks/harness/grounding.py` through `run.py`
  (precision / recall / F1, leaf accuracy, lane discipline, unjudged honesty, and
  the count of judge fixtures the structural reference does not score).

## 3. Why IP first, and why life sciences second

IP is the better first domain than medicine, and the reason is not commercial:
its ground truth is **structured, public and dated**. A patent number either
resolves or it does not; kind, legal status, priority/filing/publication/grant
dates, jurisdiction and assignee are register fields; the conclusion classes the
field allows (FTO, novelty, validity, infringement risk) have a well-understood
evidence envelope. Most rules are `record` or `structural`; only claim
construction is `judgment`.

Life sciences is second because its registers are almost as good (trial
registries, labels, curated pharmacology) but its **names are words**: a drug is
linked by dictionary, so an invented drug name is invisible to a record check and
belongs to a judge. It also borders the healthcare mapping — clinical *advice* to
a person stays there; this profile is about *evidence* claims.

R&D intelligence (technology maturity, "commercially viable", roadmap calls) is
deliberately the **weakest** of the three and should not lead: it has no record
type. What a profile can do for it is the envelope — a viability call with no
resolved trial, no endpoint, no limitation and no as-of date is `evidence_gap` /
`temporal` — and that is what the life-sciences profile's `viability` class
demonstrates. "Is this technology mature?" is a judge's question until someone
publishes a register of readiness levels.

## 4. Rule catalogue — intellectual property (`OG-IP-*`)

The column that matters is **verifiability**: `record` needs the provider,
`structural` reads the text alone, `judgment` needs a model judge or a person.

| Rule | The rule | Maps to | Verifiability |
|---|---|---|---|
| OG-IP-001 | Every cited patent, application or publication number resolves with the provider | `hallucination.citation` | record |
| OG-IP-002 | An application is not called a grant, and a grant not an application | `hallucination.attribute` | record |
| OG-IP-003 | Legal status as stated (in force / expired / lapsed / abandoned / invalidated / pending) matches the register; an expired or invalidated right is never a "blocking patent" | `hallucination.attribute` | record |
| OG-IP-004 | The jurisdiction of a right as stated matches the register; an FTO, infringement or validity view names its jurisdiction scope | `hallucination.attribute` · `unsafe_advice.jurisdiction` | record · structural |
| OG-IP-005 | Priority, filing, publication, grant and expiry dates match and are not confused; a legal-status view carries an as-of date | `hallucination.attribute` · `unsafe_advice.temporal` | record · structural |
| OG-IP-006 | A freedom-to-operate view rests on at least one resolved record | `unsafe_advice.evidence_gap` | structural + record |
| OG-IP-007 | Infringement and non-infringement are stated as risk, never as decided; similarity is not infringement | `unsafe_advice.overreach` | structural (lexicon) · judgment (nuance) |
| OG-IP-008 | A scope conclusion names the claim(s); the description is not the scope; a claim is not read as saying what it does not | `unsafe_advice.evidence_gap` · `hallucination.unsupported` | structural · judgment |
| OG-IP-009 | The assignee / applicant as stated matches the register | `hallucination.attribute` | record |
| OG-IP-010 | A novelty view fixes the priority date it is judged against; cited art predates it | `unsafe_advice.temporal` | structural · judgment |
| OG-IP-011 | Validity and invalidity are never rendered as decided | `unsafe_advice.overreach` | structural |
| OG-IP-012 | Every key judgment traces to a resolved record (a conclusion with no reference at all) | `unsafe_advice.evidence_gap` | structural |

Candidate additions a partner would know better than we do: patent-family
consistency (a family member cited for a jurisdiction it was never validated in),
claim-amendment awareness (a granted claim cited in its as-filed form), SEP /
licensing-status assertions, and the distinction between an examiner's citation
and a court's finding.

## 5. Rule catalogue — life sciences (`OG-LS-*`)

| Rule | The rule | Maps to | Verifiability |
|---|---|---|---|
| OG-LS-001 | Every cited trial id, DOI or registry entry resolves | `hallucination.citation` | record |
| OG-LS-002 | Phase, status, enrollment, sponsor and "results posted" match the registry | `hallucination.attribute` | record |
| OG-LS-003 | "Approved" names a regulator, and that regulator's status and date match; a withdrawn approval is not an approval | `hallucination.attribute` · `unsafe_advice.jurisdiction` | record · structural |
| OG-LS-004 | An approved indication as stated is within the label | `hallucination.attribute` | record |
| OG-LS-005 | An efficacy or safety claim is stated as evidence, not decided, and carries a resolved trial, an endpoint and a sample size | `unsafe_advice.overreach` · `unsafe_advice.evidence_gap` | structural |
| OG-LS-006 | An evidence view carries a data cut-off or as-of date | `unsafe_advice.temporal` | structural |
| OG-LS-007 | A trial is cited only for what it measured, in the population it studied | `hallucination.unsupported` | judgment |
| OG-LS-008 | Target and mechanism as stated match the record | `hallucination.attribute` | record |
| OG-LS-009 | A conclusion acknowledges its limitations and any contrary evidence | `unsafe_advice.evidence_gap` | structural (presence) · judgment (adequacy) |
| OG-LS-010 | Commercial viability / market readiness is stated as assessment, dated, and on evidence | `unsafe_advice.overreach` · `unsafe_advice.temporal` | structural |
| — | Dosage, interaction and escalation advice to a person | healthcare mapping | — |

Candidate additions: sequence / biologic identity claims (a sequence id that does
not resolve, or resolves to a different molecule), exclusivity and patent-expiry
assertions on a drug (where the two profiles meet), adverse-event frequency
claims against a label, and guideline-recommendation claims against a dated
guideline version.

## 6. What each side contributes, and why the split protects both

| | The domain partner | OpenGuardrails |
|---|---|---|
| **Knows** | what the professional answer is | what an answer must show before it may be trusted |
| **Contributes** | record coverage and quality as a **provider**; expert-written corpus cases; the rule catalogue's next rows; conclusion classes we have not thought of | the neutral leaves; the profile contract and its schema; the reference evaluator; runtime enforcement; the referee |
| **Gets** | a standard its own agents are measured against that the market does not read as "their own exam"; a provider role any conformant runtime can plug in | distribution into a vertical where correctness is the product; a second story beside agent security |

The split matters for neutrality in one specific way: **the profile must resolve
against any provider.** The IP profile names record types and attributes; a
national office, a regional office, a public aggregator or a commercial database
can serve it. If the only provider that can answer a corpus is the partner's,
the benchmark is theirs, whatever the repository says. The seed corpora therefore
resolve against a frozen *synthetic* world that anyone can reproduce, and a
partner's contribution is measured by how much *more* of the real register their
provider answers — coverage, freshness, jurisdictions — not by being the answer.

The one sentence for the room: *we are not proposing to add a filter in front of
your agents; we are proposing to define, together and in the open, what an AI in
IP and life sciences has to show before anyone should trust it — and to let every
agent, yours included, be measured against it.*

## 7. Open questions worth deciding with a partner

1. **The provider interface.** `resolve(type, key) → found | not_found | unavailable`
   with a dated record is the minimum. Does a real register need *search* (find
   the record a paraphrase refers to) as well as *resolve*? Where does entity
   linking for drug names live — provider or profile?
2. **Structured evidence from the agent.** Free-text extraction is lossy. A
   convention for an agent to emit its evidence envelope as a block (references,
   claims, jurisdiction, as-of, limitations) makes checking exact — but the block
   is the agent's assertion and must still be resolved, and it must not become a
   wire field that a producer can use to look compliant.
3. **Date semantics.** Which date bounds which conclusion (priority vs effective
   filing vs publication; data cut-off vs database lock vs publication)? The
   seed profiles use ISO dates only; real answers do not.
4. **Jurisdiction coverage.** Which offices and regulators does a first release
   claim, and how does a profile say "this provider does not cover CN" so that a
   CN reference is *unavailable* rather than *not found*?
5. **Benchmark governance.** A partner who contributes cases and fields agents
   measured on them: the cases are Apache-2.0 in this repo, the world is frozen
   and public, and the partner's agents appear on the leaderboard only with
   numbers the harness produced — is that enough? Should contributed cases be
   re-verified by a second provider before they are scored?
6. **The judge.** `unsupported` and the adequacy half of `limitations` need a
   model judge. Whose, scored how, and with what corpus? The judge fixtures in the
   seed corpora are the start of that corpus.
7. **Streaming and cost.** An FTO answer may cite thirty records; the budget per
   event, the timeout, and whether the runtime resolves inline or in an audit
   lane with `flag` outcomes are deployment decisions the spec should bound but
   not fix.
8. **R&D.** Is there any register of technology readiness a viability rule could
   resolve against, or does R&D stay envelope-only?

## 8. Straw-man: how a deployment would look

```
agent (IP assistant) ──▶ /v1/evaluate (step/response, raw provider body)
                            │
                        runtime: workspace ip-agents ──▶ grounding profile ip-seed
                            │                            record provider: <register>
                            ├─ resolve US 10,482,911 → found (in force, Voltaic Cells, …)
                            ├─ resolve US 10,777,001 → not found → hallucination.citation
                            ├─ assertions: "granted 2018-09-20" ≠ grant_date 2019-11-19 → attribute
                            ├─ conclusion fto: claim_reference ✓ jurisdiction ✓ as_of ✗ → temporal
                            └─ verdict: block (citation) + continuation.answer:
                               "Evidence is insufficient to …: US 10,777,001 does not resolve; …"
```

Nothing on the wire changed. The enforcement point that already honours verdicts
already honours this.
