# Releasing packages

OpenGuardrails publishes from GitHub Actions with npm and PyPI Trusted
Publishing. No long-lived registry token is stored in GitHub.

## Release tags

| Tag | Package source |
|---|---|
| `js-vX.Y.Z` | `packages/javascript/` |
| `openclaw-vX.Y.Z` | `integrations/agent/openclaw/` |
| `opencode-vX.Y.Z` | `integrations/agent/opencode/` |
| `python-vX.Y.Z` | `packages/python/` |
| `gateway-vX.Y.Z` | `integrations/gateway/openai-anthropic/` |
| `hermes-vX.Y.Z` | `integrations/agent/hermes/` |
| `langgraph-vX.Y.Z` | `integrations/agent/langgraph/` |
| `higress-vX.Y.Z` | `integrations/gateway/higress/` |

The workflow rejects a tag when its version does not exactly match the version
in the selected `package.json`, `pyproject.toml`, or — for the Higress plugin —
`VERSION`.

The Higress plugin is not an npm or PyPI package: it is a WASM binary that a
gateway pulls as an **OCI artifact**, so it publishes to a registry instead.
`ghcr.io/openguardrails/higress` is the primary, pushed with the workflow's own
`GITHUB_TOKEN` — no long-lived credential, same principle as Trusted Publishing.
A Docker Hub mirror (`docker.io/openguardrails/higress`) is pushed **only if**
`DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` are set on the repository; without them
the step is skipped with a notice rather than failing the release.

The Claude Code and Codex integrations are private npm workspaces used for
local dependency management, builds, and tests. They are distributed through
their plugin marketplaces, not npmjs, and must not be published with
`npm publish`.

## Publish a release

1. Update the package version and changelog in a pull request.
2. Merge the pull request into `main` and wait for CI to pass.
3. Tag that exact commit and push the tag. For example:

   ```bash
   git switch main
   git pull --ff-only
   git tag python-v0.1.3
   git push origin python-v0.1.3
   ```

4. Approve the deployment in the corresponding `npm` or `pypi` GitHub
   Environment.
5. Verify the published files and provenance on the registry.

The npm workflow builds and tests the selected workspace, packs it, then
publishes the tarball. The PyPI workflow builds and validates a wheel and source
distribution before publishing them. Only the final publish jobs receive
`id-token: write`.
