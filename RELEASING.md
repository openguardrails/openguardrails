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
gateway pulls as an **OCI artifact**, so it publishes to a registry instead —
`docker.io/openguardrails/higress`.

⚠️ **It is the one exception to the rule above**, and the exception is deliberate.
GHCR would have kept it: the workflow can push there with its own `GITHUB_TOKEN`
and no stored credential at all. But a GHCR package created by Actions is PRIVATE
until a human flips it in the package settings UI — there is no REST endpoint for
that — and a registry reference an operator's gateway cannot pull anonymously is
not a release. Docker Hub is where someone configuring a gateway looks, and an
anonymous pull works the moment the push does.

So this one release needs two repository secrets, `DOCKERHUB_USERNAME` and
`DOCKERHUB_TOKEN`. The token must be a Docker Hub **access token** scoped Read &
Write to that one repository, never an account password, and it is the only
long-lived registry credential in this repo. Missing secrets fail the publish job
loudly rather than skipping it: a tag with no artifact behind it is worse than a
red run.

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
