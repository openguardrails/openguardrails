# Integrations (the plugin layer)

Integrations are the **plugin layer** of OGR's API → SDK → Plugin stack: a
plugin is a hook for one surface plus an SDK. The hook observes actions and
enforces decisions; the SDK (`packages/python` / `packages/javascript`)
handles everything below — building `GuardEvent`s, calling the
[Runtime API](../specification/runtime-api.md) (`/v1/evaluate`, `/v1/ingest`),
auth, signing, and wire mapping. A plugin should not hand-roll an HTTP client
or its own wire serialization.

Four hook categories:

| Category | Purpose |
|---|---|
| [`agent/`](agent/) | Intercept agent tool and framework lifecycle hooks. |
| [`gateway/`](gateway/) | Intercept LLM protocol requests and responses. |
| [`sandbox/`](sandbox/) | Enforce policy at process, filesystem, and network boundaries. |
| [`ebpf/`](ebpf/) | Observe or enforce kernel-level activity with eBPF. |

Language-specific plugins depend on the corresponding SDK under `packages/`.
Marketplace plugins may bundle that SDK into a self-contained artifact.
