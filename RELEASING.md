# Releasing packages

OpenGuardrails publishes from GitHub Actions. No long-lived registry token is
stored in GitHub except the one Docker Hub exception below.

The v0.6 npm/PyPI SDK packages and the plugins built on them were retired in
v0.7 (the API is the integration surface — see the
[Runtime API binding](specification/runtime-api.md)). Their publish workflows
are gone; release tags return per integration as each is rewritten against
the v0.7 contract.

## Release tags

| Tag | Package source |
|---|---|
| `higress-vX.Y.Z` | `integrations/gateway/higress/` |

The workflow rejects a tag when its version does not exactly match the
version in the plugin's `VERSION` file.

The Higress plugin is not an npm or PyPI package: it is a WASM binary that a
gateway pulls as an **OCI artifact**, so it publishes to a registry —
`docker.io/openguardrails/higress`.

⚠️ **Docker Hub is deliberate.** GHCR could publish with the workflow's own
`GITHUB_TOKEN` and no stored credential — but a GHCR package created by
Actions is PRIVATE until a human flips it in the package settings UI (no REST
endpoint exists for that), and a registry reference an operator's gateway
cannot pull anonymously is not a release. Docker Hub is where someone
configuring a gateway looks, and an anonymous pull works the moment the push
does.

So this one release needs two repository secrets, `DOCKERHUB_USERNAME` and
`DOCKERHUB_TOKEN`. The token must be a Docker Hub **access token** scoped
Read & Write to that one repository, never an account password, and it is the
only long-lived registry credential in this repo. Missing secrets fail the
publish job loudly rather than skipping it: a tag with no artifact behind it
is worse than a red run.

## Publish a release

1. Update the plugin version and changelog in a pull request.
2. Merge the pull request into `main` and wait for CI to pass.
3. Tag that exact commit and push the tag:

   ```bash
   git switch main
   git pull --ff-only
   git tag higress-v0.5.0
   git push origin higress-v0.5.0
   ```

4. Verify the published artifact on the registry.
