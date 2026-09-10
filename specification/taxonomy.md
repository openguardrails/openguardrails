# Risk Taxonomy (semantic conventions)

Category IDs referenced by `Verdict.categories[].id`. Versioned and **swappable**:
the contract references IDs; it stays neutral on what is "unsafe" for a given use
case. In `v1` this graduates to its own repo
(`openguardrails-semantic-conventions`), mirroring OpenTelemetry.

Keywords per RFC 2119. IDs are namespaced `domain.category[.subcategory]`.

## `safety.*`

Harmful content/behavior, judged at the content I/O boundary.

| ID | Description |
|---|---|
| `safety.toxicity` | Harassment, hate, demeaning content. |
| `safety.self_harm` | Self-harm / suicide promotion or instructions. |
| `safety.sexual` | Sexual content; `safety.sexual.minors` (CSAM) is always block. |
| `safety.violence` | Violent threats or instructions. |
| `safety.weapons` | Illicit weapons / CBRN uplift. |
| `safety.illicit` | Other illicit-activity facilitation. |
| `safety.pii` | Personal data uttered in generated content — the model said someone's data out loud. Data *crossing a boundary* is `privacy.pii.*`; see that domain. |
| `safety.brand` | Brand-safety / off-policy persona. |
| `safety.topic_violation` | Out-of-scope topic for a constrained agent. |
| `safety.hallucination` | Unsupported factual claim (where checkable). |
| `safety.unsafe_advice` | Confident guidance in a high-stakes domain (medical, financial, legal) that is harmful, unsupported, or should have deferred/escalated to a human. Domain-neutral: specialize per domain via subcategory (e.g. `safety.unsafe_advice.clinical_escalation`, `safety.unsafe_advice.medication_interaction`), never a vertical sibling. |

### Healthcare unsafe-advice mapping (informative)

Healthcare is an application vertical, not a top-level taxonomy axis. The
following synthetic examples show how clinical failure modes map to shared OGR
failure-mode IDs; they do not define a medical detector or a closed healthcare
taxonomy.

| Clinical failure mode | Expected OGR category |
|---|---|
| Unsafe reassurance when urgent escalation is indicated | `safety.unsafe_advice.clinical_escalation` |
| Contraindicated medication or interaction advice | `safety.unsafe_advice.medication_interaction` |
| Missing or delayed emergency referral | `safety.unsafe_advice.clinical_escalation` |
| Unsupported dosage or guideline claim presented as fact and used to drive action | `safety.hallucination` + `safety.unsafe_advice` |
| Failure to defer to a clinician or emergency service | `safety.unsafe_advice` |

Executable examples live in
`benchmarks/suites/safety/unsafe_advice_healthcare.jsonl`. Detectors SHOULD emit
the most specific category they can justify; consumers apply the normal
hierarchical rollup rule.

### `safety.hallucination.*` and `safety.unsafe_advice.*` — grounding subcategories

`safety.hallucination` names a family; a professional domain needs the members,
because each has a different check and a different remedy. These seven leaves
are what a [grounding profile](grounding.md) emits (OGR 1.7). They are
domain-neutral by construction — the same leaf is a fabricated patent number, a
fabricated trial id and a fabricated case citation — and a vertical contributes
a *profile* that maps onto them, never a sibling axis.

| ID | The failure |
|---|---|
| `safety.hallucination.citation` | A referenced record — a patent, an application, a trial, a paper, a case, a standard — that the authoritative provider has no record of. The reference was invented. |
| `safety.hallucination.attribute` | The record exists; a stated attribute contradicts it — legal status, kind (application vs grant), a date, a jurisdiction, a party, a phase, an enrollment, an approval, an indication. |
| `safety.hallucination.unsupported` | The record exists and is described correctly, and does not support the proposition attributed to it — a claim read as saying the opposite of its text, a trial's result extrapolated to a population it did not study. A **judgment** leaf: a model judge or a person emits it, never a lexicon. |
| `safety.unsafe_advice.overreach` | A determination rendered where the field reserves the decision to a court, an office, a regulator or a licensed professional: *infringes*, *is invalid*, *is clear to launch*, *is effective*, *is completely safe*. The envelope may be complete; the agent still was not entitled to decide. |
| `safety.unsafe_advice.evidence_gap` | A conclusion of a declared class rendered without the evidence the class requires — no resolved record, no claim named, no endpoint, no sample size, no stated limitation. |
| `safety.unsafe_advice.jurisdiction` | A statement whose truth is bounded by a jurisdiction or a regulator, made without one — "approved", "in force", "clear to operate", and nowhere. |
| `safety.unsafe_advice.temporal` | A conclusion that depends on a date — a priority date, a legal-status check, a data cut-off — rendered with no date basis, or against the wrong one. |

Two of the seven are refinements of the healthcare mapping's existing use of
`safety.hallucination` + `safety.unsafe_advice`; a consumer that knows only the
parents rolls them up as usual.

### Intellectual-property mapping (informative)

Intellectual property is an application vertical, not a top-level taxonomy axis
— the same rule healthcare and trading follow. It is worth writing down because
it is the clearest case where an answer's correctness is **checkable against a
register**: whether a patent exists, what kind of document it is, its legal
status, its dates, its jurisdiction and its assignee all have a record of truth,
and the conclusions the field lets an agent draw (a freedom-to-operate view, a
novelty assessment) have a well-understood evidence envelope. The rule ids are
the seed profile's ([`proposals/domain-trust-ip-life-sciences.md`](../proposals/domain-trust-ip-life-sciences.md)).

| IP failure mode | Rule | Expected OGR category |
|---|---|---|
| A cited patent, application or publication number that does not exist | OG-IP-001 | `safety.hallucination.citation` |
| A published application described as a granted patent, or the reverse | OG-IP-002 | `safety.hallucination.attribute` |
| An expired, lapsed, abandoned or invalidated right presented as in force (a "blocking patent" that blocks nothing) | OG-IP-003 | `safety.hallucination.attribute` |
| A European or Chinese right described as a US one; an FTO or infringement view with no jurisdiction scope | OG-IP-004 | `safety.hallucination.attribute` / `safety.unsafe_advice.jurisdiction` |
| Priority, filing, publication, grant and expiry dates confused with one another; a legal-status view with no as-of date | OG-IP-005 | `safety.hallucination.attribute` / `safety.unsafe_advice.temporal` |
| A freedom-to-operate view resting on no resolved record | OG-IP-006 | `safety.unsafe_advice.evidence_gap` |
| Infringement or non-infringement rendered as decided rather than as risk; similarity treated as infringement | OG-IP-007 | `safety.unsafe_advice.overreach` |
| A conclusion about a patent as a whole with no claim named; the description read as the scope; a claim read as saying what it does not | OG-IP-008 | `safety.unsafe_advice.evidence_gap` / `safety.hallucination.unsupported` |
| Wrong assignee or applicant | OG-IP-009 | `safety.hallucination.attribute` |
| A novelty assessment with no priority date; art that post-dates the priority date cited as anticipating | OG-IP-010 | `safety.unsafe_advice.temporal` |
| Validity or invalidity rendered as decided | OG-IP-011 | `safety.unsafe_advice.overreach` |
| Instructions arriving inside a search result, an office action or a prior-art document | — | `security.prompt_injection` |
| A patent-office or database credential in a reply or a tool argument | — | `security.secret_leak.api_key` |
| An unpublished invention disclosure sent to an outside endpoint | — | `security.data_exfiltration` |

Executable examples live in `benchmarks/suites/safety/grounding_ip.jsonl`, scored
against `grounding_ip.profile.json` and the frozen world `grounding_ip.records.json`.

⚠️ **A clean grounding verdict is not a legal opinion.** It says the answer's
references resolved, its stated attributes matched the register, and its evidence
envelope was present. Claim construction, non-obviousness and infringement remain
the work of counsel, and `overreach` exists precisely to keep an agent from
pretending otherwise — see [Grounding § what grounding cannot do](grounding.md#what-grounding-cannot-do).

### Life-sciences mapping (informative)

Life sciences — drug, trial and target intelligence — is the second vertical with
a register: trial registries, regulatory labels and curated pharmacology
databases are records an answer can be checked against. It differs from IP in
one way that matters: many of its canonical names are **words, not numbers**, so
a drug is linked by dictionary rather than grammar, and an invented drug name is
a judge's case. Clinical *advice* to a person stays with the
[healthcare mapping](#healthcare-unsafe-advice-mapping-informative); this mapping
is about *evidence* claims.

| Life-sciences failure mode | Rule | Expected OGR category |
|---|---|---|
| A cited trial id, paper or registry entry that does not exist | OG-LS-001 | `safety.hallucination.citation` |
| Wrong phase, status (terminated as completed), enrollment, sponsor, or results claimed posted when none are | OG-LS-002 | `safety.hallucination.attribute` |
| "Approved" by a regulator that has not approved it, on a wrong date, or after withdrawal; "approved" with no regulator named | OG-LS-003 | `safety.hallucination.attribute` / `safety.unsafe_advice.jurisdiction` |
| An approved indication stated outside the label | OG-LS-004 | `safety.hallucination.attribute` |
| An efficacy or safety claim rendered as decided; one with no trial, no endpoint, no sample size | OG-LS-005 | `safety.unsafe_advice.overreach` / `safety.unsafe_advice.evidence_gap` |
| An evidence view with no data cut-off or as-of date | OG-LS-006 | `safety.unsafe_advice.temporal` |
| A real trial cited for a result it did not measure, or for a population it did not study | OG-LS-007 | `safety.hallucination.unsupported` |
| Wrong target or mechanism | OG-LS-008 | `safety.hallucination.attribute` |
| A conclusion stated with no limitation and no contrary evidence acknowledged | OG-LS-009 | `safety.unsafe_advice.evidence_gap` |
| Commercial viability or market readiness rendered as decided, or undated | OG-LS-010 | `safety.unsafe_advice.overreach` / `safety.unsafe_advice.temporal` |
| Dosage, interaction or escalation advice to a person | — | `safety.unsafe_advice.medication_interaction` / `.clinical_escalation` |
| Instructions inside a registry record, a label PDF or a paper | — | `security.prompt_injection` |
| Patient-level data leaving the boundary | — | `privacy.pii.health_id` and siblings |

Executable examples live in `benchmarks/suites/safety/grounding_life_sciences.jsonl`,
scored against `grounding_life_sciences.profile.json` and the frozen world
`grounding_life_sciences.records.json`.

## `security.*`

System compromise, judged on actions and data flow.

| ID | Description |
|---|---|
| `security.prompt_injection` | Instruction in *data* attempting to change agent behavior. |
| `security.jailbreak` | Attempt to subvert the agent's own guardrails/policy. |
| `security.malicious_command` | Dangerous shell/exec (pipe-to-shell, destructive ops, obfuscation). |
| `security.data_exfiltration` | Sensitive data leaving the trust boundary. |
| `security.secret_leak` | Credentials/keys exposed in output, args, or env. |
| `security.ssrf` | Server-side request forgery / unexpected egress. |
| `security.privilege_escalation` | `sudo`, capability or scope escalation. |
| `security.sandbox_escape` | Attempt to break out of the sandbox. |
| `security.supply_chain` | Untrusted package / MCP / skill / model source. |
| `security.tool_poisoning` | Malicious tool/MCP **definition** (hidden instructions in descriptions/schemas). |
| `security.memory_poisoning` | Persistent/cross-session corruption of agent memory — instructions implanted in memory that survive across sessions. |
| `security.resource_exhaustion` | Loop amplification, runaway API spend, action/order spam — abuse judged on action rates and volume. |
| `security.shadow_agent` | Several agents hiding behind one identity — the same `agent_id` observed with differing `agent_type` values (one credential driving multiple harnesses). An identity-governance signal emitted by the runtime, not a content judgment. |
| `security.mandate_violation` | An action outside the **authorization envelope** its operator declared for the agent — a target, instrument, capability, quantity, rate or time window the [mandate](mandate.md) does not grant. The agent is doing its own job, out of bounds. Refine with the subcategories below. |
| `security.pretrade` | An order-placing action refused by a **pre-trade state check** — a limit that needs live account state the call itself does not carry (position, cash, gross exposure, daily loss, drawdown, an operator halt). The OMS-layer companion of `security.mandate_violation`: the mandate reads the call, pre-trade reads the book. Emitted only by an enforcement point that holds the upstream session (an MCP door), never judged from content. Refine with the subcategories below. |
| `security.restricted_information` | Acting on information the agent may HOLD but may not ACT ON — material non-public information, another party's pending orders, data admissible for one purpose and used for another. Distinct from `security.data_exfiltration`: nothing left the boundary; the use itself is the violation. |
| `security.market_manipulation` | An action pattern whose effect is to deceive other participants in a market or auction — orders never meant to trade, self-matching, timing chosen to move a print. Judged on the SHAPE of the actions, not on intent, and typically only visible across a sequence. |
| `security.persistence` | Durable access left behind after the task — an implanted key, cron entry, service, scheduled job or account that outlives the session that created it. The one agent action whose consequence is unbounded in time. |

### `security.mandate_violation.*` — envelope-dimension subcategories

`security.mandate_violation` says *that* the agent left its envelope. Policy is
written on *which dimension* was crossed — a wrong target is a scoping bug, a
breached quantity is usually a runaway loop — so a detector SHOULD refine it.
The dimensions are the ones a [mandate](mandate.md) declares:

| ID | The envelope dimension crossed |
|---|---|
| `security.mandate_violation.scope` | WHAT it acted on — an entity, host, account, instrument, repository or venue outside the declared scope. |
| `security.mandate_violation.capability` | WHAT IT DID — an operation class the mandate does not grant (e.g. it may place orders but not withdraw; it may read but not modify). |
| `security.mandate_violation.limit` | HOW MUCH — a declared quantitative bound exceeded: size, count, rate, concurrency, spend. |
| `security.mandate_violation.window` | WHEN — an action outside the authorized time window. |
| `security.mandate_violation.irreversible` | An action the mandate reserves to a human: unwinding, deleting, transferring, disclosing. The dimension is not "how much" but "who may decide". |

### `security.pretrade.*` — pre-trade state subcategories

`security.mandate_violation` reads what a tool call carries; [`mandate.md`](mandate.md)
is explicit that it is not a pre-trade risk control. `security.pretrade` is that other
thing, named separately so the boundary stays visible: an enforcement point that holds
the broker session looks the account up before forwarding an `order.*` call and refuses
on state the call could not show. The leaves name the state that refused it:

| ID | What refused the order |
|---|---|
| `security.pretrade.halt` | An operator halt is in force (kill functionality); every order-placing capability is withheld, cancels pass. |
| `security.pretrade.drawdown` | The book is below its peak by more than the declared drawdown limit. |
| `security.pretrade.daily_loss` | The book is down more than the declared daily-loss limit from the day's start. |
| `security.pretrade.ticket` | The ticket's shape is not permitted — order type, time-in-force, session flag, side. |
| `security.pretrade.price` | A quantity-only ticket could not be priced, so its notional could not be checked. Refused, never guessed. |
| `security.pretrade.position` | The resulting position would exceed the per-instrument limit or cross to a side (short) the profile withholds. |
| `security.pretrade.cash` | A purchase exceeds available cash; margin is not granted. |
| `security.pretrade.exposure` | Gross exposure after the order would exceed the declared multiple of equity. |
| `security.pretrade.state` | Account state could not be read reliably enough to size an order. |

A pre-trade finding is, like a mandate violation, a finding about the agent's envelope
rather than about the world, and it carries `detector: "pretrade"` (or `pretrade:<upstream>`)
so it can never be mistaken for model judgment. It is the enforcement point's own check;
market-access controls in the regulatory sense (SEC Rule 15c3-5, MiFID II RTS 6) remain
the broker's.

⚠️ **A mandate violation is a finding about the AGENT, not about the world.** The
same order or the same command is compliant for one agent and a violation for
another, because the envelope differs — which is why this category cannot be
judged from content alone and why the envelope is runtime configuration rather
than a wire field. See [Mandate](mandate.md).

### `security.market_manipulation.*` — pattern subcategories

Registered because policy and supervision are written per pattern, and because
the patterns are named the same way everywhere they are regulated:

| ID | The pattern |
|---|---|
| `security.market_manipulation.spoofing` | Orders placed without intent to trade, to move the book; layering is the multi-level form. |
| `security.market_manipulation.wash_trade` | Self-matching — the same beneficial owner on both sides, creating volume that transfers nothing. |
| `security.market_manipulation.marking` | Actions timed at a reference moment (close, fix, expiry) to move the print that other things settle on. |
| `security.market_manipulation.momentum_ignition` | A burst intended to trigger other participants' reactions, then trading against them. |
| `security.market_manipulation.quote_stuffing` | Order/cancel volume whose function is to load the venue rather than to trade. |

⚠️ **These are ACTION-PATTERN ids, and none of them is a legal conclusion.** Whether
a pattern is unlawful depends on intent, venue rules and jurisdiction — none of
which reach a detector. A detector reports the pattern it observed; calling it
market abuse is a supervisor's judgment. This is the same line
[`privacy.*`](#privacy) draws when it declines to model `compliance.*`.

⚠️ Most of these are invisible in one event. They are properties of a SEQUENCE
of calls, so a detector emitting them is reading the session (L6) the runtime
derived, not the packet in front of it.

### `security.secret_leak.*` — credential-kind subcategories

`security.secret_leak` says *that* a credential was exposed. Policy is usually
written on *which kind* — an AWS key reaching a public repo is a rotate-now
event, a password in a prompt is a redact-and-warn one — so a detector SHOULD
refine it. Semantic buckets:

`api_key, password, private_key, cloud_credential, db_connection`

| ID | Covers |
|---|---|
| `security.secret_leak.api_key` | API and app tokens, JWT signing secrets, `Authorization: Bearer/Basic` values, client/webhook secrets |
| `security.secret_leak.password` | Account or service passwords and passphrases, including SQL `IDENTIFIED BY` |
| `security.secret_leak.private_key` | PEM / OpenSSH private key material |
| `security.secret_leak.cloud_credential` | Cloud-provider access-key secrets and service-account keys |
| `security.secret_leak.db_connection` | Credentials embedded in a DSN, connection string, `.pgpass`, or `DATABASE_URL` |

This list is **open by construction** — credential kinds are unbounded, every
vendor mints its own — so a detector or a deployment MAY emit a further id under
this prefix without registry churn. The usual **rollup rule** applies: a consumer
that does not know `security.secret_leak.cloud_credential` MUST treat it as
`security.secret_leak`. A detector that cannot determine the kind emits the bare
id; that is a valid answer, not a degraded one.

**Why not `privacy.secret.*`.** A leaked key leads to *compromise*, not to a
privacy harm: the control is block-and-rotate rather than masking or
minimisation, and a machine credential has no data subject. Credential exposure
therefore stays in `security.*` — the same reasoning as the v0.4 note under
`privacy.pii.*` below. A *person's* credential handled as personal data is
`privacy.pii.credential`; that id is about data handling, this one is about
exposure.

### Agentic-trading mapping (informative)

Trading is an application vertical, not a top-level taxonomy axis — the same rule
[healthcare](#healthcare-unsafe-advice-mapping-informative) follows. A quant/trading
agent is worth writing down because it is the clearest case where the harm is
**drift**, not content: the model says nothing objectionable and the loss is caused
by an action that was merely *outside what the operator authorized*.

| Trading failure mode | Expected OGR category |
|---|---|
| Order in an instrument, venue or account the desk's mandate does not cover | `security.mandate_violation.scope` |
| Order size, daily turnover, position count or leverage past a declared bound | `security.mandate_violation.limit` |
| Order refused on live book state — position, cash, exposure, daily loss, drawdown, halt | `security.pretrade.*` |
| Using an operation the mandate withholds (short, margin, withdrawal, transfer) | `security.mandate_violation.capability` |
| Trading outside the authorized session/window | `security.mandate_violation.window` |
| Liquidating the book, or any unwind reserved to a human | `security.mandate_violation.irreversible` |
| Order/cancel storm, retry loop, duplicate submissions on a stuck step | `security.resource_exhaustion` |
| Orders placed with no intent to trade, or self-matching | `security.market_manipulation.spoofing` / `.wash_trade` |
| Acting on material non-public information, or on another party's pending order | `security.restricted_information.mnpi` / `.client_order_flow` |
| A price, fundamental or fill invented by the model and used to justify an order | `safety.hallucination` (+ `security.mandate_violation.limit` where it drove the size) |
| Instructions arriving inside a news item, filing, social post or research summary | `security.prompt_injection` |
| Broker or exchange API key in a tool argument, log line or reply | `security.secret_leak.api_key` |
| Positions, orders or strategy parameters sent to an outside endpoint | `security.data_exfiltration` |
| A reply that promises a return, or advises a specific person unsuitably | `safety.unsafe_advice` (refine `.financial_suitability`) |

Executable examples live in
`benchmarks/suites/security/mandate_violation_trading.jsonl`, and a runnable
mandate is in `examples/mandate-agent/`.

⚠️ **The mandate categories are the ones this vertical adds, and they are the ones
a content classifier cannot produce.** `place_order(NVDA, 5000)` is a compliant
call for one agent and a violation for the next; only the
[mandate](mandate.md) tells them apart.

⚠️ **OGR is not a pre-trade risk control, and MUST NOT be described as one.** It
judges the model plane: it can refuse the tool CALL (L2) before the harness runs
it, and it cannot touch an order already sent by a process holding the broker
credential (L1) — see [Mandate § what a mandate cannot do](mandate.md#what-a-mandate-cannot-do).
Market-access limits belong at the broker/OMS, where the regimes that require
them (SEC Rule 15c3-5, MiFID II RTS 6) put them. What OGR adds is the layer
those controls cannot see: the reasoning and the instruction flow that produced
the order.

### Security-operations agent mapping (informative)

The second vertical where actions dominate content. An agent doing authorized
security work and an agent doing damage issue **the same commands** — the
difference is entirely whether the target and the technique were authorized, i.e.
the same envelope question, in a domain where the answer is usually written down
already as a scope file or rules of engagement.

| Security-operations failure mode | Expected OGR category |
|---|---|
| Scanning, exploiting or logging into a host, domain or account outside the engagement scope | `security.mandate_violation.scope` |
| Using a technique class the engagement excludes (denial of service, phishing a real employee, exploiting third-party infrastructure) | `security.mandate_violation.capability` |
| Acting outside the agreed testing window | `security.mandate_violation.window` |
| Destructive or disruptive action on a live system — dropping data, encrypting, disabling a service | `security.mandate_violation.irreversible` (+ `security.malicious_command` where the shell is the vehicle) |
| Leaving an implant, key, cron entry or account behind after the task | `security.persistence` |
| Moving from an in-scope host into an out-of-scope one | `security.mandate_violation.scope` (+ `security.privilege_escalation` where the vehicle is escalation) |
| Exfiltrating captured data beyond the evidence store the engagement names | `security.data_exfiltration` |
| Credentials, hashes or tokens recovered during the work appearing in output or arguments | `security.secret_leak.*` |
| Instructions embedded in scan output, a banner, a page or an issue body the agent read | `security.prompt_injection` |
| Untrusted exploit code, PoC package or tool pulled from an unvetted source | `security.supply_chain` |

Executable examples live in
`benchmarks/suites/security/mandate_violation_secops.jsonl`.

**Mapping to the frameworks this domain already uses (informative).** OGR does not
re-model them and MUST NOT be treated as a replacement: MITRE ATT&CK names
*techniques*, OGR names *what a guardrail decided about one agent action*. The
useful correspondence is one-way — an ATT&CK tactic suggests which OGR category a
detector should emit:

| ATT&CK tactic (or kill-chain phase) | Usually surfaces as |
|---|---|
| Reconnaissance / Discovery | `security.mandate_violation.scope` (only when out of scope; in-scope recon is the job) |
| Initial Access / Execution | `security.malicious_command`, `security.mandate_violation.capability` |
| Persistence | `security.persistence` |
| Privilege Escalation / Defense Evasion | `security.privilege_escalation`, `security.sandbox_escape` |
| Lateral Movement | `security.mandate_violation.scope` |
| Collection / Exfiltration | `security.data_exfiltration`, `security.secret_leak.*` |
| Impact | `security.mandate_violation.irreversible` |

⚠️ **In this vertical the taxonomy is deliberately symmetric.** There is no
`offensive.*` domain and there will not be one: an id that meant "this was an
attack" would have to be decided from intent, which no detector observes. Every
row above is either an envelope question (the operator answered it in advance) or
an ordinary agent-security question that a defender's agent and an attacker's
agent raise identically.

## `privacy.*`

Personal-data handling, judged where data **crosses a boundary** (egress to a
tool call, a model reply, a retrieved result) rather than at the content I/O
boundary. Distinct from `safety.*` on purpose: exposing an email address is not
harm in the sense `safety.self_harm` or `safety.weapons` mean it, and the control
it drives is masking/minimisation, not refusal.

| ID | Description |
|---|---|
| `privacy.pii` | Personal data crossing a boundary (often `redact`). Refine with the registry below. |

**Why not `compliance.*`.** A risk taxonomy names *what was detected*, not *why
you care*. A span detector can answer "is this a national ID"; it cannot answer
"is this a GDPR violation" — that depends on jurisdiction, data-subject
residency, lawful basis, consent state and contract, none of which reach the
detector. Compliance is also cross-cutting (a credential leak is a
breach-notification event; unsuitable financial advice is a conduct event), so it
does not partition the space. Obligation belongs on an implementation's policy
axis, not on the category id.

### `privacy.pii.*` — subcategory registry

Span-level PII detection needs entity-level ids; without a shared registry,
masking policy (which is written *per entity type*) cannot interoperate.
Semantic buckets:

`person_name, address, email, phone_number, national_id, tax_id, passport,
driver_license, health_id, bank_card, bank_account, ip_address,
organization, date_of_birth, credential`

Weak identifiers — data that identifies a person only in combination, but that
span detectors do report and that masking policy is written on:

`age, gender, date_time, im_account, url`

They are registered rather than left to roll up to the bare `privacy.pii`,
because collapsing them there makes the one policy question about them
unanswerable: a chat handle is a way to reach someone and an age is not, and a
deployment that wants to mask the first and record the second has no id to say
so with. `date_time` is the general bucket a detector emits when it can see a
date attached to a person but cannot tell what the date IS; a detector that
knows it is a birth date emits `date_of_birth`, which is the more specific
justifiable id.

Ids refine hierarchically — semantic type first, country/variant after:
`privacy.pii.national_id.cn`, `privacy.pii.tax_id.de.vat`. A consumer that
does not know a refined id MUST treat it as its longest known prefix
(`privacy.pii.national_id`, ultimately `privacy.pii`). This **rollup rule**
lets policy be written once per bucket ("all national ids → redact") with
global coverage, and lets country-specific detectors ship without registry
churn.

Mapping from presidio-analyzer entity names (informative): `US_SSN →
privacy.pii.national_id.us`, `US_ITIN → privacy.pii.tax_id.us`, `IN_AADHAAR →
privacy.pii.national_id.in`, `PL_PESEL → privacy.pii.national_id.pl`,
`KR_RRN → privacy.pii.national_id.kr`, `UK_NHS → privacy.pii.health_id.uk`,
`IT_FISCAL_CODE → privacy.pii.tax_id.it`, `CREDIT_CARD →
privacy.pii.bank_card`, `IBAN_CODE → privacy.pii.bank_account`,
`PHONE_NUMBER → privacy.pii.phone_number`, `PERSON →
privacy.pii.person_name`, `LOCATION → privacy.pii.address`.

> **Moved in v0.4 (breaking).** This registry was rooted at `safety.pii.*`
> through v0.3. It was misfiled: `safety.*` is defined as harmful content judged
> at the content I/O boundary, and per-entity masking policy is neither. The
> leaves are unchanged — the move is a pure prefix swap, so a consumer migrates
> with `s/^safety\.pii/privacy.pii/`. `safety.pii` survives as the *content*
> class (see below); credential exposure stays `security.secret_leak`, since a
> leaked key leads to compromise rather than to a privacy harm.

### `safety.pii` vs `privacy.pii.*`

Two different judgments that v0.3 collapsed onto one id:

| | Judged where | Example | ID |
|---|---|---|---|
| Content class | content I/O boundary | the assistant states a customer's home address in a reply | `safety.pii` |
| Data handling | egress boundary | an agent passes a national ID into a third-party tool call | `privacy.pii.national_id` |

A detector that reports spans with entity types belongs in `privacy.pii.*`. A
content-safety classifier emitting a per-turn class belongs in `safety.pii`.

## Reference moderation mapping (informative)

The OGR reference moderation capability is a policy-conditioned classifier over 18
content-safety classes (`openguardrails-pipeline/moderation/schema.py`, the source
of truth). It emits the **most specific** normative id per class, refining with a
rollup subcategory where the class is narrower than a spec bucket:

- `safety.toxicity.hate`, `safety.toxicity.profanity`, `safety.toxicity.harassment`
- `safety.violence.threat`
- `safety.illicit.commercial`, `safety.illicit.ip`, `safety.illicit.sexual_crime`
- `safety.sexual.minors`

Its S11 class stays `safety.pii`: it judges one turn's content, not a span
crossing a boundary. The span-level privacy detector reports `privacy.pii.*`
instead — see that domain.

Three jurisdiction-specific classes (general/sensitive political content, national
symbols) have no neutral home in the standard and stay under the vendor namespace:
`x.ogr.politics.general`, `x.ogr.politics.sensitive`, `x.ogr.national_symbols`. Per
the rollup rule below, a consumer that doesn't recognize a refinement treats it as
its parent (`safety.toxicity.hate` → `safety.toxicity`).

## Reference detector coverage (informative)

An ID is defined by its threat class, **not** by whether any given detector emits
it — the taxonomy is a neutral vocabulary, and several standard IDs
(`security.supply_chain`, `security.sandbox_escape`) already have no reference
emitter. For the two agent-security IDs added in v0.4, the OpenGuardrails
reference pipeline maps only *partially*: its indirect-injection capability flags
memory-write payloads (an informative source for `security.memory_poisoning`),
and its content-safety S9 class covers model resource-consumption loops (an
informative source for `security.resource_exhaustion`). Neither is a dedicated
persistent-memory or rate-abuse detector; third-party or future detectors report
against the same IDs. Reference coverage is a roadmap note, never an admission
gate for the standard.

## Conventions

- A detector MUST use the most specific ID it can justify.
- Hierarchical rollup: a consumer encountering an unknown id MUST fall back
  to its longest known dotted prefix before treating it as unknown.
- The normative domains are `safety.*`, `security.*` and `privacy.*`.
- Unknown/experimental categories MUST be namespaced under
  `x.<vendor>.<name>` and MUST NOT collide with them. A class that has a
  neutral home in a normative domain MUST use it rather than a vendor id —
  the vendor namespace is for what the standard does not yet model.
- `score` is a detector-reported `0.0`–`1.0`; it is **not** comparable across
  vendors except through the [benchmark](https://github.com/openguardrails/openguardrails/tree/main/benchmarks),
  which is the entire reason the leaderboard exists.
