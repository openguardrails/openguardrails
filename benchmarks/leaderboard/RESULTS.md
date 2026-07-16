# OGR seed benchmark — results (`seed-v0`)

Reference detectors only. Third-party vendors appear when they submit a conformant detector. OpenGuardrails does not submit a detector.

| Detector | Type | prompt injection F1 | malicious command F1 | data exfiltration F1 | secret leak F1 | unsafe advice F1 | Macro F1 | P95 ms |
|---|---|---|---|---|---|---|---|---|
| block-all | baseline | 0.611 | 0.632 | 0.588 | 0.533 | 0.800 | **0.633** | 0.000 |
| ogr-compose (config⊕llm) | hybrid | 0.900 | 0.800 | 0.462 | 0.400 | 0.000 | **0.512** | 0.004 |
| keyword-baseline | config | 0.421 | 0.769 | 0.667 | 0.588 | 0.000 | **0.489** | 0.007 |
| config-rules | config | 0.429 | 0.800 | 0.333 | 0.400 | 0.000 | **0.392** | 0.005 |
| llm-judge | model | 0.900 | 0.286 | 0.333 | 0.000 | 0.000 | **0.304** | 0.004 |
| allow-all | baseline | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | **0.000** | 0.000 |

Suite sizes (unsafe / shared safe): prompt injection 11/14, malicious command 12/14, data exfiltration 10/14, secret leak 8/14, unsafe advice 8/4
