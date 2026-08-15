package protocol

import (
	"encoding/json"
	"sort"
	"strconv"
	"strings"

	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
)

// `openai.responses` — the Responses API, where OpenAI's new capability lands.
//
// Structurally it is neither of the other two. There is no `messages` array: the
// conversation is an `input` LIST OF ITEMS, and an item is a message, a
// `function_call`, or a `function_call_output`. The agent loop is therefore FLAT like
// chat's but ITEM-shaped rather than message-shaped — a tool call is a sibling of a
// message, not a field on one — and both sides of the loop key on `call_id`.
//
// Its stream is the most different of the three: semantic events
// (`response.output_text.delta`) rather than diffs of a reply object, and a terminal
// `response.completed` that repeats the WHOLE reply. That repeat is why restoration
// here cannot only touch the deltas: an SDK assembles its result from the terminal
// event, so a placeholder left in it reaches the caller even when every delta was
// restored correctly.

func init() { Register(openAIResponses{}) }

type openAIResponses struct{}

func (openAIResponses) Name() string { return "openai.responses" }

func (openAIResponses) Claim(path string) Claim {
	if HasSuffixPath(path, "/responses") {
		return ClaimServe
	}
	return ClaimIgnore
}

func (openAIResponses) MatchBody(body gjson.Result) bool {
	return body.Get("input").Exists() || body.Get("instructions").Exists()
}

// --- request -----------------------------------------------------------------

func (openAIResponses) ParseRequest(body gjson.Result) (*Conversation, bool) {
	input := body.Get("input")
	if !input.Exists() {
		return nil, false
	}
	conv := &Conversation{
		Model: body.Get("model").String(),
		// The Responses API calls the system prompt `instructions`.
		System: responsesText(body.Get("instructions")),
		Stream: body.Get("stream").Bool(),
	}

	if input.Type == gjson.String {
		if input.String() != "" {
			conv.Turns = append(conv.Turns, Turn{Role: RoleUser, Text: input.String()})
		}
	}

	// ⚠️ ONE MODEL TURN IS SEVERAL ITEMS HERE, and collapsing them back is not
	// cosmetic. A reply that says something and then calls two tools arrives as a
	// `message` item plus two `function_call` items; left as three turns, the
	// conversation has three assistant turns where the other protocols have one — and
	// since the agent-loop boundary is "everything after the model's LAST turn", the
	// boundary would land in the middle of a single reply and the outcomes fed back
	// after it would be read as history that had already been judged.
	//
	// So consecutive assistant-produced items fold into the assistant turn in progress,
	// and a user or tool item closes it.
	assistant := func() *Turn {
		if n := len(conv.Turns); n > 0 && conv.Turns[n-1].Role == RoleAssistant {
			return &conv.Turns[n-1]
		}
		conv.Turns = append(conv.Turns, Turn{Role: RoleAssistant})
		return &conv.Turns[len(conv.Turns)-1]
	}

	for _, item := range input.Array() {
		switch item.Get("type").String() {
		case "function_call":
			t := assistant()
			t.Actions = append(t.Actions, Action{
				ID:   item.Get("call_id").String(),
				Name: item.Get("name").String(),
				// A JSON string here, like chat's.
				Arguments: item.Get("arguments").String(),
			})
		case "function_call_output":
			conv.Turns = append(conv.Turns, Turn{Role: RoleTool, Outcome: &Outcome{
				CallID: item.Get("call_id").String(),
				Text:   item.Get("output").String(),
			}})
		case "reasoning":
			// Reasoning is its own item, summarised. It belongs to the model's turn.
			if r := responsesText(item.Get("summary")); r != "" {
				t := assistant()
				appendText(&t.Reasoning, r)
			}
		default:
			// A plain message item: `type` is "message" or absent entirely.
			role := item.Get("role").String()
			text := responsesText(item.Get("content"))
			if role == "" || text == "" {
				continue
			}
			switch role {
			case "assistant":
				appendText(&assistant().Text, text)
			case "system", "developer":
				if conv.System == "" {
					conv.System = text
				}
			default:
				conv.Turns = append(conv.Turns, Turn{Role: RoleUser, Text: text})
			}
		}
	}

	// Responses declares tools FLAT: `{type, name, description, parameters}`, with no
	// `function` wrapper.
	for _, t := range body.Get("tools").Array() {
		if n := t.Get("name").String(); n != "" {
			conv.Tools = append(conv.Tools, ToolDef{
				Name:        n,
				Description: t.Get("description").String(),
				Schema:      t.Get("parameters").Raw,
			})
		}
	}
	return conv, len(conv.Turns) > 0
}

// responsesText flattens a content list, whose parts are `input_text`,
// `output_text`, `summary_text` or `refusal`.
func responsesText(c gjson.Result) string {
	if c.Type == gjson.String {
		return c.String()
	}
	if !c.IsArray() {
		return ""
	}
	var b strings.Builder
	for _, part := range c.Array() {
		switch part.Get("type").String() {
		case "input_text", "output_text", "summary_text", "text", "":
			if t := part.Get("text"); t.Type == gjson.String {
				appendSpaced(&b, t.String())
			}
		case "refusal":
			if t := part.Get("refusal"); t.Type == gjson.String {
				appendSpaced(&b, t.String())
			}
		}
	}
	return b.String()
}

// --- response ----------------------------------------------------------------

func (openAIResponses) ParseResponse(body gjson.Result) Output {
	var out Output
	var text, reasoning strings.Builder
	for _, item := range body.Get("output").Array() {
		switch item.Get("type").String() {
		case "function_call":
			out.Actions = append(out.Actions, Action{
				ID:        item.Get("call_id").String(),
				Name:      item.Get("name").String(),
				Arguments: item.Get("arguments").String(),
			})
		case "reasoning":
			appendSpaced(&reasoning, responsesText(item.Get("summary")))
		default:
			appendSpaced(&text, responsesText(item.Get("content")))
		}
	}
	out.Text, out.Reasoning = text.String(), reasoning.String()
	// `output_text` is the SDK's convenience field; honour it when the structured walk
	// found nothing, so a minimal reply is not read as an empty one.
	if out.Text == "" {
		out.Text = body.Get("output_text").String()
	}
	out.Usage = responsesUsage(body.Get("usage"))
	return out
}

// responsesUsage transcribes the Responses API usage object. Unlike chat, this
// protocol reports it on every completed response, streamed or not — no opt-in.
func responsesUsage(u gjson.Result) *Usage {
	if !u.IsObject() {
		return nil
	}
	return &Usage{
		InputTokens:     u.Get("input_tokens").Int(),
		OutputTokens:    u.Get("output_tokens").Int(),
		ReasoningTokens: u.Get("output_tokens_details.reasoning_tokens").Int(),
		CacheReadTokens: u.Get("input_tokens_details.cached_tokens").Int(),
	}
}

// --- masking and restoration -------------------------------------------------

func (openAIResponses) Mask(body string, redactions []Redaction) (string, int) {
	if len(redactions) == 0 {
		return body, 0
	}
	out, changed := maskTextOrBlocks(body, "instructions", redactions)

	if gjson.Get(out, "input").Type == gjson.String {
		next, n := maskAt(out, "input", redactions)
		return next, changed + n
	}
	for i, item := range gjson.Get(out, "input").Array() {
		base := "input." + strconv.Itoa(i)
		if item.Get("type").String() == "function_call_output" {
			// What a tool returned, on its way INTO the model: the indirect-injection
			// surface, and the one this protocol keeps under its own field name.
			next, n := maskAt(out, base+".output", redactions)
			out, changed = next, changed+n
			continue
		}
		next, n := maskTextOrBlocks(out, base+".content", redactions)
		out, changed = next, changed+n
	}
	return out, changed
}

func (openAIResponses) Restore(body string, mapping map[string]string) (string, bool) {
	if len(mapping) == 0 {
		return body, false
	}
	out, changed := restoreAt(body, "output_text", mapping)
	for i, item := range gjson.Get(out, "output").Array() {
		base := "output." + strconv.Itoa(i)
		if item.Get("type").String() == "function_call" {
			next, ok := restoreAt(out, base+".arguments", mapping)
			out, changed = next, changed || ok
			continue
		}
		for j, part := range item.Get("content").Array() {
			field := ".text"
			if part.Get("type").String() == "refusal" {
				field = ".refusal"
			}
			next, ok := restoreAt(out, base+".content."+strconv.Itoa(j)+field, mapping)
			out, changed = next, changed || ok
		}
	}
	return out, changed
}

// --- refusals ----------------------------------------------------------------

// Refuse renders a complete Response object carrying the refusal as the assistant's
// output text, with HTTP 200.
//
// ⚠️ `status: "incomplete"` with `incomplete_details.reason: "content_filter"`, which
// is this protocol's analogue of chat's `finish_reason`. Claiming `completed` would
// render identically and tell every harness downstream that the model answered
// normally — the one thing a refusal must not do.
func (openAIResponses) Refuse(model, reason string) string {
	out, err := json.Marshal(map[string]any{
		"id": "resp_ogr_refusal", "object": "response", "model": model,
		"status":             "incomplete",
		"incomplete_details": map[string]any{"reason": "content_filter"},
		"output":             []map[string]any{responsesMessage(reason)},
		"output_text":        reason,
	})
	if err != nil {
		return `{"error":{"message":"refused"}}`
	}
	return string(out)
}

func responsesMessage(text string) map[string]any {
	return map[string]any{
		"type": "message", "id": "msg_ogr_refusal", "status": "completed",
		"role":    "assistant",
		"content": []map[string]any{{"type": "output_text", "text": text, "annotations": []any{}}},
	}
}

// RefuseStream is the full semantic-event sequence an SDK assembles a reply from. A
// partial sequence leaves the client waiting rather than rendering the refusal.
func (r openAIResponses) RefuseStream(model, reason string) string {
	shell := func(status string) map[string]any {
		resp := map[string]any{
			"id": "resp_ogr", "object": "response", "model": model, "status": status,
			"output": []any{},
		}
		if status == "incomplete" {
			resp["incomplete_details"] = map[string]any{"reason": "content_filter"}
			resp["output"] = []map[string]any{responsesMessage(reason)}
			resp["output_text"] = reason
		}
		return resp
	}
	part := map[string]any{"type": "output_text", "text": "", "annotations": []any{}}

	var b strings.Builder
	write := func(name string, payload map[string]any) {
		raw, err := json.Marshal(payload)
		if err != nil {
			return
		}
		b.WriteString("event: " + name + "\n" + SSEFrame(string(raw)))
	}
	write("response.created", map[string]any{"type": "response.created", "response": shell("in_progress")})
	write("response.output_item.added", map[string]any{
		"type": "response.output_item.added", "output_index": 0, "item": responsesMessage(""),
	})
	write("response.content_part.added", map[string]any{
		"type": "response.content_part.added", "item_id": "msg_ogr_refusal",
		"output_index": 0, "content_index": 0, "part": part,
	})
	write("response.output_text.delta", map[string]any{
		"type": "response.output_text.delta", "item_id": "msg_ogr_refusal",
		"output_index": 0, "content_index": 0, "delta": reason,
	})
	write("response.output_text.done", map[string]any{
		"type": "response.output_text.done", "item_id": "msg_ogr_refusal",
		"output_index": 0, "content_index": 0, "text": reason,
	})
	write("response.output_item.done", map[string]any{
		"type": "response.output_item.done", "output_index": 0, "item": responsesMessage(reason),
	})
	b.WriteString(r.Retract(model))
	return b.String()
}

func (openAIResponses) Retract(model string) string {
	raw, err := json.Marshal(map[string]any{
		"type": "response.incomplete",
		"response": map[string]any{
			"id": "resp_ogr", "object": "response", "model": model, "status": "incomplete",
			"incomplete_details": map[string]any{"reason": "content_filter"},
		},
	})
	if err != nil {
		return ""
	}
	return "event: response.incomplete\n" + SSEFrame(string(raw))
}

// --- streaming ---------------------------------------------------------------

func (openAIResponses) NewDecoder(r *Restorer) Decoder {
	return &responsesDecoder{r: r, items: map[int]*responsesItem{}}
}

type responsesItem struct {
	kind      string // "message" | "function_call" | "reasoning"
	callID    string
	name      string
	text      strings.Builder
	reasoning strings.Builder
	args      strings.Builder
	// One pending tail per streamed field of this item: text, reasoning and
	// arguments interleave, and one field's half-token must never be completed by
	// another's next delta.
	textBuf, reasoningBuf, argsBuf string
}

type responsesDecoder struct {
	r     *Restorer
	items map[int]*responsesItem
	order []int
	usage *Usage
}

func (d *responsesDecoder) item(i int) *responsesItem {
	it := d.items[i]
	if it == nil {
		it = &responsesItem{}
		d.items[i] = it
		d.order = append(d.order, i)
	}
	return it
}

func (d *responsesDecoder) Line(line string, isLast bool) string {
	data, ok := SSEData(line)
	if !ok {
		return line
	}
	parsed := gjson.Parse(data)
	if !parsed.IsObject() {
		return line
	}
	idx := int(parsed.Get("output_index").Int())

	switch parsed.Get("type").String() {
	case "response.output_item.added":
		it := d.item(idx)
		item := parsed.Get("item")
		it.kind = item.Get("type").String()
		it.callID = item.Get("call_id").String()
		it.name = item.Get("name").String()
		return line

	case "response.output_text.delta":
		it := d.item(idx)
		original := parsed.Get("delta").String()
		it.text.WriteString(original)
		return d.rewrite(line, data, "delta", &it.textBuf, original, isLast)

	case "response.reasoning_summary_text.delta":
		it := d.item(idx)
		original := parsed.Get("delta").String()
		it.reasoning.WriteString(original)
		return d.rewrite(line, data, "delta", &it.reasoningBuf, original, isLast)

	case "response.function_call_arguments.delta":
		it := d.item(idx)
		original := parsed.Get("delta").String()
		it.args.WriteString(original)
		return d.rewrite(line, data, "delta", &it.argsBuf, original, isLast)

	// ⚠️ The `.done` and terminal events REPEAT the whole value, and an SDK builds its
	// result from them rather than from the deltas it already dispatched. Restoring
	// only the deltas leaves the caller's final object full of placeholders while
	// every visible token looked correct — the failure that is invisible until someone
	// reads the object instead of the screen. These carry no partial token, so they
	// restore whole rather than through a pending tail.
	case "response.output_text.done", "response.reasoning_summary_text.done",
		"response.function_call_arguments.done", "response.content_part.done",
		"response.output_item.done", "response.completed", "response.incomplete",
		"response.failed":
		// The terminal events repeat the whole reply object, usage included.
		if u := responsesUsage(parsed.Get("response.usage")); u != nil {
			d.usage = u
		}
		return d.Flush() + d.restoreWhole(line, data)
	}
	return line
}

// rewrite restores one streamed field through its pending tail.
func (d *responsesDecoder) rewrite(line, data, path string, buf *string, original string, isLast bool) string {
	restored := d.r.Feed(buf, original, isLast)
	if restored == original {
		return line
	}
	next, err := sjson.Set(data, path, restored)
	if err != nil {
		return line
	}
	return "data: " + next
}

// restoreWhole restores every placeholder in a frame by rewriting its raw JSON. The
// token alphabet contains nothing JSON escapes, so a whole-token substitution in the
// raw text cannot produce an invalid document.
func (d *responsesDecoder) restoreWhole(line, data string) string {
	if !d.r.Active() {
		return line
	}
	restored := RestoreString(data, d.r.mapping)
	if restored == data {
		return line
	}
	return "data: " + restored
}

func (d *responsesDecoder) Flush() string {
	var b strings.Builder
	for _, i := range d.order {
		it := d.items[i]
		emit := func(eventType, field, pending string) {
			if pending == "" {
				return
			}
			raw, err := json.Marshal(map[string]any{
				"type": eventType, "output_index": i, field: pending,
			})
			if err != nil {
				return
			}
			b.WriteString("event: " + eventType + "\n" + SSEFrame(string(raw)))
		}
		emit("response.output_text.delta", "delta", it.textBuf)
		emit("response.reasoning_summary_text.delta", "delta", it.reasoningBuf)
		emit("response.function_call_arguments.delta", "delta", it.argsBuf)
		it.textBuf, it.reasoningBuf, it.argsBuf = "", "", ""
	}
	return b.String()
}

// ContentBytes — see protocol.ContentMeter.
func (d *responsesDecoder) ContentBytes() int {
	n := 0
	for _, it := range d.items {
		n += it.text.Len() + it.reasoning.Len() + it.args.Len()
	}
	return n
}

func (d *responsesDecoder) Output() Output {
	var out Output
	var text, reasoning strings.Builder
	idx := append([]int(nil), d.order...)
	sort.Ints(idx)
	for _, i := range idx {
		it := d.items[i]
		appendSpaced(&text, it.text.String())
		appendSpaced(&reasoning, it.reasoning.String())
		if it.kind == "function_call" || it.args.Len() > 0 {
			out.Actions = append(out.Actions, Action{
				ID: it.callID, Name: it.name, Arguments: it.args.String(),
			})
		}
	}
	out.Text, out.Reasoning = text.String(), reasoning.String()
	out.Usage = d.usage
	return out
}
