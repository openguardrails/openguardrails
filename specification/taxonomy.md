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
| `safety.pii` | Personal data exposure (often `redact`). |
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

Ids refine hierarchically — semantic type first, country/variant after:
`safety.pii.national_id.cn`, `safety.pii.tax_id.de.vat`. A consumer that
does not know a refined id MUST treat it as its longest known prefix
(`safety.pii.national_id`, ultimately `safety.pii`). This **rollup rule**
lets policy be written once per bucket ("all national ids → redact") with
global coverage, and lets country-specific detectors ship without registry
churn.

Mapping from presidio-analyzer entity names (informative): `US_SSN →
safety.pii.national_id.us`, `US_ITIN → safety.pii.tax_id.us`, `IN_AADHAAR →
safety.pii.national_id.in`, `PL_PESEL → safety.pii.national_id.pl`,
`KR_RRN → safety.pii.national_id.kr`, `UK_NHS → safety.pii.health_id.uk`,
`IT_FISCAL_CODE → safety.pii.tax_id.it`, `CREDIT_CARD →
safety.pii.bank_card`, `IBAN_CODE → safety.pii.bank_account`,
`PHONE_NUMBER → safety.pii.phone_number`, `PERSON →
safety.pii.person_name`, `LOCATION → safety.pii.address`.

## Reference moderation mapping (informative)

The OGR reference moderation capability is a policy-conditioned classifier over 18
content-safety classes (`openguardrails-pipeline/moderation/schema.py`, the source
of truth). It emits the **most specific** normative id per class, refining with a
rollup subcategory where the class is narrower than a spec bucket:

- `safety.toxicity.hate`, `safety.toxicity.profanity`, `safety.toxicity.harassment`
- `safety.violence.threat`
- `safety.illicit.commercial`, `safety.illicit.ip`, `safety.illicit.sexual_crime`
- `safety.sexual.minors`

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
- Unknown/experimental categories MUST be namespaced under
  `x.<vendor>.<name>` and MUST NOT collide with `safety.*` / `security.*`.
- `score` is a detector-reported `0.0`–`1.0`; it is **not** comparable across
  vendors except through the [benchmark](https://github.com/openguardrails/openguardrails/tree/main/benchmarks),
  which is the entire reason the leaderboard exists.
