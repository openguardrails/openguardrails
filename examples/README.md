# openguardrails-examples

The **30-second proof that OGR runs** — plus the index of every place it plugs in.

[OpenGuardrails](https://openguardrails.com) is a vendor-neutral protocol for AI
agent safety & security: every agent action becomes a `GuardEvent`, every
detector returns a `Verdict`, and the deployer composes them under one policy —
enforced at three altitudes (**gateway**, **agent hook**, **sandbox**), correlated
by `guard_id`.

This directory is the runnable conceptual demo and integration map. The real
integrations live elsewhere in this monorepo; the demo stays tiny and depends
on the published runtime rather than vendoring a copy.

```bash
pip install openguardrails        # the reference runtime (PyPI, zero deps)
python3 demo.py                   # no API key, no network
```

## What the demo proves

`demo.py` runs a Hermes-style agent and its sandbox through **one** OGR runtime
with two reference detectors (a config rule and an offline LLM judge), composed:

| Claim | Shown by |
|---|---|
| One contract spans agent hook **and** sandbox | both emit `GuardEvent`s to one `Runtime` |
| A detector can be **config or model** | `ConfigRulesDetector` + `LLMJudgeDetector` |
| Vendors **compose** into one decision | `deny-wins` across both (scenario B) |
| **Provenance** catches the dangerous *combination* | same `curl … \| bash`: untrusted origin → `block` (B), trusted user → `require_approval` (C) |
| **guard_id** correlates altitudes | hook allows `bash deploy.sh`, sandbox tightens to `require_approval` on a leaked secret (D) |

The runtime, detectors, and composition are the published
[`openguardrails`](https://github.com/openguardrails/openguardrails/tree/main/packages/python)
package — the same code the integrations below run in production.

## Integrations index

Pick the altitude you're entering from. Each link points to its source directory.

### Agent hook — intercept the tool call
| Target | Source | Distribution |
|---|---|---|
| Claude Code | [openguardrails-instrumentation-claude-code](https://github.com/openguardrails/openguardrails/tree/main/integrations/agent/claude-code) | plugin marketplace |
| opencode | [integrations/agent/opencode](https://github.com/openguardrails/openguardrails/tree/main/integrations/agent/opencode) | npm plugin |
| OpenClaw | [integrations/agent/openclaw](https://github.com/openguardrails/openguardrails/tree/main/integrations/agent/openclaw) | npm + ClawHub |
| Hermes | [integrations/agent/hermes](https://github.com/openguardrails/openguardrails/tree/main/integrations/agent/hermes) | PyPI |
| LangGraph | [integrations/agent/langgraph](https://github.com/openguardrails/openguardrails/tree/main/integrations/agent/langgraph) | PyPI |

### Sandbox hook — enforce on the real exec / network / files
| Target | Source | Scenario |
|---|---|---|
| Anthropic srt | [integrations/agent/hermes](https://github.com/openguardrails/openguardrails/tree/main/integrations/agent/hermes) | personal · OS-level, no Docker |
| NVIDIA OpenShell | [integrations/agent/hermes](https://github.com/openguardrails/openguardrails/tree/main/integrations/agent/hermes) | multi-tenant · container + OPA egress |

One OGR `sandbox` policy block compiles to either backend — same fields, two
threat models.

Dedicated Anthropic srt and NVIDIA OpenShell sandbox-hook examples will be added
under `integrations/`. The Hermes integration currently demonstrates both
backends end to end.

### Gateway hook — integrate at the LLM protocol boundary
| Target | Source | |
|---|---|---|
| OpenAI / Anthropic / MCP | [integrations/gateway/openai-anthropic](https://github.com/openguardrails/openguardrails/tree/main/integrations/gateway/openai-anthropic) | runnable integration example |

### Core, spec & benchmark
| | Repo |
|---|---|
| Python runtime (`pip install openguardrails`) | [openguardrails-python](https://github.com/openguardrails/openguardrails/tree/main/packages/python) |
| JS runtime (`@openguardrails/core`) | [openguardrails-js](https://github.com/openguardrails/openguardrails/tree/main/packages/javascript) |
| Protocol specification | [openguardrails](https://github.com/openguardrails/openguardrails) |
| Neutral benchmark / leaderboard | [openguardrails-bench](https://github.com/openguardrails/openguardrails/tree/main/benchmarks) |

## How a security vendor plugs in

Implement one method — this is the entire competitive surface, identical at every
altitude:

```python
from openguardrails.detectors import Detector
from openguardrails.models import GuardEvent, Verdict, Category

class AcmeInjection(Detector):
    provider = "acme.injection"
    handles  = ("tool_call", "exec", "model_input", "model_output")
    def evaluate(self, ev: GuardEvent) -> Verdict:
        ...  # rules, a classifier, a hosted model — your choice
        return Verdict(ev.event_id, ev.guard_id, self.provider, "block",
                       categories=[Category("security.prompt_injection", "security", 0.97)])
```

Add it to a `Runtime(detectors=[...])` and reference it in `policy.json`. The same
`provider` field is what [`openguardrails-bench`](https://github.com/openguardrails/openguardrails/tree/main/benchmarks)
uses to score and rank it.

## Layout

```
demo.py          # the runnable proof (imports the published runtime)
adapters/        # the demo's Hermes agent-hook + sandbox exec-hook shims
policy.json      # the deployer's config: composition + the config detector's rules
requirements.txt # openguardrails
```

## Status

PoC / `v0.1`. Apache-2.0. It validates the
[specification](https://github.com/openguardrails/openguardrails) and points
the way to every real integration.
