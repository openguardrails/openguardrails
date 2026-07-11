# Integrations

OpenGuardrails integrations bind the same `GuardEvent → Verdict` core contract
through four implementation categories:

| Category | Purpose |
|---|---|
| [`agent/`](agent/) | Intercept agent tool and framework lifecycle hooks. |
| [`gateway/`](gateway/) | Intercept LLM protocol requests and responses. |
| [`sandbox/`](sandbox/) | Enforce policy at process, filesystem, and network boundaries. |
| [`ebpf/`](ebpf/) | Observe or enforce kernel-level activity with eBPF. |

Language-specific integrations depend on the corresponding core runtime under
`packages/`. Marketplace plugins may bundle that runtime into a self-contained
artifact.
