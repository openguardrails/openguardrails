# OpenAFW — the OGR connection inside the local AI firewall

[OpenAFW](https://github.com/openguardrails/openafw) is a local AI firewall for
coding agents: a loopback proxy on `127.0.0.1:4141` that Claude Code, Codex, Gemini
CLI, OpenCode, OpenClaw or Hermes are pointed at. It replaces every secret in the
outbound model request with an `OGRKF0000001`-style placeholder on the developer's
machine and puts the value back when the reply comes home. It is the LLM byte path
on the host, the way Higress is the byte path in front of an organization's models —
so its OGR connection is a **gateway plugin**: the same seat, the same recipe, the
same two POSTs per model call.

The code lives in that repository, not here:

| What | Where |
|---|---|
| the OGR client — `GET /v1/rules` with its on-disk cache, the `/v1/heartbeat` loop that learns of a ruleset change, the event builder | `crates/openafw/src/ogr.rs` |
| the two events per proxied call — `step/request` judged on the masked body, `step/response` on the whole reply, streaming included | `crates/openafw/src/proxy.rs` |
| the local redaction engine — `ogr-re-1` rules, mask/restore, the placeholder map | `crates/afw-engine/` |

## The seat

- **One proxied model call = one step.** The firewall mints the `step_id`, sends the
  masked request body as `step/request` verbatim, forwards to the provider, and
  sends the reply as `step/response` — a streamed reply reassembled and judged once,
  whole. `integration` is `openafw/<version>`.
- **Observe by default; `--ogr-enforce` refuses blocked steps.** Without the flag a
  `block` is logged and the traffic proceeds — a record, not a control. The
  connection is made once with `openafw connect`; without one the firewall runs on
  its bundled or cached ruleset and reports nothing.
- **Fails open.** A runtime that cannot be reached leaves the agent working on the
  cached ruleset; nothing on the model path waits for the runtime.
- **Identity.** `agent_id` and `agent_type` are the agent name the firewall was
  told (`openafw agent set claude …`) — the firewall's own caller authentication,
  which is the gateway rule: the authenticated caller IS the agent. `agent_workspace`
  and `agent_user` are `""`, no assertion.
- **Local redaction ([OGR 1.4](../../../specification/local-redaction.md)) with
  minter letter `F`.** The runtime judges tokens; the values never leave the host.
  This is the one gateway plugin that also does local redaction, because it is the
  one running on the host the secret lives on. The placeholder shape and the minter
  letter were chosen by measurement: `docs/placeholder-experiment.md` in that
  repository.

## Why here and not under `agent/`

An agent plugin is code inside the harness — a hook, an interceptor, a callback,
different at every host. OpenAFW is inside no harness: the harness is merely pointed
at it, and it holds the bytes of every request regardless of which agent sent them.
That is a gateway's seat. The [`agent/ogr-local`](../../agent/ogr-local/) loopback
proxy occupies the same position for Claude Code and Codex from inside their own
plugins; OpenAFW is the product form of that position.
