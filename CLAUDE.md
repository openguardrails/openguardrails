# OpenGuardrails repository instructions

This is a monorepo. Run commands from the repository root unless a component
README explicitly says otherwise.

`packages/python` (`openguardrails`) and `packages/javascript`
(`@openguardrails/core`) are the two language implementations of the OGR core
runtime. Python integrations depend on the Python core; JavaScript/TypeScript
integrations depend on the JS core. Users normally install an integration and
receive its core dependency automatically. Self-contained marketplace plugins
may bundle the core and require no separate runtime install.

OGR supports three integration points: agent hooks, gateway hooks, and sandbox
hooks. All bindings and runnable integration examples belong under
`integrations/`; a gateway implementation is not an OGR-operated service.
`integrations/gateway/openai-anthropic` demonstrates OpenAI/Anthropic gateway-hook integration.
Standalone Anthropic srt and NVIDIA OpenShell sandbox-hook examples are planned.
The fourth directory category, `integrations/ebpf`, holds kernel-level
integrations. `integrations/ebpf/sensor` is the native OGR eBPF reference
implementation (a CO-RE kernel program under `bpf/` plus a userspace PEP in
`src/openguardrails_ebpf/`). Such integrations must map their events to an OGR
observation point (`sandbox`) rather than inventing a separate wire contract.

## Validation

- JavaScript/TypeScript: `npm ci && npm run build && npm test`
- Python tests: `python -m pytest` and
  `python integrations/agent/langgraph/tests/test_smoke.py`
- Release workflows: run `actionlint` against `.github/workflows/*.yml`

## Publishing packages

Publishing uses GitHub Actions Trusted Publishing with OIDC. Never add an npm
or PyPI write token to the repository, workflow, or GitHub secrets.

Only protected release tags may trigger publishing. There is intentionally no
`workflow_dispatch` publishing entry point. Before tagging:

1. Change the version in the selected `package.json` or `pyproject.toml`.
2. Update the relevant changelog or release notes.
3. Merge the change into `main` and wait for CI to pass.
4. Tag that exact commit. The workflow rejects a tag whose version differs
   from the package metadata.

### npm

Workflow: `.github/workflows/publish-npm.yml`
GitHub Environment: `npm`

| Tag | npm package |
|---|---|
| `js-vX.Y.Z` | `@openguardrails/core` |
| `openclaw-vX.Y.Z` | `openguardrails-instrumentation-openclaw` |
| `opencode-vX.Y.Z` | `openguardrails-instrumentation-opencode` |

`integrations/agent/claude-code` and `integrations/agent/codex` are private npm workspaces.
They use npm for builds and tests but are distributed as marketplace plugins;
do not publish them to npmjs.

### PyPI

Workflow: `.github/workflows/publish-pypi.yml`
GitHub Environment: `pypi`

| Tag | PyPI project |
|---|---|
| `python-vX.Y.Z` | `openguardrails` |
| `gateway-vX.Y.Z` | `openguardrails-gateway` |
| `hermes-vX.Y.Z` | `openguardrails-instrumentation-hermes` |
| `langgraph-vX.Y.Z` | `openguardrails-instrumentation-langgraph` |

Example after version `0.1.3` is merged into `main`:

```bash
git switch main
git pull --ff-only
git tag python-v0.1.3
git push origin python-v0.1.3
```

Approve the pending deployment in the matching GitHub Environment, then verify
the package and provenance on npmjs or PyPI. Never reuse a version that already
exists on the registry.
