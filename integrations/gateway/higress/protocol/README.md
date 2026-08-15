# `protocol` — one adapter per LLM wire format

This package is where the plugin learns to read a client's traffic. Everything above
it — the streaming tail-hold, restoration, refusal rendering — reads the neutral model
defined in `protocol.go` and cannot tell one protocol from another. (Since the v0.7
raw-forwarder rewrite the plugin no longer derives events from the parsed
conversation — the runtime classifies the raw body — but the SSE reassembly, the
placeholder restorer and the per-protocol refusals all still rest on this package,
and `ParseRequest`/`Mask` remain as tested library surface.)

| file | protocol | `llm_protocol` |
|---|---|---|
| `anthropic.go` | Messages API | `anthropic.messages` |
| `openai_chat.go` | Chat Completions | `openai.chat` |
| `openai_responses.go` | Responses API | `openai.responses` |

## Why there is no "normalize to OpenAI" step

The first version of multi-protocol support rendered Anthropic and Responses bodies
into the Chat Completions shape and let one reader consume the result. It was removed,
because:

- **It privileges one protocol.** `openai.chat` is the oldest of the three and the one
  OpenAI itself is moving off. Making it the internal truth means every new protocol is
  measured by how well it impersonates a format on its way out.
- **It is lossy in a way nothing reports.** A `thinking` block, a `tool_result` marked
  `is_error`, an interleaved text/tool_use sequence — each has to be flattened into a
  shape with no field for it, and the flattening is invisible downstream. A guardrail
  cannot tell "the model said nothing" from "the renderer dropped it".
- **It is unmaintainable by anyone but the author.** Adding a protocol meant editing a
  renderer every other protocol also went through, so the blast radius of a
  contribution was the whole file.

A neutral model is not the same thing as a privileged one. No protocol's field names
appear in `Conversation`.

## The model

It mirrors the platform's own layering — **session → turn → step → call** in OGR
vocabulary — so what a gateway sees lines up with what the runtime reassembles.

```go
type Conversation struct {
    Model  string
    System string      // wherever this protocol keeps it
    Turns  []Turn
    Tools  []ToolDef
    Stream bool
}

type Turn struct {
    Role      Role      // user | assistant | tool
    Text      string
    Reasoning string    // thinking / reasoning, never folded into Text
    Actions   []Action  // what the model asked to do, on an assistant turn
    Outcome   *Outcome  // what came back, on a tool turn
}
```

Two rules carry most of the weight:

**`Action.Arguments` is raw JSON text, not a re-marshalled object.** Re-encoding
reorders keys and changes spacing, so the judge would read a different string than the
model was handed and a verdict's span offsets would index text that was never sent.

**`Reasoning` is separate from `Text`.** Reasoning is content a guardrail should read —
it is where a hijacked plan states itself before any action exists — but it is not what
the model said, and concatenating them makes offsets index a string that exists nowhere
on the wire.

### `Conversation.NewInput()`

The agent loop is

```
user input → model output → actions → outcomes → model output → …
```

and **only the first leg has a user turn in it**. `NewInput()` returns everything after
the model's last turn: the user's new question in a plain chat, and the tool outcomes in
an agent continuation. That is the set the gateway can still refuse — a tool has already
run, but its output has not yet reached the model, which is where indirect prompt
injection is stoppable.

Defining new input as "the newest user turn" instead is how a gateway silently stops
enforcing for every turn of every agent after the first, with no error anywhere.

## Adding a protocol

One file, one `init()`, one test-table row.

1. **Create `yourprotocol.go`** and implement `Protocol`:

   | method | what it must do |
   |---|---|
   | `Name` | the `llm_protocol` value — add it to `schema/guard-event.schema.json` in the same change |
   | `Claim` | `ClaimServe` for your completion path; `ClaimReject` for a path you own that is *not* a completion (see Anthropic's `count_tokens`) |
   | `MatchBody` | recognise the body when the path is unfamiliar |
   | `ParseRequest` | body → `*Conversation`; `ok=false` means "no conversation here" |
   | `ParseResponse` | buffered reply → `Output` |
   | `NewDecoder` | your SSE reader (`Decoder`) |
   | `Mask` | write placeholders into every text surface of a *request* body |
   | `Restore` | put plaintext back into a *reply* |
   | `Refuse` / `RefuseStream` / `Retract` | a refusal your protocol's own clients can render |

2. **Register in an `init()`.** Use `Register`. Only use `RegisterFallback` if your body
   shape is a *superset* of another protocol's — `openai.chat` is the one, because "has a
   `messages` array" also matches every Anthropic body.

3. **Add a row to `conformance` in `conformance_test.go`**: the same shared conversation
   written in your protocol. That one row checks detection from path and from body,
   turn-for-turn parsing, the loop boundary, buffered and streamed reply reading,
   masking coverage, restoration round trip, and all three refusal shapes.

4. **Add a `yourprotocol_test.go`** for what is true of your protocol and nothing else.

### Constraints

- **Never import `proxywasm` or touch gateway state.** Adapters are pure functions of
  bytes; that is what keeps every protocol testable without a gateway, and the package
  boundary is what enforces it.
- **Parsing is tolerant; `ok=false` is not.** A block type you do not know is dropped,
  not failed on — a guardrail that reads 90% of a turn is worth more than one that reads
  none of it because the model added a field. `ok=false` is reserved for "this is not a
  conversation at all", which is what makes the plugin emit an `unparsed` signal instead
  of silence.
- **A decoder must pass through what it does not understand.** Dropping an unknown frame
  corrupts the stream for the client, which is worse than not reading it.
- **`Mask` writes to bytes that are forwarded.** Getting a path wrong here is the worst
  failure available: the log says "masked N strings" while the value travels to the model
  in the clear. The conformance test asserts that no plaintext survives.
- **A refusal must be readable by the SDK that asked.** `TestARefusalIsReadableByTheProtocolThatAskedForIt`
  round-trips your refusal through your own `ParseResponse` for exactly this reason: a
  refused caller handed another protocol's document sees a broken gateway, not a policy
  decision — and many agent harnesses retry it.
