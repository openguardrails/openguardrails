# OpenGuardrails repository instructions

This is a monorepo. Run commands from the repository root unless a component
README explicitly says otherwise.

**Protocol version: v0.8 — the minimum API** (one endpoint, one recipe;
everything derivable left the wire, everything producer-known is required).
The v0.7 design rationale lives in
`../openguardrails-runtime/docs/v0.7-ledger-redesign.md`; the normative text
lives here in `specification/` + `schema/`. Read
`specification/overview.md` first, then `specification/runtime-api.md` —
its "minimal integration" section is the canonical example and also ships
at `examples/minimal-agent/`.

The repo is layered **API → Plugin** — there is deliberately NO SDK layer
(retired in v0.7, decided 2026-08-14). The API layer is the normative Runtime
API binding (`specification/runtime-api.md`: `/v1/evaluate`, heartbeat,
health — `/v1/ingest` was removed in v0.8) plus the JSON Schemas in
`schema/` (GuardEvent, Verdict). The plugin layer is everything under
`integrations/` — each plugin speaks the API directly (two evaluate POSTs
per model call); new endpoints or wire fields belong in the spec first.
There is ONE integration recipe (in runtime-api.md) since v0.8: raw provider
bodies, a minted `step_id` per model call, the required identity five-tuple
(empty string = no assertion), no other coordinates, fail-open by default,
tail-hold streaming. A GuardEvent has zero optional fields.

OGR supports two integration points operationally: agent-direct hooks and
gateway hooks — same protocol, different vantage. All bindings and runnable
integration examples belong under `integrations/`; a gateway implementation
is not an OGR-operated service. `examples/minimal-agent/` is the runnable
form of the spec's minimal integration.

## Integration status (2026-08-15)

- `integrations/gateway/higress` — the v0.8 reference gateway integration
  (Go/WASM, CI-covered).
- `integrations/agent/dsh` (`@openguardrails/dsh`) — the v0.8 reference
  agent-direct integration (npm workspace, CI-covered). Its `src/wire.ts`
  is the canonical "hand-rolled evaluate POST" example.
- `integrations/agent/litellm` — v0.8 litellm callback integration
  (Python).
- All remaining integrations (hermes, langgraph, claude-code, codex,
  openclaw, opencode, mitmproxy, openai-anthropic) were rewritten against
  v0.8 on 2026-08-15 and are CI-covered: the Python ones through the root
  pytest testpaths (pyproject.toml), the JS hook plugins as standalone
  `npm test` suites (deliberately NOT npm-workspace members). Never "fix"
  an integration by re-adding an SDK.

## Validation

- Python (benchmarks + hermes/langgraph/litellm/mitmproxy/openai-anthropic):
  `python -m pip install pytest && python -m pytest`
- dsh plugin: `npm install && npm run build && npm test` (from the repo root)
- Hook plugins: `cd integrations/agent/<claude-code|codex|openclaw|opencode> && npm test`
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
