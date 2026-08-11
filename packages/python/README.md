# openguardrails

The **OpenGuardrails (OGR) SDK**: the in-process reference runtime **plus a
client for the Runtime API** — a vendor-neutral **enforcement** protocol for AI
agent safety & security. Each agent action becomes a `GuardEvent`, runs past
whatever detectors you choose, and gets back a `Verdict` that can allow, block,
or require approval *before* the action runs. Security/safety vendors plug in
behind a single `Detector` interface, and deployers compose them with one policy.
The layering is API → SDK → Plugin: a runtime serves the HTTP API, this package
wraps it, and integrations build on the wrapper.

```bash
pip install openguardrails
```

Zero dependencies (stdlib only).

## The contract in 30 seconds

```python
from openguardrails import Runtime, GuardEvent
from openguardrails.detectors.config_rules import ConfigRulesDetector
from openguardrails.detectors.llm_judge import LLMJudgeDetector

rt = Runtime(
    detectors=[ConfigRulesDetector(policy["config_rules"]), LLMJudgeDetector()],
    policy=policy,                       # composition + rules, deployer-owned
)
verdict = rt.evaluate(GuardEvent(...))   # -> allow | block | require_approval | redact | modify
```

- **`GuardEvent`** — a normalized observation of an agent action (a tool call, an
  exec, model I/O) plus its **provenance** (trust labels on the inputs that
  produced it). The same wire type at every altitude.
- **`Detector`** — the competitive surface. A detector is OGR-conformant if it
  maps a `GuardEvent` to a `Verdict`. Rules, a classifier, or a hosted model —
  your choice. `provider` is its stable identity for attribution and benchmarking.
- **`Runtime`** — the PDP: fans out to detectors, **composes** their verdicts
  (deny-wins / quorum / first-available), propagates provenance, and correlates
  altitudes by `guard_id` so a later observation point can only *tighten* an
  earlier decision.

## Talk to a runtime (`RuntimeClient`)

When the PDP is a deployed OGR runtime rather than the in-process one, the same
`GuardEvent`/`Verdict` types go over HTTP. `base_url` is the API root — the
client appends the canonical `/v1/*` paths, so a runtime mounted behind a
prefix takes the full prefix (e.g. `https://host/api/public/ogr`). A bare
deployment base URL also works against older runtimes that mount the API only
at `/api/public/ogr`: a route-level 404 on a canonical path is retried once on
the legacy mount and the discovered mount is cached per client. Both
arguments default to `OGR_RUNTIME_URL` / `OGR_API_KEY`.

```python
from openguardrails import RuntimeClient, RateLimitedError

client = RuntimeClient("https://host/api/public/ogr", "ogr_...")
verdict = client.evaluate(event)             # POST /v1/evaluate -> Verdict
results = client.ingest([event1, event2])    # POST /v1/ingest (batched, 207)
client.get_approval(event.guard_id)          # {"status": "pending" | ...}
```

Ed25519 detached-JWS request signing (`Ed25519Signer`, header
`ogr-batch-signature`) is optional and needs the `cryptography` package;
`BatchingIngestor` gives fire-and-forget background ingest with an atexit
drain. Everything else stays stdlib-only.

## Write a detector (the whole vendor surface)

```python
from openguardrails.detectors import Detector
from openguardrails import Verdict, Category

class AcmeInjectionDetector(Detector):
    provider = "acme.injection"
    handles  = ("tool_call", "exec", "model_output")
    def evaluate(self, ev):
        ...  # rules, classifier, or hosted model
        return Verdict(ev.event_id, ev.guard_id, self.provider, "block",
                       categories=[Category("security.prompt_injection", "security", 0.97)])
```

## Instrument an agent

To guard a real agent, install a per-target instrumentation package:

- [`openguardrails-instrumentation-hermes`](https://pypi.org/project/openguardrails-instrumentation-hermes/)
  — secures a Hermes agent across the gateway, tool-call hook, and sandbox exec.

## Status

Implements protocol `0.4` — reference implementation validating the
[specification](https://github.com/openguardrails/openguardrails). The wire
contract is the product; this runtime is the proof it runs.
