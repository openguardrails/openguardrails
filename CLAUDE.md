# OpenGuardrails repository instructions

This is a monorepo. Run commands from the repository root unless a component
README explicitly says otherwise.

**Protocol version: v1.8 (2026-09-16)**, on the wire v1.0 declared stable
(2026-08-19): the v0.8 "minimum API" unchanged (one endpoint, one recipe;
everything derivable left the wire, everything producer-known is required), plus
the **layer model** as the normative foundational concept (entity axis: tenant →
workspace → agent-as-endpoint; traffic stack: L6 session · L5 turn · L4 step ·
L3 event — the packet, the only layer on the wire — · L2 call · L1 exec).
Within 1.x changes are additive-optional only — 1.1 media · 1.2 obligations ·
1.3 mandate + `continuation` · 1.4 local redaction · 1.5 `initiator` ·
1.6 `llm_endpoint` · 1.7 grounding (DRAFT) · 1.8 `transport` + verdict `timing`.
⚠️ Each ships at the RUNTIME first: `.strict()` rejects unknown keys, so a
producer one version ahead is a 400 on every event it sends. The v0.7 design rationale
lives in `../openguardrails-airs/docs/v0.7-ledger-redesign.md`; the layer
model's full write-up in `../openguardrails-airs/docs/core-concepts.md`;
the normative text lives here in `specification/` + `schema/`. Read
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
bodies, a minted `step_id` per model call, the required identity FOUR-tuple
(empty string = no assertion), no other coordinates, fail-open by default,
tail-hold streaming. A GuardEvent has exactly three optional fields —
`integration`, `connection`, `session_hint` — and adding one is an
additive-optional spec change, never a required one.

Two configuration-only siblings sit beside the wire and never on it: the
**mandate** (1.3, `specification/mandate.md` — what an agent may DO) and the
**grounding profile** (1.7 draft, `specification/grounding.md` — what it may
CLAIM, resolved against a record provider). Verticals (healthcare, trading, IP,
life sciences) are informative mappings onto the neutral `safety.* / security.* /
privacy.*` ids — never a taxonomy axis; the domain rule catalogues live in
`proposals/domain-trust-ip-life-sciences.md`, the profiles and frozen record
worlds under `benchmarks/suites/safety/grounding_*`.

OGR supports two integration points operationally: agent-direct hooks and
gateway hooks — same protocol, different vantage. All bindings and runnable
integration examples belong under `integrations/`; a gateway implementation
is not an OGR-operated service. `examples/minimal-agent/` is the runnable
form of the spec's minimal integration.

## Language

This repository is **English-only**. That covers source, docs, comments, the
CHANGELOG — and equally **commit messages and pull request titles/bodies**.
It is a public open-standard repo: outside implementers read the history as
well as the files. Discuss the work in whatever language you like; nothing
written into the repo follows.

The one exception is a CJK **test fixture** that exists to exercise
multibyte/UTF-8 behaviour — `integrations/gateway/higress/redact_test.go`
(`TestOffsetsAreCharactersNotBytes`) and `tailhold_test.go` (a byte budget
spent on 3-byte chunks) go vacuous in ASCII. Their comments stay English,
and each says why the literal is there.

## Integration status (2026-08-15)

- `integrations/gateway/higress` — the v0.8 reference gateway integration
  (Go/WASM, CI-covered).
- `integrations/gateway/java-proxy` — OGR for a proxy an organization already
  runs (Java, CI-covered): a zero-dependency `core` library plus a runnable
  reference `server`. Its `DESIGN.md` is the language-neutral write-up of what
  protocol conversion at a proxy requires, and is the file to read before
  building this into any proxy. ⚠️ `core` must stay dependency-free — it is
  embedded in hosts that pin their own JSON library — and a provider body must
  never be round-tripped through a JSON writer, which is why reading
  (`json/Json`) and rewriting (`json/RawJson`) are separate classes.
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
- Java proxy: `cd integrations/gateway/java-proxy && mvn verify` (offline — a mock
  runtime and a mock provider with the real proxy between them)
- Release workflows: run `actionlint` against `.github/workflows/*.yml`

## Publishing

Only protected release tags may trigger publishing; there is intentionally no
`workflow_dispatch` publishing entry point. The one publishable artifact is
the Higress plugin (`higress-vX.Y.Z` → `docker.io/openguardrails/higress`,
OCI artifact; see `RELEASING.md` for why Docker Hub and which secrets).
Never add an npm or PyPI write token to the repository, workflows, or GitHub
secrets.
