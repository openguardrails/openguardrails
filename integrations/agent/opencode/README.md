# @openguardrails/opencode-auto-mode

**Auto mode for [opencode](https://github.com/anomalyco/opencode).**

Whatever your opencode `permission` config would ask you — bash commands,
edits, webfetch — this plugin answers from
[OpenGuardrails (OGR)](https://www.npmjs.com/package/@openguardrails/core)
policy instead: **your own guardrails** (plain text + regex rules, no model
required, optionally your own model as the judge) grant or refuse each
prompt, and only the asks the runtime cannot decide still reach you.

Enforced as a pure opencode plugin — **no core changes, no fork**.

Installation is one config edit — opencode installs plugins listed in its
config by itself on the next start:

```jsonc
// opencode.json (or the global ~/.config/opencode/opencode.json)
{
  "plugin": ["@openguardrails/opencode-auto-mode"],
  // auto mode answers whatever you tell opencode to ask about:
  "permission": { "bash": "ask", "edit": "ask", "webfetch": "ask" }
}
```

The package brings `@openguardrails/core`, the JavaScript OGR core runtime,
as a dependency. Auto mode is **on by default** — it is the point of the
package.

## How it works

Two hooks, one engine:

**`tool.execute.before`** — every tool call becomes an OGR `GuardEvent` and is
judged *before it runs*, on every call, whether or not a permission prompt
would fire:

| OGR decision | opencode behavior |
| --- | --- |
| `allow` / `modify` / `redact` | proceed |
| `block` | throw → the agent sees a tool error and must find a safer path |
| `require_approval` | throw → asks the agent to have you re-run intentionally or relax the policy |

**`permission.ask`** — opencode's own permission prompt, the human gate. Auto
mode answers it with the runtime's verdict:

| Runtime verdict | Prompt outcome |
| --- | --- |
| `allow` / `modify` / `redact` | `allow` — you are never prompted |
| `block` | `deny` |
| `require_approval`, evaluation failed, or nothing to judge | *undecided* — see below |

*Undecided* follows `auto.unresolved`: `human` (default) leaves the prompt
exactly as opencode raised it, so you still see the genuinely ambiguous asks;
`reject` denies them — the strict stance for headless runs where no human
will ever answer.

The ask links back to the already-evaluated call through its `callID`, which
both events carry as their OGR `guard_id` — the runtime can only **tighten**
the earlier decision, never loosen it. An ask with no correlated call falls
back to the permission's own metadata (opencode's bash asks carry the
command there); an ask with neither stays undecided — a guard does not grant
what it cannot see.

This stays a **restrict-only** guard toward the agent: auto mode automates
*your* seat at the prompt, with your own policy — it never overrides an OGR
verdict, and a `block` stays blocked everywhere.

## Configure your guardrails

Drop an OGR policy at **`.opencode/guardrails.json`** (the agent can write/edit
this itself), or pass it inline as plugin options. A sensible default ships in
the package (`curl|bash`, `rm -rf /`, credential-file access, `| sudo`).

```json
{
  "composition": { "security.*": { "strategy": "deny-wins", "on_all_failed": "block" } },
  "config_rules": {
    "command_rules": [
      { "id": "no-prod-deploy", "regex": "deploy\\s+--env\\s+prod",
        "category": "security.malicious_command", "decision": "require_approval",
        "score": 0.9, "why": "production deploys need explicit human approval" }
    ]
  },
  "auto": { "enabled": true, "unresolved": "human" }
}
```

The policy format is identical across every OGR integration (dsh, openclaw,
hermes, python), so one `policy.json` works everywhere. `auto` may live in the
policy file (as above) or in plugin options; options win.

`decision: "require_approval"` is the rule author's "this one is for a human":
under auto mode it is exactly the class of prompt that still reaches you.

### Use your own model as the judge

```json
{
  "config_rules": { "command_rules": [] },
  "judge": { "baseURL": "https://api.openai.com/v1", "model": "gpt-4o-mini", "apiKey": "sk-..." }
}
```

Any OpenAI-compatible chat endpoint works — point it at the same model your
agent uses, or a dedicated guard model. The judge weighs provenance and the
ask's own descriptors, and returns an OGR verdict; the deterministic
text/regex rules remain the baseline.

## Status

`v0.2`. Auto mode via `permission.ask` + guard engine via
`tool.execute.before`, correlated by `callID`. Transcript-based provenance
tainting (web/mcp results → `untrusted`, so injection-influenced asks get
denied rather than granted) is the tracked follow-up via the opencode session
API — the dsh integration ([`@openguardrails/dsh-auto-mode`](../dsh/)) already
does this. Published before `v0.2` as `openguardrails-instrumentation-opencode`.
