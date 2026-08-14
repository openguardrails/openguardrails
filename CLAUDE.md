# OpenGuardrails repository instructions

This is a monorepo. Run commands from the repository root unless a component
README explicitly says otherwise.

**Protocol version: v0.7 — the ledger model** (Session / Turn / Step / Call,
one observed plane: LLM messages). The design rationale lives in
`../openguardrails-runtime/docs/v0.7-ledger-redesign.md`; the normative text
lives here in `specification/` + `schema/`. Read
`specification/overview.md` first.

The repo is layered **API → Plugin** — there is deliberately NO SDK layer
(retired in v0.7, decided 2026-08-14). The API layer is the normative Runtime
API binding (`specification/runtime-api.md`: `/v1/evaluate`, `/v1/ingest`,
heartbeat, health) plus the JSON Schemas in `schema/` (GuardEvent, Verdict).
The plugin layer is everything under `integrations/` — each plugin speaks the
API directly (two POST calls); new endpoints or wire fields belong in the
spec first. The two normative integration recipes (agent-direct: declares
session/turn/step and reports turn ends; gateway: mints step_id, declares
nothing, runtime derives) are IN the runtime-api spec — a plugin implements
one of them, and its README says which.

OGR supports two integration points: agent-direct hooks and gateway hooks.
All bindings and runnable integration examples belong under `integrations/`;
a gateway implementation is not an OGR-operated service.

## Integration status (2026-08-14)

- `integrations/gateway/higress` — the v0.7 reference gateway integration
  (Go/WASM), the only CI-covered plugin.
- Everything else under `integrations/agent/` and the other gateway examples
  are **v0.6-stale**: they were built on the retired SDKs and await a v0.7
  rewrite (dsh first — it is the reference agent-direct integration). They
  are excluded from the npm/uv workspaces and from CI; do not "fix" one by
  re-adding an SDK.

## Validation

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
