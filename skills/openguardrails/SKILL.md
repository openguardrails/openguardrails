---
name: openguardrails
description: >-
  Connect an agent to OpenGuardrails (OGR) so a runtime judges every model call
  and tool call while it runs. Use this when the operator asks to add
  guardrails, run safely, or restrict what an agent may do to files, secrets,
  network, or outbound side effects (e.g. "handle my email but add guardrails
  before anything goes out", "don't let it touch my credentials"). The skill
  proposes a guardrail posture, REQUIRES human approval before enforcing, then
  connects and verifies enforcement with a canary.
---

# OpenGuardrails (OGR)

You are wiring an agent — possibly yourself — to an OGR runtime. Since
protocol v0.8 the model is simple: a plugin (or two hand-rolled POSTs) sends
every model call's request and response to `POST /v1/evaluate`; the runtime
answers `allow` or `block`; **policy lives in the runtime, selected by the
agent's workspace** — there is no local policy file and no SDK. Follow the
flow below in order. Do not skip the approval gate.

## Your two roles

- **agent-as-tool** — you USE OGR to govern: connect an integration, propose
  the posture, verify enforcement.
- **agent-as-subject** — you RUN UNDER OGR: actions are judged as you act. On
  a block, read the verdict's `findings` (category + masked subject) and tell
  your operator; to change the rules, propose a change and route it through
  them. You cannot quietly loosen the policy that governs you.

## The non-negotiable rule

1. **A human approves the posture before it enforces.** You may draft and
   propose; you may NOT switch an agent to `fail_mode: closed`, change its
   workspace, or enable auto-approval behavior your operator has not seen.
2. **Enforcement must sit outside your control.** The verdict comes from the
   runtime; the block happens in the plugin/hook layer your task loop cannot
   mutate. If the only integration point available is code you can rewrite
   mid-task, say so — do not claim the agent is guarded.

## Flow: survey → connect → propose → confirm → verify → operate

### 1. Survey the task surface

From the task you were given, identify what the agent will touch: which
tools, which files/secrets, which network hosts, which outbound side effects
(email, posting, deploying). This becomes the posture you propose in step 3.

### 2. Pick and connect the integration

Every integration needs the same four things: the runtime URL, an org API
key, the identity five-tuple, and a fail mode. Set them as environment:

```bash
export OGR_RUNTIME_URL=https://ogr.example.com   # the runtime's base URL
export OGR_API_KEY=ogr_...                       # org key (ask the operator)
export OGR_AGENT_ID=invoice-bot                  # WHICH agent (org-unique)
export OGR_AGENT_TYPE=claude-code                # what kind — a label
export OGR_AGENT_WORKSPACE=finance-agents        # the policy set it runs under
export OGR_AGENT_OWNER=payments-team             # who answers for it
export OGR_AGENT_USER=u-8232                     # who drives it this session
export OGR_FAIL_MODE=open                        # open (default) | closed
```

Integrations ship in the spec repo (`integrations/` — install from source,
each README has the steps): hooks for Claude Code, Codex, opencode, OpenClaw;
in-loop plugins for Hermes, LangGraph, litellm, dsh; gateways (Higress,
mitmproxy) when you'd rather guard the traffic path. An agent you are
building yourself needs no plugin at all — two POSTs per model call; copy
`examples/minimal-agent/` from the repo.

### 3. Propose the posture

Write the operator a short plan:
- the five-tuple values you intend to assert (workspace = which policy set);
- `fail_mode`: `open` (runtime outage → agent keeps working, steps recorded
  unjudged) or `closed` (outage → gated actions pause) — recommend `closed`
  only when the task touches secrets, money, or outbound side effects;
- what the runtime should gate for this task (in taxonomy terms:
  `security.cmd.*`, `security.secret_leak`, `safety.*`, …) — the operator
  applies this in the runtime console; you cannot and must not.

### 4. CONFIRM with the operator — the gate

Show the plan and wait for explicit approval. If they edit it, show the
updated plan and ask again.

### 5. Verify enforcement with canaries

```bash
scripts/verify.sh          # health → benign canary (expect allow)
                           # → exfil canary  (expect block if gated)
```

The script sends a benign `step/request` (must come back `allow`) and a
`step/response` whose tool call reads like credential exfiltration (must
come back `block` **if** the workspace gates it). Report the result
honestly: "connected, exfil canary blocked" or "connected, but the exfil
canary was ALLOWED — the workspace does not gate it; ask the operator to
tighten the runtime policy before relying on this".

### 6. Operate under the policy

- On a **block**, surface the verdict's findings to the operator; do not
  route around it (rephrasing a blocked command is routing around it).
- If the task genuinely needs more, propose a specific change and go back
  to step 4. Never silently widen a live posture.

## The model (for reference)

One model call = one step = two events sharing a minted `step_id`:
`step/request` (the raw provider request body) before the call,
`step/response` (the raw response, tool calls still unexecuted) after. Nine
required fields, nothing optional; the five-tuple's empty string means "no
assertion" and the API key becomes the identity floor. The runtime derives
sessions and turns; the verdict is `allow`/`block` plus findings, redaction
spans, and `unjudged` (what it could not look at — which fail-closed treats
as a block). Full cheat sheet: `reference/wire.md`.

## Links

- Wire cheat sheet: `reference/wire.md`
- Spec + integrations + minimal example: https://github.com/openguardrails/openguardrails
- Docs: https://openguardrails.com/api/docs/ (quickstart is the minimal integration)
