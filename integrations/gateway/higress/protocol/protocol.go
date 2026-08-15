// Package protocol reads the LLM wire protocols a client may speak, one
// self-contained adapter per protocol.
//
// # Why this is a package and not a normalizer
//
// The first attempt at multi-protocol support RENDERED `anthropic.messages` and
// `openai.responses` into the `openai.chat` shape and let one reader consume the
// result. That is the wrong seam, for three reasons that all showed up at once:
//
//   - It privileges one protocol. `openai.chat` is the oldest of the three and the
//     one OpenAI itself is moving off; making it the internal truth means every new
//     protocol is measured by how well it impersonates a format on its way out.
//   - It is lossy in a way nothing reports. A `thinking` block, a `tool_result`
//     marked `is_error`, an interleaved text/tool_use sequence — each has to be
//     flattened into a shape with no field for it, and the flattening is invisible
//     downstream. A guardrail cannot tell "the model said nothing" from "the
//     renderer dropped it".
//   - It is unmaintainable BY OTHERS, which for an open-source integration is the
//     binding constraint. Adding a protocol meant editing a renderer that every
//     other protocol also went through, so the blast radius of a contribution was
//     the whole file.
//
// So there is no privileged protocol. Each adapter parses its OWN wire format into
// the neutral model below, and the layers above read only that model.
//
// # The model
//
// The types mirror the platform's own layering — session → turn → step → call in
// OGR vocabulary — so a gateway's view lines up with what the runtime
// reassembles:
//
//	Conversation   what one request carries: a system prompt, turns, tool defs
//	Turn           one step of the conversation
//	Action         one tool invocation asked for on a turn
//	Outcome        what an action returned
//	Output         what the model produced in reply to one request
//
// An adapter is a PURE function of bytes. Nothing in this package may import
// proxywasm or touch gateway state; that is what keeps every protocol testable
// without a gateway, and it is enforced by the package boundary rather than by
// convention.
//
// # Adding a protocol
//
// See README.md. In short: one file, implement Protocol, call Register in an
// init(), add a table entry to the conformance test.
package protocol

import (
	"strings"

	"github.com/tidwall/gjson"
)

// --- the conversation model --------------------------------------------------

// Role is who produced a turn.
type Role string

const (
	// RoleUser is a person's words entering the loop.
	RoleUser Role = "user"
	// RoleAssistant is the model's own turn: prose, reasoning, and the actions it
	// asked for.
	RoleAssistant Role = "assistant"
	// RoleTool is what an action returned, fed back for the model to read.
	//
	// ⚠️ This is the agent loop's untrusted surface and the reason the loop needs
	// first-class support at all: a tool result has NOT yet reached the model, so it
	// is the last point at which indirect prompt injection can still be refused.
	RoleTool Role = "tool"
)

// Action is one tool invocation — the "action" layer.
type Action struct {
	// ID pairs the action with its Outcome. Absent in some protocols' history.
	ID   string
	Name string
	// Arguments is the argument object as RAW JSON TEXT, exactly as the wire
	// carried it.
	//
	// ⚠️ Raw rather than re-marshalled on purpose. Re-encoding reorders keys and
	// changes spacing, so the judge would read a different string than the model
	// was handed, and a verdict's span offsets would index text that was never
	// sent. Protocols that carry arguments as an object (Anthropic's `input`) and
	// protocols that carry them as a string (OpenAI's `arguments`) both land here
	// as the raw object text.
	Arguments string
}

// Outcome is what an Action returned.
type Outcome struct {
	// CallID is the Action.ID this answers. The pairing is what lets a judge ask
	// "does this result follow from the action that was authorized?".
	CallID string
	Name   string
	Text   string
	// IsError marks a result the harness itself flagged as a failure. Kept because
	// a failing tool is a different signal than a succeeding one — a run that
	// retries a denied action is a bypass attempt, not a retry.
	IsError bool
}

// Turn is one step of a conversation.
type Turn struct {
	Role Role
	// Text is the turn's words: the user's question, the model's prose, or the
	// tool's output.
	Text string
	// Reasoning is the model's own thinking, where the protocol exposes it.
	//
	// ⚠️ Kept SEPARATE from Text rather than concatenated into it. Reasoning is
	// content a guardrail should read — it is where a hijacked plan states itself
	// before any action exists — but it is not what the model said, and folding the
	// two together would make a verdict's offsets index a string that exists
	// nowhere on the wire.
	Reasoning string
	// Actions are the tool invocations asked for on this turn (RoleAssistant).
	Actions []Action
	// Outcome is what came back (RoleTool). One per turn: a protocol that packs
	// several results into one wire message yields several turns here.
	Outcome *Outcome
}

// ToolDef is a tool made available to the model. The DEFINITION is an attack
// surface of its own — description injection, rug-pulls — detectable before any
// call, which is why it is carried rather than counted.
type ToolDef struct {
	Name        string
	Description string
	// Schema is the parameter schema as raw JSON text.
	Schema string
}

// Conversation is what one request carries.
type Conversation struct {
	Model string
	// System is the system prompt, wherever this protocol keeps it: a `system`
	// message, a top-level `system` field, or `instructions`.
	System string
	Turns  []Turn
	Tools  []ToolDef
	// Stream is whether the caller asked for SSE.
	Stream bool
}

// Usage is the provider's OWN token accounting for one reply, normalized to the
// counter names the OGR canonical payload uses. A gateway holds no tokenizer,
// so this is transcription, never estimation: nil means the provider reported
// nothing, and nil is the honest answer then — an invented count would be read
// downstream as a measurement.
type Usage struct {
	InputTokens      int64
	OutputTokens     int64
	ReasoningTokens  int64
	CacheReadTokens  int64
	CacheWriteTokens int64
}

// Output is what the model produced in reply to one request.
type Output struct {
	Text      string
	Reasoning string
	Actions   []Action
	// Usage is nil when the provider reported none — on `openai.chat` streams
	// that is the default unless the request carried
	// `stream_options.include_usage` (see StreamUsageEnsurer).
	Usage *Usage
}

// Empty reports whether the model produced nothing readable. Usage alone does
// not count: a reply that carried counters and no content still said nothing.
func (o Output) Empty() bool { return o.Text == "" && len(o.Actions) == 0 }

// StreamUsageEnsurer is implemented by a protocol whose provider omits token
// usage from a stream unless the REQUEST opts in. EnsureStreamUsage rewrites a
// request body to opt in and reports whether it did — the caller then owes the
// client a stream without the extra frame it never asked for (see
// UsageFrameSuppressor).
type StreamUsageEnsurer interface {
	EnsureStreamUsage(body string) (string, bool)
}

// UsageFrameSuppressor is implemented by a Decoder that can withhold the
// usage-only frame a gateway's own opt-in produced. Only ever armed when the
// GATEWAY injected the opt-in: a client that asked for usage itself must
// receive it, and a frame the provider volunteers unasked passes through too.
type UsageFrameSuppressor interface {
	SuppressUsageFrame()
}

// NewInput returns the turns that have NOT yet reached the model: everything
// after the model's last turn.
//
// ⚠️ This is the whole agent loop in one function, and getting it wrong is how a
// gateway silently stops enforcing. The loop is
//
//	user input → model output → actions → outcomes → model output → …
//
// and only the FIRST leg has a user turn in it. On every continuation the client
// re-sends the same conversation with tool outcomes appended and no new user
// message — so a gateway that defines "new input" as "the newest user turn" finds
// one it has already seen, judges nothing, and lets the continuation through. The
// events still reach the platform as a report, so nothing looks broken: the
// console fills, the counters move, and enforcement is simply absent for every
// turn of every agent.
//
// Everything before the model's last turn is history the client is re-sending; it
// was judged when it was new.
func (c *Conversation) NewInput() []Turn {
	last := -1
	for i, t := range c.Turns {
		if t.Role == RoleAssistant {
			last = i
		}
	}
	return c.Turns[last+1:]
}

// --- the adapter interface ---------------------------------------------------

// Claim is how a protocol answers "is this request path mine?".
type Claim int

const (
	// ClaimIgnore — not this protocol's path.
	ClaimIgnore Claim = iota
	// ClaimServe — this protocol's completion endpoint.
	ClaimServe
	// ClaimReject — a path this protocol OWNS but which is not a completion, such
	// as Anthropic's `/v1/messages/count_tokens`. Distinct from ClaimIgnore because
	// it must stop detection outright: a count_tokens body is a valid messages body,
	// so falling through to shape matching would read it as a conversation and
	// report a turn that never happened.
	ClaimReject
)

// Protocol is one LLM wire format. Every method is a pure function of its inputs.
type Protocol interface {
	// Name is the OGR `llm_protocol` enum value (schema/guard-event.schema.json).
	Name() string

	// Claim answers whether a request path belongs to this protocol.
	Claim(path string) Claim

	// MatchBody recognises this protocol from the body alone, for a deployment that
	// mounts a completion API under a path we do not know. Registration order
	// decides precedence; see Register.
	MatchBody(body gjson.Result) bool

	// ParseRequest reads the conversation. ok=false means "this carries no
	// conversation we can read", which the caller reports rather than swallows.
	ParseRequest(body gjson.Result) (*Conversation, bool)

	// ParseResponse reads a buffered reply.
	ParseResponse(body gjson.Result) Output

	// NewDecoder returns a reader for this protocol's SSE, restoring placeholders
	// in the frames on their way to the caller.
	NewDecoder(r *Restorer) Decoder

	// Mask rewrites every text surface of a REQUEST body in place, returning the
	// new body and how many strings changed.
	//
	// ⚠️ Unlike parsing, this writes through to the bytes that are FORWARDED, so it
	// has to know where the text lives in the shape the caller actually sent. Get it
	// wrong and the failure is the worst kind available: the log says "masked N
	// strings" while the value travels to the model in the clear.
	Mask(body string, redactions []Redaction) (string, int)

	// Restore puts plaintext back into a buffered REPLY.
	//
	// ⚠️ Not symmetric with Mask failing. If we mask and never restore, the caller
	// receives `${OGR_EMAIL_1}` where its own data belongs — the placeholder escapes
	// into the customer's application, and on the next turn their client sends it
	// back to us as content.
	Restore(body string, mapping map[string]string) (string, bool)

	// Refuse renders a refusal as a complete reply in this protocol's own shape.
	//
	// ⚠️ Per protocol, not one shared body. A refused `/v1/messages` caller handed
	// an OpenAI `choices[]` document gets a parse error from its SDK, which its user
	// reads as the gateway being broken rather than as a policy decision — and many
	// agent harnesses retry a malformed reply, turning one refusal into a storm.
	Refuse(model, reason string) string

	// RefuseStream is Refuse in SSE frames, for the buffered lane.
	RefuseStream(model, reason string) string

	// Retract ends a passthrough stream whose final judgement refused it. The text
	// is already on the caller's screen; this is the frame that tells a client to
	// take the message back.
	Retract(model string) string
}

// --- the registry ------------------------------------------------------------

var (
	registry  []Protocol
	fallbacks []Protocol
)

// Register adds a protocol. Call it from an init() in the protocol's own file, so
// adding one touches exactly one file.
//
// ⚠️ Registration order is PRECEDENCE for body matching. Two protocols whose bodies can
// look alike must not both use this — the more specific one registers here and the
// broader one uses RegisterFallback, rather than the two of them relying on how the
// compiler happened to sort their filenames.
func Register(p Protocol) { registry = append(registry, p) }

// RegisterFallback adds a protocol whose body shape is a SUPERSET of another's, so it
// may only be matched once every specific protocol has declined.
//
// ⚠️ `openai.chat` is the one, and this is load-bearing: its body test is "has a
// `messages` array", which every `anthropic.messages` body also passes. Registered
// normally it would swallow every Anthropic request whose path we did not recognise,
// and the symptom would be a correctly-parsed-looking conversation with the system
// prompt missing and every tool_use block dropped.
func RegisterFallback(p Protocol) { fallbacks = append(fallbacks, p) }

// All returns the registered protocols, in precedence order, fallbacks last.
func All() []Protocol {
	out := make([]Protocol, 0, len(registry)+len(fallbacks))
	return append(append(out, registry...), fallbacks...)
}

// ByName returns the protocol with this `llm_protocol` value, or nil.
func ByName(name string) Protocol {
	for _, p := range All() {
		if p.Name() == name {
			return p
		}
	}
	return nil
}

// Detect resolves the protocol a request is speaking: the path first, because it
// is the same signal a translating proxy keys on, then the body shape.
//
// ⚠️ Returns nil rather than guessing. Reporting a protocol we did not establish is
// how a gateway ends up with hundreds of thousands of events all stamped
// `openai.chat` and no way to tell whether any of them were — at which point the
// field has stopped being evidence, which is worse than it being empty.
func Detect(path string, body gjson.Result) Protocol {
	clean := CleanPath(path)
	ordered := All()
	for _, p := range ordered {
		switch p.Claim(clean) {
		case ClaimReject:
			return nil
		case ClaimServe:
			return p
		}
	}
	if !body.IsObject() {
		return nil
	}
	for _, p := range ordered {
		if p.MatchBody(body) {
			return p
		}
	}
	return nil
}

// IsCompletionPath decides whether a filter opens the body at all.
//
// ⚠️ This used to be `strings.Contains(path, "/chat/completions")` in the higress
// plugin, and that single line was the whole reason an Anthropic client got zero
// guardrail coverage while every observable signal — HTTP 200, no warning, no
// error, no counter — said healthy. The body was never opened, so nothing
// downstream could notice. Measured 2026-08-08.
func IsCompletionPath(path string) bool {
	clean := CleanPath(path)
	for _, p := range All() {
		switch p.Claim(clean) {
		case ClaimReject:
			return false
		case ClaimServe:
			return true
		}
	}
	return false
}

// CleanPath strips the query and any trailing slash, so suffix matching means what
// it looks like it means.
func CleanPath(path string) string {
	if i := strings.IndexByte(path, '?'); i >= 0 {
		path = path[:i]
	}
	return strings.TrimSuffix(path, "/")
}

// HasSuffixPath is the matcher adapters use for their endpoints. Suffix-ish on
// purpose: a deployment may mount them under a prefix (`/api/v1/messages`,
// `/openai/v1/chat/completions`).
func HasSuffixPath(path, suffix string) bool { return strings.HasSuffix(path, suffix) }
