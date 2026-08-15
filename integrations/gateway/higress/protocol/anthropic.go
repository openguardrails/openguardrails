package protocol

import (
	"encoding/json"
	"sort"
	"strconv"
	"strings"

	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
)

// `anthropic.messages` — the Messages API.
//
// ⚠️ This adapter REGISTERS FIRST, and that is load-bearing. An Anthropic body and a
// chat body both have a `messages` array, so body-shape detection would hand every
// Anthropic request to the chat adapter if the chat catch-all ran first. Ambiguity is
// resolved by testing for the things only this protocol has.
//
// Its agent loop is NESTED where chat's is flat: `tool_use` blocks live inside the
// assistant's content, and their results come back as `tool_result` blocks inside the
// NEXT USER MESSAGE. Reading the loop out of it therefore means walking content
// blocks, not messages — a `role: "user"` message in an agent run frequently contains
// no user words at all, only what the tools returned.

func init() { Register(anthropicMessages{}) }

type anthropicMessages struct{}

func (anthropicMessages) Name() string { return "anthropic.messages" }

func (anthropicMessages) Claim(path string) Claim {
	// ⚠️ `/v1/messages/count_tokens` is NOT a completion and must not be treated as
	// one — it contains `/v1/messages` as a prefix, its body IS a valid messages body,
	// and reading it as a conversation reports a turn that never reached a model.
	if HasSuffixPath(path, "/count_tokens") {
		return ClaimReject
	}
	if HasSuffixPath(path, "/messages") {
		return ClaimServe
	}
	return ClaimIgnore
}

// MatchBody tests for what ONLY this protocol has: a top-level `system`, or content
// carried as typed blocks of a kind chat has no equivalent for.
func (anthropicMessages) MatchBody(body gjson.Result) bool {
	if !body.Get("messages").IsArray() {
		return false
	}
	if body.Get("system").Exists() {
		return true
	}
	for _, m := range body.Get("messages").Array() {
		for _, part := range m.Get("content").Array() {
			switch part.Get("type").String() {
			case "tool_use", "tool_result", "thinking", "redacted_thinking":
				return true
			}
		}
	}
	return false
}

// --- request -----------------------------------------------------------------

func (anthropicMessages) ParseRequest(body gjson.Result) (*Conversation, bool) {
	msgs := body.Get("messages")
	if !msgs.IsArray() {
		return nil, false
	}
	conv := &Conversation{
		Model: body.Get("model").String(),
		// ⚠️ `system` is a TOP-LEVEL field here, not a message. Missing it is not a
		// cosmetic loss: agent recognition matches a regex against the head of the
		// system prompt, so without it every Anthropic client collapses into the
		// promptless default bucket and no policy scoped to an agent type reaches it.
		System: anthropicText(body.Get("system")),
		Stream: body.Get("stream").Bool(),
	}

	for _, m := range msgs.Array() {
		role := m.Get("role").String()
		content := m.Get("content")

		// tool_result blocks ride inside a USER message. They become their own turns,
		// emitted BEFORE the user's own words — the order the model reads them in.
		for _, part := range content.Array() {
			if part.Get("type").String() != "tool_result" {
				continue
			}
			conv.Turns = append(conv.Turns, Turn{Role: RoleTool, Outcome: &Outcome{
				CallID:  part.Get("tool_use_id").String(),
				Text:    anthropicText(part.Get("content")),
				IsError: part.Get("is_error").Bool(),
			}})
		}

		turn := Turn{
			Text:      anthropicText(content),
			Reasoning: anthropicReasoning(content),
		}
		switch role {
		case "assistant":
			turn.Role = RoleAssistant
			turn.Actions = anthropicActions(content)
		default:
			turn.Role = RoleUser
		}
		// A message that carried only tool_result blocks has no words of its own;
		// emitting it would add an empty turn to the transcript and to the session's
		// prefix chain.
		if turn.Text != "" || turn.Reasoning != "" || len(turn.Actions) > 0 {
			conv.Turns = append(conv.Turns, turn)
		}
	}

	for _, t := range body.Get("tools").Array() {
		if n := t.Get("name").String(); n != "" {
			conv.Tools = append(conv.Tools, ToolDef{
				Name:        n,
				Description: t.Get("description").String(),
				Schema:      t.Get("input_schema").Raw,
			})
		}
	}
	return conv, len(conv.Turns) > 0
}

// anthropicText flattens the text-bearing blocks. `tool_use`, `tool_result` and
// `thinking` are deliberately excluded: each becomes its own field or turn, and
// folding them in here would make one string that exists nowhere on the wire.
func anthropicText(c gjson.Result) string {
	if c.Type == gjson.String {
		return c.String()
	}
	if !c.IsArray() {
		return ""
	}
	var b strings.Builder
	for _, part := range c.Array() {
		switch part.Get("type").String() {
		case "text", "":
			if t := part.Get("text"); t.Type == gjson.String {
				appendSpaced(&b, t.String())
			}
		}
	}
	return b.String()
}

// anthropicReasoning collects `thinking` blocks — content the guardrails should read,
// because it is where a hijacked plan states itself before any action exists.
func anthropicReasoning(c gjson.Result) string {
	var b strings.Builder
	for _, part := range c.Array() {
		if part.Get("type").String() != "thinking" {
			continue
		}
		if t := part.Get("thinking"); t.Type == gjson.String {
			appendSpaced(&b, t.String())
		}
	}
	return b.String()
}

func anthropicActions(c gjson.Result) []Action {
	var out []Action
	for _, part := range c.Array() {
		if part.Get("type").String() != "tool_use" {
			continue
		}
		out = append(out, Action{
			ID:   part.Get("id").String(),
			Name: part.Get("name").String(),
			// `input` is an OBJECT here where OpenAI carries a JSON string. The raw text
			// is the faithful rendering; re-marshalling would reorder keys and change
			// what the judge reads.
			Arguments: part.Get("input").Raw,
		})
	}
	return out
}

func appendSpaced(b *strings.Builder, s string) {
	if s == "" {
		return
	}
	if b.Len() > 0 {
		b.WriteString(" ")
	}
	b.WriteString(s)
}

// appendText is appendSpaced for a plain string field.
func appendText(dst *string, s string) {
	if s == "" {
		return
	}
	if *dst != "" {
		*dst += " "
	}
	*dst += s
}

// --- response ----------------------------------------------------------------

func (anthropicMessages) ParseResponse(body gjson.Result) Output {
	c := body.Get("content")
	return Output{
		Text:      anthropicText(c),
		Reasoning: anthropicReasoning(c),
		Actions:   anthropicActions(c),
		Usage:     mergeAnthropicUsage(nil, body.Get("usage")),
	}
}

// mergeAnthropicUsage folds one usage object into the accumulator, setting only
// the fields THIS object carries. Merging is what the stream requires: the
// Messages API reports input-side counters on `message_start` and the final
// output count on `message_delta`, and each half must not zero the other.
func mergeAnthropicUsage(u *Usage, res gjson.Result) *Usage {
	if !res.IsObject() {
		return u
	}
	if u == nil {
		u = &Usage{}
	}
	if v := res.Get("input_tokens"); v.Exists() {
		u.InputTokens = v.Int()
	}
	if v := res.Get("output_tokens"); v.Exists() {
		u.OutputTokens = v.Int()
	}
	if v := res.Get("cache_read_input_tokens"); v.Exists() {
		u.CacheReadTokens = v.Int()
	}
	if v := res.Get("cache_creation_input_tokens"); v.Exists() {
		u.CacheWriteTokens = v.Int()
	}
	return u
}

// --- masking and restoration -------------------------------------------------

func (anthropicMessages) Mask(body string, redactions []Redaction) (string, int) {
	if len(redactions) == 0 {
		return body, 0
	}
	// The system prompt is a top-level field here. Chat carries it as a message and
	// masks it with the rest; skipping it here would silently drop the system prompt
	// out of coverage for this protocol alone.
	out, changed := maskTextOrBlocks(body, "system", redactions)
	for i, m := range gjson.Get(out, "messages").Array() {
		base := "messages." + strconv.Itoa(i) + ".content"
		next, n := maskTextOrBlocks(out, base, redactions)
		out, changed = next, changed+n
		// A tool_result's OWN content is where retrieved documents and command output
		// arrive — the surface the privacy guardrail exists to read, and the one
		// indirect injection travels on. It is nested one level deeper than any other
		// text in the protocol, so the generic walk does not reach it.
		for j, part := range m.Get("content").Array() {
			if part.Get("type").String() != "tool_result" {
				continue
			}
			next, n := maskTextOrBlocks(out, base+"."+strconv.Itoa(j)+".content", redactions)
			out, changed = next, changed+n
		}
	}
	return out, changed
}

func (anthropicMessages) Restore(body string, mapping map[string]string) (string, bool) {
	if len(mapping) == 0 {
		return body, false
	}
	out, changed := body, false
	for i, part := range gjson.Get(out, "content").Array() {
		base := "content." + strconv.Itoa(i)
		var ok bool
		switch part.Get("type").String() {
		case "text":
			out, ok = restoreAt(out, base+".text", mapping)
		case "thinking":
			out, ok = restoreAt(out, base+".thinking", mapping)
		case "tool_use":
			// `input` is an object, so the whole subtree is restored as raw JSON.
			out, ok = restoreRawAt(out, base+".input", mapping)
		}
		changed = changed || ok
	}
	return out, changed
}

// --- refusals ----------------------------------------------------------------

// Refuse renders a complete Messages reply carrying the refusal as the assistant's
// text, with HTTP 200 — the same reasoning as the chat adapter, in this protocol's
// own shape.
//
// ⚠️ `stop_reason: "refusal"` is the Messages API's own value for exactly this. A
// client that only knows the older set reads it as an unfamiliar string, which is the
// mild failure; the alternative — claiming `end_turn` — tells a harness the model
// answered normally and is the failure that hides a policy decision.
func (anthropicMessages) Refuse(model, reason string) string {
	out, err := json.Marshal(map[string]any{
		"id": "msg_ogr_refusal", "type": "message", "role": "assistant", "model": model,
		"content":     []map[string]any{{"type": "text", "text": reason}},
		"stop_reason": "refusal", "stop_sequence": nil,
		"usage": map[string]any{"input_tokens": 0, "output_tokens": 0},
	})
	if err != nil {
		return `{"type":"error","error":{"type":"invalid_request_error","message":"refused"}}`
	}
	return string(out)
}

// RefuseStream is the full Messages event sequence. A client's SDK assembles a reply
// from these events, so a partial sequence leaves it waiting rather than rendering
// the refusal.
func (a anthropicMessages) RefuseStream(model, reason string) string {
	start, _ := json.Marshal(map[string]any{
		"type": "message_start",
		"message": map[string]any{
			"id": "msg_ogr", "type": "message", "role": "assistant", "model": model,
			"content": []any{}, "stop_reason": nil, "stop_sequence": nil,
			"usage": map[string]any{"input_tokens": 0, "output_tokens": 0},
		},
	})
	blockStart, _ := json.Marshal(map[string]any{
		"type": "content_block_start", "index": 0,
		"content_block": map[string]any{"type": "text", "text": ""},
	})
	delta, _ := json.Marshal(map[string]any{
		"type": "content_block_delta", "index": 0,
		"delta": map[string]any{"type": "text_delta", "text": reason},
	})
	blockStop, _ := json.Marshal(map[string]any{"type": "content_block_stop", "index": 0})
	return anthropicEvent("message_start", string(start)) +
		anthropicEvent("content_block_start", string(blockStart)) +
		anthropicEvent("content_block_delta", string(delta)) +
		anthropicEvent("content_block_stop", string(blockStop)) +
		a.Retract(model)
}

// Retract closes a stream with the refusal stop reason. On the passthrough lane the
// text has already been delivered, so this is what tells a client to take it back.
func (anthropicMessages) Retract(string) string {
	delta, _ := json.Marshal(map[string]any{
		"type":  "message_delta",
		"delta": map[string]any{"stop_reason": "refusal", "stop_sequence": nil},
		"usage": map[string]any{"output_tokens": 0},
	})
	stop, _ := json.Marshal(map[string]any{"type": "message_stop"})
	return anthropicEvent("message_delta", string(delta)) +
		anthropicEvent("message_stop", string(stop))
}

// anthropicEvent writes one SSE event. The `event:` line is part of this protocol's
// stream — a client dispatches on it — where the OpenAI family sends `data:` alone.
func anthropicEvent(name, payload string) string {
	return "event: " + name + "\n" + SSEFrame(payload)
}

// --- streaming ---------------------------------------------------------------

func (anthropicMessages) NewDecoder(r *Restorer) Decoder {
	return &anthropicDecoder{r: r, blocks: map[int]*anthropicBlock{}}
}

// anthropicBlock is one content block being streamed. Blocks are keyed by `index`,
// and text and tool arguments arrive on the same delta event distinguished only by
// the delta's own type.
type anthropicBlock struct {
	kind    string // "text" | "thinking" | "tool_use"
	id      string
	name    string
	buf     strings.Builder // the block's accumulated text or partial JSON
	pending string          // the restorer's held-back tail for THIS block
}

type anthropicDecoder struct {
	r      *Restorer
	blocks map[int]*anthropicBlock
	order  []int
	usage  *Usage
}

func (d *anthropicDecoder) block(i int) *anthropicBlock {
	b := d.blocks[i]
	if b == nil {
		b = &anthropicBlock{}
		d.blocks[i] = b
		d.order = append(d.order, i)
	}
	return b
}

func (d *anthropicDecoder) Line(line string, isLast bool) string {
	data, ok := SSEData(line)
	if !ok {
		return line // `event:` lines and blank separators pass through untouched
	}
	parsed := gjson.Parse(data)
	if !parsed.IsObject() {
		return line
	}
	idx := int(parsed.Get("index").Int())

	switch parsed.Get("type").String() {
	case "message_start":
		// The input-side counters (and the cache split) arrive here, before any
		// content exists; `message_delta` completes the picture below.
		d.usage = mergeAnthropicUsage(d.usage, parsed.Get("message.usage"))
		return line

	case "content_block_start":
		b := d.block(idx)
		cb := parsed.Get("content_block")
		b.kind = cb.Get("type").String()
		b.id = cb.Get("id").String()
		b.name = cb.Get("name").String()
		// A `text` block may open with text already in it.
		if t := cb.Get("text"); t.Type == gjson.String && t.String() != "" {
			b.buf.WriteString(t.String())
		}
		return line

	case "content_block_delta":
		b := d.block(idx)
		delta := parsed.Get("delta")
		var path, original string
		switch delta.Get("type").String() {
		case "text_delta":
			path, original = "delta.text", delta.Get("text").String()
		case "thinking_delta":
			path, original = "delta.thinking", delta.Get("thinking").String()
		case "input_json_delta":
			// The tool's arguments, streamed as JSON fragments that concatenate.
			path, original = "delta.partial_json", delta.Get("partial_json").String()
		default:
			return line // signature_delta and anything newer: not text, pass through
		}
		b.buf.WriteString(original)
		restored := d.r.Feed(&b.pending, original, isLast)
		if restored == original {
			return line
		}
		next, err := sjson.Set(data, path, restored)
		if err != nil {
			return line
		}
		return "data: " + next

	case "message_delta", "message_stop":
		// The final output_tokens count rides message_delta's own `usage`.
		d.usage = mergeAnthropicUsage(d.usage, parsed.Get("usage"))
		// ⚠️ The answer is ending, so whatever the restorer holds is text and has to
		// go out BEFORE the frame that closes it — otherwise an answer ending in the
		// first characters of a placeholder silently loses them.
		return d.Flush() + line
	}
	return line
}

// Flush emits each block's held-back tail as its own `content_block_delta`, which is
// the only frame shape this protocol has for adding text to a block already open.
func (d *anthropicDecoder) Flush() string {
	var out strings.Builder
	for _, i := range d.order {
		b := d.blocks[i]
		if b.pending == "" {
			continue
		}
		delta := map[string]any{"type": "text_delta", "text": b.pending}
		switch b.kind {
		case "thinking":
			delta = map[string]any{"type": "thinking_delta", "thinking": b.pending}
		case "tool_use":
			delta = map[string]any{"type": "input_json_delta", "partial_json": b.pending}
		}
		b.pending = ""
		payload, err := json.Marshal(map[string]any{
			"type": "content_block_delta", "index": i, "delta": delta,
		})
		if err != nil {
			continue
		}
		out.WriteString(anthropicEvent("content_block_delta", string(payload)))
	}
	return out.String()
}

// ContentBytes — see protocol.ContentMeter. Every block kind is client-visible
// content (text, thinking, tool_use partial JSON), so it is the sum of the buffers.
func (d *anthropicDecoder) ContentBytes() int {
	n := 0
	for _, b := range d.blocks {
		n += b.buf.Len()
	}
	return n
}

func (d *anthropicDecoder) Output() Output {
	var out Output
	var text, reasoning strings.Builder
	idx := append([]int(nil), d.order...)
	sort.Ints(idx)
	for _, i := range idx {
		b := d.blocks[i]
		switch b.kind {
		case "thinking":
			appendSpaced(&reasoning, b.buf.String())
		case "tool_use":
			out.Actions = append(out.Actions, Action{
				ID: b.id, Name: b.name, Arguments: b.buf.String(),
			})
		default:
			appendSpaced(&text, b.buf.String())
		}
	}
	out.Text, out.Reasoning = text.String(), reasoning.String()
	out.Usage = d.usage
	return out
}
