# ogr-local

**Local secrets redaction for harnesses whose plugins run outside the agent's
process — [Claude Code](../claude-code) and [OpenAI Codex](../codex).**

⚠️ **This is SOURCE, not a package anyone installs.** It is bundled into each
of those two plugins as `hooks/ogr-local.mjs` and checked in there, because a
Claude Code or Codex plugin installs as a *directory* out of this repo — no
`npm install`, no build step. A proxy the user had to install separately
would be a second install step in front of a feature whose whole point is
that it needs no thought, and the commonest outcome of a second install step
is that it does not happen: the harness then runs with a base URL pointing at
nothing, or with masking quietly off.

The source lives here, once, beside `local-redaction` — copying a masking
core into two plugin directories is exactly the drift the conformance corpus
exists to prevent.

Every credential in the outbound model request is replaced with
`OGRK00000001`-style **on this machine**. The runtime judges the placeholder, the
model provider is given the placeholder, and the real value is put back into
the reply's tool-call arguments — locally — so the tool still runs with a
working credential. Same contract as the in-process masking the other
integrations do ([OGR 1.4](../../../specification/local-redaction.md)), at a
different vantage.

## Do you need this?

**Probably not.** If your harness loads a plugin *inside* the agent's process
— hermes, opencode, openclaw, dsh — that plugin installs an in-process
`fetch` interceptor and this package is not involved. No port, no lifecycle,
no base URL to change, and nothing left running when the harness exits.

Two harnesses cannot do that, and that is the entire reason this exists:

| harness | why the interceptor is impossible |
|---|---|
| **Claude Code** | hooks are separate **processes**; there is no seam inside the agent to install anything on |
| **Codex** | the host is **Rust**, and its hooks are separate processes too |

For those, the next vantage down is a socket in front of the harness.

## Install

Nothing to install: it arrives with the plugin, and the plugin's
`SessionStart` hook starts it. To check on a running one:

```sh
node <plugin>/hooks/ogr-local.mjs status
```

### Rebuilding the bundle

```sh
npm --prefix integrations/agent/ogr-local run bundle
```

Both plugins get the identical build. Every bundle carries a hash of the
sources it came from, and `tests/bundle.spec.mjs` recomputes it — **a
checked-in artifact that silently drifts from its source is the one real cost
of shipping it this way**, so editing `src/` without rebundling is a red test
rather than an invisible state.

## Wiring

**The upstream travels in the path**, which is what lets one daemon on one
port serve harnesses that talk to different providers:

```sh
# Claude Code — settings.json
"env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787/https/api.anthropic.com" }

# Codex — ~/.codex/config.toml (ChatGPT sign-in)
openai_base_url = "http://127.0.0.1:8787/https/chatgpt.com/backend-api/codex"
# Codex — ~/.codex/config.toml (API key)
openai_base_url = "http://127.0.0.1:8787/https/api.openai.com/v1"

# or ask:
node <plugin>/hooks/ogr-local.mjs base-url https://api.anthropic.com
```

Both harnesses resolve their provider URL **statically at startup** — Claude
Code from `settings.json`, Codex from `config.toml` — so neither can be handed
an ephemeral port, and a fixed port *per upstream* would mean one listener per
provider, each with its own lifecycle. Encoding the upstream in the base URL
the harness is already configured with collapses that to one port.

⚠️ **A hook cannot set these for you.** A hook is a child process; the
harness read its own environment long before. The `SessionStart` hooks start
the daemon and then *check* the setting, so the one failure that would
otherwise be silent — daemon healthy, harness talking straight to the
provider, nothing masked — is said out loud.

## Commands

| | |
|---|---|
| `ensure` | make sure a daemon is listening; print its URL. Idempotent — the port is the lock, and the check is a live request, so a stale record cannot lie |
| `serve` | run in the foreground (what `ensure` spawns) |
| `status` | ruleset, session count, and what has been masked |
| `base-url <url>` | the base URL to point a harness at, for one upstream |

Configuration is environment, shared with the rest of the OGR integrations:
`OGR_API_KEY` (required — the ruleset is your organization's),
`OGR_RUNTIME_URL`, `OGR_LOCAL_PORT` (8787), `OGR_RULES_CACHE`,
`OGR_FAIL_MODE`, `OGR_LOCAL_IDLE_MS` (6h).

## What it deliberately is not

- **Not an auth boundary.** Your `Authorization` / `x-api-key` is forwarded
  byte for byte and never read. The proxy holds no credential and mints none
   — a process that could answer *for* you is a far worse thing to leave
  listening than one that can only rewrite a body.
- **Not a policy engine.** Verdicts stay with the harness's OGR hooks. This
  is a masking seam, not a second enforcement point.
- **Not an open proxy.** The path may only name a known model API host; add
  your own gateway with `--host`. Without that bound, a general-purpose
  forwarder would be listening on loopback for every process on the machine.
- **There is no `/__ogr/restore`.** `/__ogr/mask` exists so a hook's own
  event carries the same tokens the provider was given; the reverse would
  hand any local process the plaintext of every secret the session has seen.
- **It refuses to start without an API key.** With no key there is no
  ruleset, so it would forward everything unmasked while a harness pointed at
  it looked protected. Better to not be listening at all.

## One port, two plugins

Both plugins ship their own bundle and both reach for **8787**, so whichever
harness starts first is the one whose build masks for the other. That is fine
— the masking contract is the *served ruleset*, not the code — but it is not
allowed to be invisible: `/__ogr/status` reports `served_by`, so "which build
is masking my Codex session" has an answer.

## What a proxy in front of it found (2026-09-11)

The first end-to-end run with mitmproxy between this daemon and the
providers — Claude Code 2.1 and Codex 0.153, seeded credentials in the user
prompt, the project instructions, a file the agent read and the tool call
itself — found four ways the mask was silently not on the path. Each is
fixed here and pinned by a test; each is the kind of failure this proxy is
most exposed to, because a request it does not understand used to be
FORWARDED, which looks exactly like a request with nothing to mask:

- **Codex compresses its model requests (`content-encoding: zstd`).**
  `JSON.parse` on the compressed bytes failed like a non-JSON body does, and
  the request took the non-model-call pass-through — every credential in the
  clear, `masking: true` in the status. Bodies are decoded first now (gzip,
  deflate, br, zstd), and a JSON body the proxy cannot read is **refused
  (415 `ogr_local_unreadable_body`), never forwarded**. `counters.unreadable`
  counts them.
- **The ChatGPT Codex backend answers with no `content-type`**, so an SSE
  reply looked like a buffered JSON one, failed to parse, and went back to
  the harness with its tool call still tokenised. A typeless reply to a
  request that asked for `text/event-stream` (or said `"stream": true`) is a
  stream.
- **Codex runs its shell as a `custom_tool_call`** whose `input` is a
  freeform program, not `function_call.arguments`; the restorer only knew the
  latter. Both shapes restore now (deltas, `.done` frames, the terminal
  `response.completed`), each flushed under its own event spelling.
- **The hook's session key did not match the proxy's.** Claude Code 2.x
  stamps `metadata.user_id` as a JSON string carrying `session_id`; the hook
  asks `/__ogr/mask` with the bare id. Keyed by the whole stamp, the lookup
  found nothing, the hook's event reached the runtime with the plaintext
  value under a `redaction` claim, and the runtime filed a "plugin miss" —
  true, and pointing at the wrong end. The map is keyed by the bare session
  id now (Codex: `prompt_cache_key`), and `/__ogr/mask` answers with a claim
  about THE EVENT it was handed — the tokens present in it, each with its
  rule — instead of the drained "minted since the last report" list, which at
  the hook vantage named the previous request's values and credited every
  tool-call event with zero.

Also: Codex first tries a **websocket** on `/responses`; the daemon used to
forward the upgrade as a plain GET (seven 405s from the provider per
session). It answers 405 on the loopback itself now
(`counters.upgrades_refused`) and Codex falls back to POST at once. A masked
websocket channel is separate work.

**Behind a corporate proxy** the daemon's own `fetch` (Node's undici) does
not read `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1` is set (Node ≥ 22.21 /
24); it also reads the lowercase `https_proxy` first. Both plugins' hooks
inherit the harness's environment, so set them where the harness runs.

## Honest limits

- **If the daemon is down, the harness cannot reach its provider.** That is
  the cost of a base-URL redirect, and it is why `ensure` runs on every
  session start and why the idle timeout is hours rather than minutes. The
  in-process interceptor has no equivalent failure — one more reason to
  prefer it wherever a plugin can run in-process.
- **Replies are requested uncompressed.** A gzipped body is one no tool call
  can be restored out of, and forwarding it would look exactly like a reply
  with nothing to restore.
- **One map per session key**, read from the request's own `metadata.user_id`
  / `user` where the harness stamps one (Claude Code does), else one key for
  the process.

## Development

```sh
npm install     # from the repo root (npm workspace)
npm run build   # tsc, then bundle into both plugins
npm test
```

⚠️ `pretest` runs `tsc` and deliberately **not** the bundler — regenerating
the artifact that the staleness guard exists to check would mean the guard
could never fail.
