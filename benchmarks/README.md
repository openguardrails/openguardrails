# openguardrails-bench

**The neutral leaderboard for AI agent safety & security detectors.**

OpenGuardrails does not build detection capability — it **referees**. Any
[OGR-conformant](https://github.com/openguardrails/openguardrails) detector
(config-based or model-based) can be run against shared corpora here and ranked
on a level field. We never fabricate a vendor's score; numbers come from the
harness or they don't appear.

```bash
python3 harness/run.py        # stdlib only — runs the reference detectors, writes leaderboard/
```

## Results — `seed-v0`

Real outputs of reference detectors + baselines (full table in
[`leaderboard/RESULTS.md`](leaderboard/RESULTS.md), machine-readable in
[`leaderboard/results.json`](leaderboard/results.json)):

| Detector | Type | Injection | Malicious-cmd | Exfil | Secret-leak | Macro F1 |
|---|---|---|---|---|---|---|
| keyword-baseline | baseline | 0.400 | 0.800 | 0.667 | 0.667 | 0.634 |
| **ogr-compose (config⊕llm)** | hybrid | **0.889** | 0.667 | 0.545 | 0.400 | **0.625** |
| block-all | baseline | 0.625 | 0.625 | 0.571 | 0.571 | 0.598 |
| config-rules | config | 0.333 | 0.667 | 0.400 | 0.400 | 0.450 |
| llm-judge (provenance-aware) | model | **0.889** | 0.333 | 0.400 | 0.000 | 0.406 |
| allow-all | baseline | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |

What the real numbers show:

1. **Provenance wins on injection.** The provenance-aware detectors hit F1 0.889
   (P=1.00, R=0.80) on prompt injection; config-rules gets 0.333, keyword 0.400.
   Knowing the input came from an untrusted origin is what catches it.
2. **Composition beats its parts.** `config⊕llm` (macro 0.625) outperforms config
   (0.450) and llm (0.406) alone — the whole reason composition is a first-class
   spec concept.
3. **Honest caveat.** `keyword-baseline` tops macro on `seed-v0` *only* because the
   seed is signature-heavy (literal `curl`, `/etc/passwd`, …). Its injection F1 is
   0.40 and it false-positives on benign `curl`. The next milestone is obfuscated
   and paraphrased cases where signature matching collapses.

## What's here

```
suites/security/
  _benign.jsonl          # shared safe cases (negatives), paired with every suite
  prompt_injection.jsonl # positives, carry untrusted provenance
  malicious_command.jsonl
  data_exfiltration.jsonl
  secret_leak.jsonl
harness/
  ogrlib.py              # minimal OGR types (mirrors openguardrails)
  detectors.py           # reference detectors + baselines (NOT third-party vendors)
  run.py                 # scores every detector → leaderboard/{results.json,RESULTS.md}
leaderboard/             # generated results (feeds openguardrails.com)
```

Case format: one JSON object per line — `{id, suite, unsafe: bool, event: {...GuardEvent}}`.
Positives carry realistic `provenance` (indirect injection is only meaningful with
an untrusted origin). Scoring is binary per suite (a detector predicts unsafe iff
its `decision` ∈ {block, require_approval, redact}); the harness reports
precision / recall / F1 per category, macro-F1, and p95 latency.

## Submit a detector

Implement the OGR contract — `evaluate(GuardEvent) → Verdict` — wrap it as a
`detectors.py`-style adapter, and open a PR. Conformance (schema-valid verdicts)
is the prerequisite to being listed; the benchmark is the ranking. Corpora
governance will be foundation-neutral.

## Roadmap

- Obfuscated / paraphrased / novel-domain cases (break the keyword baseline).
- `safety.*` suites (toxicity, self-harm, PII).
- `tool_poisoning` suite (malicious MCP/tool **definitions**).
- Adapters for real guard models so vendors appear with real numbers.
