package protocol

import (
	"encoding/json"
	"sort"
	"strconv"
	"strings"

	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
)

// `openai.chat` — the Chat Completions API.
//
// The oldest of the three and still the most widely spoken, because every
// OpenAI-compatible vendor implements it. It is also the one OpenAI is moving off:
// the Responses API is where new capability lands. It is treated here as one
// protocol among three, with no special standing.
//
// Its agent loop is FLAT: an assistant message carries `tool_calls`, and each result
// comes back as its own `role: "tool"` message paired by `tool_call_id`.

// ⚠️ RegisterFallback, not Register: this adapter's body test is "has a `messages`
// array", which every anthropic.messages body also passes. It may only match a body
// once every more specific protocol has declined.
func init() { RegisterFallback(openAIChat{}) }

type openAIChat struct{}

func (openAIChat) Name() string { return "openai.chat" }

func (openAIChat) Claim(path string) Claim {
	if HasSuffixPath(path, "/chat/completions") {
		return ClaimServe
	}
	return ClaimIgnore
}

// MatchBody is the CATCH-ALL, which is why this adapter registers last: a bare
// `messages` array with nothing protocol-specific in it is chat by elimination.
func (openAIChat) MatchBody(body gjson.Result) bool { return body.Get("messages").IsArray() }

// --- request -----------------------------------------------------------------

func (openAIChat) ParseRequest(body gjson.Result) (*Conversation, bool) {
	msgs := body.Get("messages")
	if !msgs.IsArray() {
		return nil, false
	}
	conv := &Conversation{
		Model:  body.Get("model").String(),
		Stream: body.Get("stream").Bool(),
	}
	for _, m := range msgs.Array() {
		switch m.Get("role").String() {
		case "system", "developer":
			// First one wins: a prompt split across several system messages is rare,
			// and joining them would change the text agent recognition matches on.
			if conv.System == "" {
				conv.System = chatText(m.Get("content"))
			}
		case "user":
			if t := chatText(m.Get("content")); t != "" {
				conv.Turns = append(conv.Turns, Turn{Role: RoleUser, Text: t})
			}
		case "assistant":
			turn := Turn{
				Role:      RoleAssistant,
				Text:      chatText(m.Get("content")),
				Reasoning: m.Get("reasoning_content").String(),
				Actions:   chatActions(m),
			}
			if turn.Text != "" || turn.Reasoning != "" || len(turn.Actions) > 0 {
				conv.Turns = append(conv.Turns, turn)
			}
		case "tool":
			conv.Turns = append(conv.Turns, Turn{Role: RoleTool, Outcome: &Outcome{
				CallID: m.Get("tool_call_id").String(),
				Name:   m.Get("name").String(),
				Text:   chatText(m.Get("content")),
			}})
		}
	}
	for _, t := range body.Get("tools").Array() {
		if n := t.Get("function.name").String(); n != "" {
			conv.Tools = append(conv.Tools, ToolDef{
				Name:        n,
				Description: t.Get("function.description").String(),
				Schema:      t.Get("function.parameters").Raw,
			})
		}
	}
	return conv, len(conv.Turns) > 0
}

// chatText flattens content, which is a bare string or a list of parts.
func chatText(c gjson.Result) string {
	if c.Type == gjson.String {
		return c.String()
	}
	if !c.IsArray() {
		return ""
	}
	var b strings.Builder
	for _, part := range c.Array() {
		if t := part.Get("text"); t.Exists() && t.Type == gjson.String {
			if b.Len() > 0 {
				b.WriteString(" ")
			}
			b.WriteString(t.String())
		}
	}
	return b.String()
}

func chatActions(msg gjson.Result) []Action {
	var out []Action
	for _, tc := range msg.Get("tool_calls").Array() {
		out = append(out, Action{
			ID:   tc.Get("id").String(),
			Name: tc.Get("function.name").String(),
			// `arguments` is a JSON STRING here. Its CONTENTS are the argument object,
			// which is what Action.Arguments holds in every protocol.
			Arguments: tc.Get("function.arguments").String(),
		})
	}
	return out
}

// --- response ----------------------------------------------------------------

func (openAIChat) ParseResponse(body gjson.Result) Output {
	msg := body.Get("choices.0.message")
	return Output{
		Text:      msg.Get("content").String(),
		Reasoning: msg.Get("reasoning_content").String(),
		Actions:   chatActions(msg),
		Usage:     chatUsage(body.Get("usage")),
	}
}

// chatUsage transcribes the Chat Completions usage object. `usage: null` — what
// every streamed chunk before the final one carries under include_usage — is not
// an object and reads as "nothing reported".
func chatUsage(u gjson.Result) *Usage {
	if !u.IsObject() {
		return nil
	}
	return &Usage{
		InputTokens:     u.Get("prompt_tokens").Int(),
		OutputTokens:    u.Get("completion_tokens").Int(),
		ReasoningTokens: u.Get("completion_tokens_details.reasoning_tokens").Int(),
		CacheReadTokens: u.Get("prompt_tokens_details.cached_tokens").Int(),
	}
}

// EnsureStreamUsage opts a streaming request into usage reporting
// (`stream_options.include_usage`), which this protocol otherwise OMITS from
// streams — the one protocol of the three where a stream's token counts exist
// only if the request asked. Returns the body unchanged when the request is not
// a stream or the client already opted in; true means the GATEWAY injected it,
// and the extra usage-only frame is then the gateway's to swallow, not the
// client's to parse.
func (openAIChat) EnsureStreamUsage(body string) (string, bool) {
	parsed := gjson.Parse(body)
	if !parsed.Get("stream").Bool() {
		return body, false
	}
	if parsed.Get("stream_options.include_usage").Bool() {
		return body, false
	}
	next, err := sjson.Set(body, "stream_options.include_usage", true)
	if err != nil {
		return body, false
	}
	return next, true
}

// --- masking and restoration -------------------------------------------------

// Mask walks `messages[].content`, which covers the user's words, the assistant's
// prose, the system prompt (a message in this protocol) and every tool result.
func (openAIChat) Mask(body string, redactions []Redaction) (string, int) {
	if len(redactions) == 0 {
		return body, 0
	}
	out, changed := body, 0
	for i := range gjson.Get(out, "messages").Array() {
		next, n := maskTextOrBlocks(out, "messages."+strconv.Itoa(i)+".content", redactions)
		out, changed = next, changed+n
	}
	return out, changed
}

func (openAIChat) Restore(body string, mapping map[string]string) (string, bool) {
	if len(mapping) == 0 {
		return body, false
	}
	out, changed := restoreAt(body, "choices.0.message.content", mapping)
	// ⚠️ The arguments are not an afterthought, they are the half that MATTERS. An
	// unrestored line of prose is a cosmetic defect the reader can see; an unrestored
	// `{"to": "${OGR_EMAIL_1}"}` is an agent acting on a value that names nothing —
	// mailing a placeholder, looking up a customer who does not exist — and nothing
	// in the reply says so.
	for i := range gjson.Get(out, "choices.0.message.tool_calls").Array() {
		path := "choices.0.message.tool_calls." + strconv.Itoa(i) + ".function.arguments"
		next, ok := restoreAt(out, path, mapping)
		out, changed = next, changed || ok
	}
	return out, changed
}

// --- refusals ----------------------------------------------------------------

// Refuse renders the refusal AS THE ASSISTANT MESSAGE, with HTTP 200.
//
// ⚠️ 200, not 4xx, on purpose: every OpenAI-compatible client renders an assistant
// message, while a 4xx surfaces as a generic transport failure that explains nothing
// to the person who typed the prompt — and many agent harnesses retry it, turning
// one refusal into a retry storm.
func (openAIChat) Refuse(model, reason string) string {
	out, err := json.Marshal(map[string]any{
		"id": "chatcmpl-ogr-refusal", "object": "chat.completion", "model": model,
		"choices": []map[string]any{{
			"index":         0,
			"message":       map[string]any{"role": "assistant", "content": reason},
			"finish_reason": "content_filter",
		}},
	})
	if err != nil {
		return `{"error":{"message":"refused"}}`
	}
	return string(out)
}

func (openAIChat) RefuseStream(model, reason string) string {
	first, _ := json.Marshal(chatChunk(model, map[string]any{"role": "assistant", "content": reason}, ""))
	return SSEFrame(string(first)) + openAIChat{}.Retract(model)
}

// Retract ends a stream the final judgement refused.
//
// ⚠️ `content_filter`, not `stop`. The finish reason states WHY the turn ended, and a
// client that logs or retries on it must be able to tell a refusal from a completed
// reply.
func (openAIChat) Retract(model string) string {
	last, _ := json.Marshal(chatChunk(model, map[string]any{}, "content_filter"))
	return SSEFrame(string(last)) + "data: [DONE]\n\n"
}

func chatChunk(model string, delta map[string]any, finish string) map[string]any {
	choice := map[string]any{"index": 0, "delta": delta}
	if finish != "" {
		choice["finish_reason"] = finish
	}
	return map[string]any{
		"id": "chatcmpl-ogr", "object": "chat.completion.chunk", "model": model,
		"choices": []map[string]any{choice},
	}
}

// --- streaming ---------------------------------------------------------------

func (openAIChat) NewDecoder(r *Restorer) Decoder {
	return &chatDecoder{r: r, calls: map[int]*streamCall{}}
}

// streamCall accumulates one tool call's deltas, which concatenate by index.
type streamCall struct {
	ID   string
	Name string
	Args strings.Builder
	// pending is the restorer's held-back tail for THIS call's arguments.
	pending string
}

type chatDecoder struct {
	r *Restorer

	text      strings.Builder
	reasoning strings.Builder
	calls     map[int]*streamCall
	usage     *Usage

	textBuf      string
	reasoningBuf string

	// suppressUsage: the GATEWAY injected `include_usage`, so the terminal
	// usage-only frame is one the client never asked for and must not receive.
	suppressUsage bool
}

// SuppressUsageFrame arms the swallow — see UsageFrameSuppressor.
func (d *chatDecoder) SuppressUsageFrame() { d.suppressUsage = true }

// ContentBytes — see protocol.ContentMeter. Builder lengths, so it is O(#calls)
// per ask, never a rebuild of the reply.
func (d *chatDecoder) ContentBytes() int {
	n := d.text.Len() + d.reasoning.Len()
	for _, c := range d.calls {
		n += c.Args.Len()
	}
	return n
}

func (d *chatDecoder) Output() Output {
	out := Output{Text: d.text.String(), Reasoning: d.reasoning.String(), Usage: d.usage}
	idx := make([]int, 0, len(d.calls))
	for i := range d.calls {
		idx = append(idx, i)
	}
	sort.Ints(idx)
	for _, i := range idx {
		c := d.calls[i]
		out.Actions = append(out.Actions, Action{ID: c.ID, Name: c.Name, Arguments: c.Args.String()})
	}
	return out
}

func (d *chatDecoder) Line(line string, isLast bool) string {
	data, ok := SSEData(line)
	if !ok {
		return line
	}
	if data == "[DONE]" {
		return d.Flush() + line
	}
	parsed := gjson.Parse(data)
	if !parsed.IsObject() {
		return line
	}

	// Token usage, when a chunk carries it (the terminal frame under
	// include_usage; some vendors put it on the last content chunk instead).
	// Last non-null wins.
	if u := chatUsage(parsed.Get("usage")); u != nil {
		d.usage = u
		// The usage-only frame the gateway's OWN opt-in produced: captured above,
		// withheld from a client that never asked for it. A frame that also
		// carries choices is part of the answer and always passes.
		if d.suppressUsage && len(parsed.Get("choices").Array()) == 0 {
			return ""
		}
	}

	// ⚠️ The stream is ENDING, so nothing more can complete a half-matched token:
	// whatever the restorer is holding is text, and it has to be written out BEFORE
	// the frame that closes the answer. Without this it was silently dropped — an
	// answer ending in `$`, or in the first characters of a placeholder, simply lost
	// its last few characters, and only the client could ever have noticed.
	prefix := ""
	finished := parsed.Get("choices.0.finish_reason")
	if finished.Exists() && finished.Type == gjson.String {
		prefix = d.Flush()
	}

	modified := data
	if c := parsed.Get("choices.0.delta.content"); c.Type == gjson.String {
		d.text.WriteString(c.String())
		modified = d.rewrite(modified, "choices.0.delta.content", &d.textBuf, c.String(), isLast)
	}
	if c := parsed.Get("choices.0.delta.reasoning_content"); c.Type == gjson.String {
		d.reasoning.WriteString(c.String())
		before := modified
		modified = d.rewrite(modified, "choices.0.delta.reasoning_content", &d.reasoningBuf, c.String(), isLast)
		// Some vendors mirror the field; keep the two consistent or a client reading
		// the other one shows placeholders.
		if modified != before && parsed.Get("choices.0.delta.reasoning").Exists() {
			if next, err := sjson.Set(modified, "choices.0.delta.reasoning",
				gjson.Get(modified, "choices.0.delta.reasoning_content").String()); err == nil {
				modified = next
			}
		}
	}
	for n, tc := range parsed.Get("choices.0.delta.tool_calls").Array() {
		idx := int(tc.Get("index").Int())
		acc := d.calls[idx]
		if acc == nil {
			acc = &streamCall{}
			d.calls[idx] = acc
		}
		if id := tc.Get("id").String(); id != "" {
			acc.ID = id
		}
		if name := tc.Get("function.name").String(); name != "" {
			acc.Name = name
		}
		args := tc.Get("function.arguments")
		if args.Type != gjson.String {
			continue
		}
		acc.Args.WriteString(args.String())
		// ⚠️ Restored the SAME way as prose — through a pending tail — because a token
		// split across two argument deltas is the normal case, not the exception: the
		// deltas are token-sized and the placeholder is fourteen characters. Restoring
		// only when a whole token fits inside one delta is what handed the client
		// `{"to": "${OGR_EMAIL_1}"}` and made it act on a value that names nothing. The
		// client's JSON parse sees the concatenation, so what matters is that the
		// SEQUENCE comes out restored, not that any one delta does.
		modified = d.rewrite(modified,
			"choices.0.delta.tool_calls."+strconv.Itoa(n)+".function.arguments",
			&acc.pending, args.String(), isLast)
	}
	return prefix + "data: " + modified
}

func (d *chatDecoder) rewrite(frame, path string, buf *string, original string, isLast bool) string {
	restored := d.r.Feed(buf, original, isLast)
	if restored == original {
		return frame
	}
	if next, err := sjson.Set(frame, path, restored); err == nil {
		return next
	}
	return frame
}

func (d *chatDecoder) Flush() string {
	type fn struct {
		Arguments string `json:"arguments"`
	}
	type call struct {
		Index    int `json:"index"`
		Function fn  `json:"function"`
	}
	delta := struct {
		Content   string `json:"content,omitempty"`
		Reasoning string `json:"reasoning_content,omitempty"`
		ToolCalls []call `json:"tool_calls,omitempty"`
	}{Content: d.textBuf, Reasoning: d.reasoningBuf}
	d.textBuf, d.reasoningBuf = "", ""

	idx := make([]int, 0, len(d.calls))
	for i := range d.calls {
		idx = append(idx, i)
	}
	sort.Ints(idx)
	for _, i := range idx {
		c := d.calls[i]
		if c.pending == "" {
			continue
		}
		delta.ToolCalls = append(delta.ToolCalls, call{Index: i, Function: fn{Arguments: c.pending}})
		c.pending = ""
	}
	if delta.Content == "" && delta.Reasoning == "" && len(delta.ToolCalls) == 0 {
		return ""
	}
	out, err := json.Marshal(map[string]any{
		"id": "chatcmpl-ogr-flush", "object": "chat.completion.chunk",
		"choices": []map[string]any{{"index": 0, "delta": delta}},
	})
	if err != nil {
		return ""
	}
	return SSEFrame(string(out))
}
