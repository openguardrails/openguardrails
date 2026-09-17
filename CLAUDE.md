# OpenGuardrails repository instructions

This is a monorepo. Run commands from the repository root unless a component
README explicitly says otherwise.

**Protocol version: v1.9 (2026-09-17)**, on the wire v1.0 declared stable
(2026-08-19): the v0.8 "minimum API" unchanged (one endpoint, one recipe;
everything derivable left the wire, everything producer-known is required), plus
the **layer model** as the normative foundational concept (entity axis: tenant →
workspace → agent-as-endpoint; traffic stack: L6 session · L5 turn · L4 step ·
L3 event — the packet, the only layer on the wire — · L2 call · L1 exec).
Within 1.x changes are additive-optional only — 1.1 media · 1.2 obligations ·
1.3 mandate + `continuation` · 1.4 local redaction · 1.5 `initiator` ·
1.6 `llm_endpoint` · 1.7 grounding (DRAFT) · 1.8 `transport` + verdict `timing` ·
1.9 `?payload=true` (the verdict carries the rendered body) + the streamed transport
of a `step/response`.
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

OGR supports two integration VANTAGES operationally: agent-direct hooks and the
model channel — same protocol, different seat. `integrations/` is THREE categories
(re-cut 2026-09-17), decided by what the code HOLDS and whose process it is in:
`gateway/` is a plugin inside a product that IS the LLM byte path (Higress, OpenAFW,
mitmproxy) and holds the stream, so it alone can apply spans in full and refuse
mid-stream; `bridge/` is a STANDALONE process that holds one MESSAGE at a time — a
service the organization already runs posts the request body, later the reply body,
and gets the decision and the rewritten body back while keeping its own provider
connection (a streamed reply IS one message: the service relays the provider's frames
to the bridge's response door as `text/event-stream` and gets the guarded frames back,
head-bounded, which is the only shape in which an end-of-stream decision still
enforces — the line a bridge does not cross is the provider connection, not the
bytes); `agent/` is code inside the harness, different at every host, speaking
OGR directly against whatever seam the host exposes (there is no shared conversion
to factor out of a hook). ⚠️ A bridge takes messages, never the `base_url` — the
moment it forwards to a provider it is one more gateway, which is the job the
products in `gateway/` already do. The Java bridge's reference server keeps an
inline `/v1/*` door ONLY as the offline test bed for `core`'s streaming and span
code; its deployment shape is `/guard/v1/step/{request,response}`, the response door
taking either one JSON body or the provider's SSE frames (`ogr-*` headers, the
runtime's own streamed-transport spelling, verdict on a trailing `: ogr` comment).
⚠️ OpenAFW's OGR connection lives in the openafw repository; `integrations/gateway/openafw/` is
the pointer that places it in the category, not a copy of the code. All bindings
and runnable integration examples belong under `integrations/`; a gateway
implementation is not an OGR-operated service.
⚠️ **"adapter" is a per-protocol READER class, never a category** — three of them
live inside `bridge/java` alone. A directory by that name would give the word two
referents; the category is `bridge/`, which is also what the Runtime API's own
worked example calls this shape (`acme-bridge/1.0.0`). `examples/minimal-agent/` is the runnable
form of the spec's minimal integration.

## Language

This repository is **English-only**. That covers source, docs, comments, the
CHANGELOG — and equally **commit messages and pull request titles/bodies**.
It is a public open-standard repo: outside implementers read the history as
well as the files. Discuss the work in whatever language you like; nothing
written into the repo follows.

The one exception is a CJK **test fixture** that exists to exercise
multibyte/UTF-8 behaviour — `integrations/gateway/higress/redact_test.go`
(`TestOffsetsAreCharactersNotBytes`), `tailhold_test.go` (a byte budget
spent on 3-byte chunks) and `integrations/bridge/java/…/RawJsonTest.java`
(`spansAreCountedInCodePointsNotUtf16Units`) go vacuous in ASCII. Their
comments stay English, and each says why the literal is there.

## Integration status (2026-08-15)

- `integrations/gateway/higress` — the v0.8 reference gateway integration
  (Go/WASM, CI-covered).
- `integrations/gateway/openafw` — a POINTER (no code): the OGR connection inside
  OpenAFW, the local AI firewall, is a gateway plugin at the host end of the model
  channel and the one gateway plugin that also does local redaction (minter `F`).
- `integrations/bridge/java` — the first BRIDGE (Java, CI-covered): a runnable
  `server` exposing the message door — JSON bodies and, since 2026-09-17, the streamed
  transport of its response half — plus the zero-dependency `core` it is built on. Its
  `DESIGN.md` is the language-neutral write-up of what protocol conversion
  requires, and is the file to read before building one in any language.
  ⚠️ `core` must stay dependency-free — it is embedded in hosts that pin their own
  JSON library — and a provider body must never be round-tripped through a JSON
  writer, which is why reading (`json/Json`) and rewriting (`json/RawJson`) are
  separate classes.
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
- Java bridge: `cd integrations/bridge/java && mvn verify` (offline — a mock
  runtime and a mock provider with the real proxy between them)
- Release workflows: run `actionlint` against `.github/workflows/*.yml`

## Publishing

Only protected release tags may trigger publishing; there is intentionally no
`workflow_dispatch` publishing entry point. The one publishable artifact is
the Higress plugin (`higress-vX.Y.Z` → `docker.io/openguardrails/higress`,
OCI artifact; see `RELEASING.md` for why Docker Hub and which secrets).
Never add an npm or PyPI write token to the repository, workflows, or GitHub
secrets.
