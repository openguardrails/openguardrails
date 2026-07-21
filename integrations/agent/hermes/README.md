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
| `gateway` (LLM I/O) | `pre/post_api_request` hooks | observe | full prompt + completion |
| `agent_hook` (tool lifecycle) | `pre_tool_call` hook | **block** | tool name + args, pre-dispatch |
| provenance | `post_tool_call` hook | taint | tool results (web/mcp → untrusted) |
| `sandbox` (real exec) | wraps `BaseEnvironment.execute` | **block** | real `argv` + secret env keys + cwd |

Only the sandbox altitude needs a wrapper, because Hermes has **no**
environment-level hook. It is installed from `register()`, is idempotent, and
**fails open** if Hermes' layout differs.

## Install into a real Hermes

```python
# in a Hermes plugin entrypoint:
from openguardrails_instrumentation_hermes import register
register(ctx)   # binds the 4 hooks + installs the sandbox wrapper
```

Or drop the bundled `plugin.yaml` into a Hermes plugin dir. Override the policy
with `OGR_POLICY=/path/to/policy.json`; a Hermes-tuned default ships inside the
package.

## What Hermes calls a "sandbox" (and which to use)

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
provenance, and gateway detection — but lose the adversary-proof view, so a clever
agent can obfuscate argv past the intent check. Run tools under `srt`/`docker` so
the `sandbox` altitude exists and closes that blind spot.

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
stays authoritative. On first use it enrolls a per-instance Ed25519 key
(`POST /enroll`, the API key is the bootstrap token) and signs each batch
with `OGR-Batch-Signature`, so the runtime records this instance's identity
at its enrollment scope instead of an unverified claim
(spec: `specification/attestation.md`).

Hermes is the "many instances per machine" case: name each one with
`OGR_INSTANCE` (default `default`). The instance asserts
`subject.agent_id = hermes-<instance>` and appears as its own Agent in the
console. `OGR_KEYFILE` overrides the keypair path
(`~/.ogr/hermes-<instance>-ed25519.json`), `OGR_PRINCIPAL` the principal
(default `user:<login>`).
