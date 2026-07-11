---
name: openguardrails
description: >-
  Install and operate OpenGuardrails (OGR) to guardrail an agent. Use this when
  the operator asks to add guardrails, run safely/sandboxed, or restrict what an
  agent may do to files, secrets, network, or outbound side effects (e.g. "handle
  my email but add guardrails before anything goes out", "run this in a sandbox",
  "don't let it touch my credentials"). The skill drafts a policy, REQUIRES human
  approval before enforcing, then enforces it for the session.
---

# OpenGuardrails (OGR)

You are using OGR to guardrail an agent — possibly yourself. OGR is built to be
operated by an agent: **you draft the policy, your operator approves it, the runtime
enforces it.** Follow the flow below in order. Do not skip the approval gate.

## Your two roles

- **agent-as-tool** — you USE OGR to govern: install, author policy, enforce, verify.
- **agent-as-subject** — you RUN UNDER OGR: actions are allowed / denied / held for
  approval. On a block, read the verdict reason. To change the rules, propose a policy
  edit and route it back through your operator.

## The non-negotiable rule

1. **A human approves before a policy goes live.** You may draft and propose. You may
   NOT enforce a policy your operator has not seen and approved. Editing a live policy
   re-triggers this gate.
2. **Enforcement must sit outside your control.** OGR checks run in a layer your task
   loop cannot mutate (the runtime's sandbox/hook). If your runtime cannot guarantee
   that, say so to the operator — do not claim the agent is guarded.

If you cannot satisfy both, stop and tell the operator.

## Flow: install → draft → confirm → enforce

### 1. Understand the task and its surface
Identify, from the task you were given, what the agent will touch:
- which **tools** it needs, which it must never call
- which **files / paths** are in scope; which secrets must stay unreadable
- which **network hosts** it legitimately needs (deny everything else)
- which **outbound side effects** (sending email, posting, deploying) need approval

### 2. Install the OGR plugin for the runtime
Detect the runtime and install. Examples:
- **Hermes (Python):** `pip install openguardrails-instrumentation-hermes`
- **opencode (JS/TS):** add `openguardrails-instrumentation-opencode` (plugin)
- Other runtimes: see `reference/policy-schema.md` and the spec link below.

### 3. Draft a policy
Generate a starting `ogr.policy.json`, then tighten it to the task:
```
python3 scripts/draft_policy.py --task "<one line describing the task>" --out ogr.policy.json
```
This emits a resource-based starter (deny-by-default network, secret paths blocked,
outbound side effects set to `require_approval`). Edit it for the specific task —
prefer **resource-based** rules (match the path/host) over verb-based ones, so a
rephrased command can't slip past. Full schema: `reference/policy-schema.md`.

### 4. CONFIRM with the operator — the gate
Show the operator the **full policy** and a plain-language summary:
> Here is the policy I will enforce: <what's allowed / denied / needs approval>.
> Reply "approve" to enforce it, or tell me what to change.

**Wait for explicit approval. Do not proceed without it.** If the operator edits the
policy, show the updated version and ask again.

### 5. Enforce
After approval:
```
source scripts/enforce.sh ogr.policy.json    # sets OGR_POLICY, enables the sandbox
```
or set directly: `export OGR_POLICY=./ogr.policy.json` and `export OGR_SANDBOX=srt`
(personal) / your container backend (multi-tenant). Every subsequent action is now
checked at the agent hook and the sandbox boundary.

### 6. Operate under the policy
- On a **block** / **require_approval**, surface the verdict `why` to the operator;
  do not try to route around it.
- If the task genuinely needs more than the policy allows, **propose** a specific
  policy edit and go back to step 4. Never silently widen a live policy.

## The model (for reference)
- Every action → a **GuardEvent**; a detector returns a **Verdict** (`allow` /
  `block` / `require_approval`) with a `why`.
- **Provenance** travels with the action (trusted vs untrusted input) — OGR catches
  *untrusted input → privileged action*, not just bad strings.
- Three altitudes correlated by `guard_id`: gateway, agent hook, sandbox.
- Detectors **compose**: deny-wins or quorum. Same policy model compiles to srt
  (personal) or OpenShell (multi-tenant) — different policy per threat model.

## Verify coverage (optional)
Run the neutral benchmark to check what your policy/detectors catch:
`https://github.com/openguardrails/openguardrails/tree/main/benchmarks` → `python3 benchmarks/harness/run.py`.

## Links
- Policy reference: `reference/policy-schema.md`
- Agent guide: https://openguardrails.com/agent/
- Spec: https://github.com/openguardrails/openguardrails
- Runnable PoC (Hermes + sandbox): https://github.com/openguardrails/openguardrails-poc
