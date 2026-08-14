# Monorepo migration

OpenGuardrails development is consolidated in
`openguardrails/openguardrails`. The component packages remain independently
versioned and published, but source changes, issues, pull requests, and CI are
centralized here.

## Repository mapping

(Paths marked † were retired in protocol v0.7 — the SDK layer and the
execution plane are gone; see [CHANGELOG.md](CHANGELOG.md).)

| Former repository | Monorepo path |
|---|---|
| `openguardrails-python` | `packages/python/` † |
| `openguardrails-js` | `packages/javascript/` † |
| `openguardrails-instrumentation-claude-code` | `integrations/agent/claude-code/` |
| `openguardrails-instrumentation-codex` | `integrations/agent/codex/` |
| `@openguardrails/dsh-auto-mode` | `integrations/agent/dsh/` |
| `openguardrails-instrumentation-hermes` | `integrations/agent/hermes/` |
| `openguardrails-instrumentation-langgraph` | `integrations/agent/langgraph/` |
| `openguardrails-instrumentation-openclaw` | `integrations/agent/openclaw/` |
| `@openguardrails/opencode-auto-mode` | `integrations/agent/opencode/` |
| `openguardrails-gateway` | `integrations/gateway/openai-anthropic/` |
| `openguardrails-bench` | `benchmarks/` |
| `openguardrails-examples` | `examples/` |
| `openguardrails-skill` | `skills/openguardrails/` |
| `openguardrails.com` | moved out again 2026-08-11 → private `openguardrails-website` repo (the site is not useful to protocol contributors) |

The `.github` repository remains separate because GitHub requires
`.github/profile/README.md` to render the organization profile.

## Rollout checklist

1. Merge and tag the monorepo baseline.
2. Point npm and PyPI trusted-publisher settings at
   `openguardrails/openguardrails`, using `publish-npm.yml` with the `npm`
   environment and `publish-pypi.yml` with the `pypi` environment.
3. Replace each former repository README with its new source path, then archive
   the repository. Do not delete it: old links, releases, and commit history
   should remain available.
4. Update the organization profile from the separate `.github` repository.
5. Route all new issues and pull requests to the monorepo.
