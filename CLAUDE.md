# OpenGuardrails repository instructions

**This repository is the product: AI agent guardrails for every builder.** `cli/` is the `openguardrails`
command (local rules, local OGR service, sandbox, firewall, gateway). The enterprise product, AIRS, is
closed source and lives elsewhere. Priority agents are Hermes, OpenClaw and DeepSeek Harness, tested
with `cli/experiments/run.sh`, because a mock of a harness has repeatedly hidden what the real one does.

⚠️ The local gateway is the only connection and is where masking and judging live for builders. There
are no agent plugins: a plugin sees only what its harness shows it, and tested, Hermes's side requests
and all of OpenClaw 2026.6's model traffic went around plugin masking. Every request passes through
the gateway.

⚠️ A security risk is refused and alerted, never sent to a person to approve. Approval is for a choice
that belongs to the person and is not a risk. `needs_decision` must never mean "could not tell".

⚠️ A rule may allow only what it fully understands and only what stays on the machine. Whatever it
cannot parse, and every tool it does not know, goes to the model.

Run commands from the repository root unless a component README explicitly says otherwise.

## No published protocol (since 2026-11-03)

The OGR wire protocol (last v1.10: `specification/`, `schema/`, the Runtime API) is no longer
published, and its documents, plugins, bridge and examples were removed; they remain in the git
history. What is published is the command and the benchmark.

- **Detection moves to `/v1/openguardrails`**, one detection API that builders and AIRS share. It is
  not a management API: rules, keys, approvals and fleets go through each product's own management
  API. Its reference will be published with the service. Until then the command calls `/v1/judge`
  (`cli/src/model-api.ts`).
- **`/v1/evaluate` keeps working.** AIRS serves it, translated to `/v1/openguardrails`, for every
  existing deployment, and it stays frozen: no new fields. AIRS's own schema is its contract.
- **The one integration left is `integrations/gateway/higress`**, which speaks `/v1/evaluate` to AIRS.
  Do not add plugins back to make an agent work; make the gateway work for it.

## Layout

| Path | What it is |
|---|---|
| `cli/` | The `openguardrails` command. Its own npm package and lockfile; there is no root workspace |
| `benchmarks/` | The public evaluation: corpora, harness and leaderboard |
| `integrations/gateway/higress/` | The Higress WASM plugin, "OpenGuardrails AIRS" in the Higress console |
| `artifacts/` | Recorded test runs worth keeping |

## Language

This repository is **English-only**. That covers source, docs, comments, the
CHANGELOG — and equally **commit messages and pull request titles/bodies**.
It is a public repo: outside readers read the history as well as the files.
Discuss the work in whatever language you like; nothing written into the repo follows.

The one exception is a CJK **test fixture** that exists to exercise
multibyte/UTF-8 behaviour — `integrations/gateway/higress/redact_test.go`
(`TestOffsetsAreCharactersNotBytes`) and `tailhold_test.go` (a byte budget
spent on 3-byte chunks) go vacuous in ASCII. Their comments stay English, and
each says why the literal is there.

## Validation

- The command: `cd cli && npm install && npm test`
- Benchmarks: `python -m pip install pytest && python -m pytest`
- Higress plugin: `cd integrations/gateway/higress && gofmt -l . && go vet ./... && go test ./...`
  (wasm compile check: `GOOS=wasip1 GOARCH=wasm go build -buildmode=c-shared -o plugin.wasm .`)
- Release workflows: run `actionlint` against `.github/workflows/*.yml`

## Publishing

Only protected release tags may trigger publishing; there is intentionally no
`workflow_dispatch` publishing entry point. The one publishable artifact is
the Higress plugin (`higress-vX.Y.Z` → `docker.io/openguardrails/higress`,
OCI artifact; see `RELEASING.md` for why Docker Hub and which secrets).
Never add an npm or PyPI write token to the repository, workflows, or GitHub
secrets.
