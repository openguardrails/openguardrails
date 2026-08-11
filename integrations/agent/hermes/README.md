# openguardrails-instrumentation-hermes

Guard a [Hermes](https://github.com/NousResearch/hermes-agent) agent **and its
sandbox** through the [OpenGuardrails (OGR)](https://pypi.org/project/openguardrails/)
protocol. One `policy.json` enforces across three altitudes — correlated by
`guard_id` and provenance.

```bash
pip install openguardrails-instrumentation-hermes
```

(pulls in `openguardrails`, the zero-dependency reference runtime.)

Installing the Python package does **not** activate a Hermes plugin by itself.
Hermes discovers plugins from `$HERMES_HOME/plugins` (normally
`~/.hermes/plugins`) and the plugin must be enabled:

```bash
# Development checkout of the OpenGuardrails repository
python -m pip install -e integrations/agent/hermes
mkdir -p "${HERMES_HOME:-$HOME/.hermes}/plugins"
ln -sfn "$PWD/integrations/agent/hermes/src/openguardrails_instrumentation_hermes" \
  "${HERMES_HOME:-$HOME/.hermes}/plugins/ogr-guard"
hermes plugins enable ogr-guard
hermes plugins list
```

Run these commands from the OpenGuardrails repository root, then restart
Hermes. This plugin is used for in-process enforcement; Session/Run/Turn
reconstruction at the external gateway does not depend on the client plugin.

## Why a plugin, not a proxy

Hermes already exposes the interception points OGR needs, so no proxy and no core
patching is required for 3 of the 4 altitudes:

| OGR altitude | Hermes surface | Enforce? | Sees |
| --- | --- | --- | --- |
| `conversation` (LLM I/O) | `pre/post_api_request` hooks | decide | full prompt + completion |
| `conversation` (answer) | `transform_llm_output` hook | **withhold / redact** | the turn's final answer |
| `invocation` (tool lifecycle) | `pre_tool_call` hook | **block** | tool name + args, pre-dispatch |
| provenance + result verdict | `post_tool_call` hook | taint / decide | tool results (web/mcp → untrusted) |
| `invocation` (tool result) | `transform_tool_result` hook | **withhold / redact** | the result, before it becomes context |
| `execution` (real exec) | wraps `BaseEnvironment.execute` | **block** | real `argv` + secret env keys + cwd |

Content enforcement takes two hooks because Hermes splits them: it **discards**
what `pre/post_api_request` return (`agent/conversation_loop.py` invokes them for
effect only), so those decide, and `transform_llm_output` — whose returned string
replaces the answer — withholds. Between 2026-07-22 and 2026-07-26 only the first
half existed, so a moderation / off-topic block was recorded in the console and the
answer still reached the user.

What the user gets instead is one sentence, and it is **yours to write**: set
`OGR_REFUSAL_TEXT` (e.g. `抱歉，我只能回答本行业务相关的问题。`). The default says
nothing about why — the verdict's reasons are the tenant's own rule text, written
for the judge, and its categories are taxonomy ids; both belong in the audit log and
the console, not in front of an end user who would also learn what to route around.

### Reporting reliability

Three ways a GuardEvent used to disappear between the hook and the console, all
silent, all fixed 2026-07-26:

- **the exit drain** — the reporter batches on a daemon thread with a 2s timer, so a
  one-shot process (`hermes -z`, a kanban worker) exited with the queue still full.
  `PlatformReporter.flush()` now runs at `atexit` and is callable directly, which is
  also what tests and short scripts should use instead of sleeping;
- **`user_message` is not always a `str`** — a multimodal or decorated turn arrives as
  a list of content parts, and requiring a string dropped the whole user turn. The
  bridge flattens the parts, and audits a genuinely empty one rather than skipping in
  silence;
- **`run_id` overflowed the wire** — it is derived from Hermes' turn_id, which reaches
  68 characters when task_id is a UUID, and the schema caps it at 64. Ingest 400'd
  that one event per turn (`run_id: Too big`) with the only trace a warning in
  `~/.hermes/logs/errors.log`. Long ids now keep a readable prefix plus a digest of
  the whole turn_id, so two runs of one session can never collapse together.

`/evaluate` carries the same `run_id`/`turn` stamp as the fire-and-forget report — an
unstamped call makes the runtime derive a run of its own, which split each turn's
user_input and model_output across two runs in the console.

### `redact`

A `redact` verdict carries `modifications.spans` the enforcement point is meant to
APPLY; counting it as "allowing" ships the exact value it names, which is what this
plugin did until 2026-07-26. Now:

- **answer** and **tool result** — the spans are applied and the content goes on with
  `${OGR_PHONE_1}`-style placeholders in place of the values. Offsets index into the
  string the runtime scored, so when Hermes hands over a different one (the finalizer
  can append to an answer) the values are recovered from the judged text and replaced
  by value, longest first;
- **tool call** — degraded to a **block**, because `pre_tool_call` can only block or
  escalate, never rewrite arguments. The block message says to strip the value and
  retry, which is the action a redact on an action was reaching for;
- **unfulfillable** (no spans, or the value is nowhere in the text) — the content is
  withheld, never passed through. A redact that applies to nothing must not read as
  "redacted".

`OGR_REDACT_MASK` swaps the placeholder for a flat string (`[已隐去]`) when the output
is customer-facing; the default keeps the placeholder, whose `ref` is stable per value
so two mentions of one number read as one number.

⚠️ A content guardrail that judges `model_output` will judge what your agent
legitimately says. A customer-service bot naming its own hotline trips
`privacy.pii.phone_number`; naming its own company trips
`privacy.pii.organization`. Point the privacy guardrail at the egress surfaces
(`tool_call`, `tool_result`) in the console rather than switching classes off one by
one — that is the distinction it exists to make.

Only the execution altitude needs a wrapper, because Hermes has **no**
environment-level hook. It is installed from `register()`, is idempotent, and
**fails open** if Hermes' layout differs.

## Install into a real Hermes

```python
# in a Hermes plugin entrypoint:
from openguardrails_instrumentation_hermes import register
register(ctx)   # binds the 4 hooks + installs the execution wrapper
```

Or drop the bundled `plugin.yaml` into a Hermes plugin dir. Override the policy
with `OGR_POLICY=/path/to/policy.json`; a Hermes-tuned default ships inside the
package.

## Hermes' own "sandbox" concept (not the same thing as OGR's `execution` altitude)

Confusingly close names, different axes: OGR's `execution` altitude is
*which layer* got observed; what follows is Hermes' *own* terminology for
*which isolation technology* runs the command. This section, `OGR_SANDBOX`,
and the `sandbox.*` module names below are Hermes/this-plugin's own
vocabulary, not OGR protocol concepts — nothing here was renamed alongside
the OGR altitude rename.

There is **no syscall sandbox** by default. "Sandbox" = a pluggable `Environment`
backend: `local` = `subprocess.Popen` **on the host** (zero isolation, the
default), `docker` = `docker exec` into a container, plus Modal/SSH/Daytona. All
funnel through the one `BaseEnvironment.execute()` chokepoint we wrap.

Pick the OS-level enforcement backend with `OGR_SANDBOX`:

| `OGR_SANDBOX` | Scenario | Enforcement |
| --- | --- | --- |
| `argv` (default) | quick start | OGR decision only — no OS isolation |
| `srt` | **personal** (one laptop, no Docker) | [Anthropic Sandbox Runtime](https://github.com/anthropic-experimental/sandbox-runtime): `sandbox-exec`/`bubblewrap` enforces the real syscall boundary |
| OpenShell (gateway) | **multi-tenant** (shared fleet) | container + OPA/Rego egress proxy + gateway credential injection |

The same OGR `sandbox` policy block compiles to **both** backends — see
`openguardrails_instrumentation_hermes.sandbox.srt` and `.sandbox.openshell`.

### No sandbox? OGR degrades, it doesn't fail.

With `local` there is no isolation boundary, so the only **enforcement** altitude
is `pre_tool_call` (inspect argv *before* exec and block). You keep policy,
provenance, and conversation-altitude detection — but lose the adversary-proof
view, so a clever agent can obfuscate argv past the intent check. Run tools
under `srt`/`docker` so the OGR `execution` altitude exists and closes that
blind spot.

## Run the self-test (no Hermes install needed)

```bash
python -m openguardrails_instrumentation_hermes.selftest
```

Drives four scenarios through the real hook signatures: benign / injection-blocked
/ same-command-trusted / defense-in-depth.

## Status

`v0.1`. Verified against real Hermes (2026-06-28): all four hooks bound, benign
commands executed, credential reads and untrusted-origin `curl | bash` blocked at
the altitude that saw them first.

## Platform reporting with an enrolled identity (optional)

Set `OGR_RUNTIME_URL` + `OGR_API_KEY` and the plugin also ships every
GuardEvent to an OpenGuardrails runtime — fire-and-forget, local enforcement
stays authoritative. `OGR_RUNTIME_URL` is the deployment's base URL: the SDK
client speaks the canonical `/v1/*` API paths and falls back to the legacy
`/api/public/ogr` mount automatically on older runtimes. On first use it
enrolls a per-instance Ed25519 key (`POST /v1/enroll`, the API key is the
bootstrap token) and signs each batch with `OGR-Batch-Signature`, so the
runtime records this instance's identity at its enrollment scope instead of
an unverified claim (spec: `specification/attestation.md`).

Hermes is the "many instances per machine" case: name each one with
`OGR_INSTANCE` (default `default`). The instance asserts
`subject.agent_id = hermes-<instance>` and appears as its own Agent in the
console. `OGR_KEYFILE` overrides the keypair path
(`~/.ogr/hermes-<instance>-ed25519.json`), `OGR_PRINCIPAL` the principal
(default `user:<login>`).
