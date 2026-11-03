# Integrations

One integration remains: [`gateway/higress`](gateway/higress/), a Higress WASM plugin, called
**OpenGuardrails AIRS** in the Higress console. It puts an organization's Higress gateway in front of
OpenGuardrails AIRS and speaks the Runtime API (`POST /v1/evaluate`), which AIRS serves and keeps
frozen so that existing deployments keep working.

The agent plugins, the Java bridge, the mitmproxy and OpenAI/Anthropic reference gateways and the
OpenAFW pointer were removed on 2026-11-03, together with the published protocol. A builder connects
through the local gateway in [`cli/`](../cli/), which sees every request whichever harness sent it.
Their code remains in the git history.
