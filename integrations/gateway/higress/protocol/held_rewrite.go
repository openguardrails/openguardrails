package protocol

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// RewriteHeldSSE operates only on a COMPLETE, unpublished stream. It joins each
// independent content channel before rewriting, then emits the rewritten value
// in that channel's first delta. Later deltas are empty. Snapshots are rewritten
// too; upstream framing, IDs, usage and completion events are preserved.
// replacements is source value -> final value, applied once (never recursively).
func RewriteHeldSSE(raw string, replacements map[string]string) (string, error) {
	type field struct {
		obj map[string]any
		key string
	}
	type channel struct {
		fields []field
		text   strings.Builder
		args   bool
	}
	channels := map[string]*channel{}
	frames := strings.Split(strings.ReplaceAll(raw, "\r\n", "\n"), "\n\n")
	documents := make(map[int]map[string]any)
	dataLines := make(map[int]int)
	terminal := false
	add := func(id string, obj map[string]any, key string, args bool) {
		value, ok := obj[key].(string)
		if !ok {
			return
		}
		c := channels[id]
		if c == nil {
			c = &channel{args: args}
			channels[id] = c
		}
		c.fields = append(c.fields, field{obj, key})
		c.text.WriteString(value)
	}
	obj := func(v any) map[string]any { m, _ := v.(map[string]any); return m }
	number := func(v any) string {
		if v == nil {
			return "0"
		}
		return fmt.Sprint(v)
	}
	for i, frame := range frames {
		lines := strings.Split(frame, "\n")
		found := -1
		for j, line := range lines {
			if strings.HasPrefix(line, "data:") {
				if found >= 0 {
					return "", fmt.Errorf("multiline SSE data is unsupported")
				}
				found = j
			}
		}
		if found < 0 {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(lines[found], "data:"))
		if data == "[DONE]" {
			terminal = true
			continue
		}
		var doc map[string]any
		if json.Unmarshal([]byte(data), &doc) != nil || doc == nil {
			return "", fmt.Errorf("unreadable SSE data")
		}
		documents[i] = doc
		dataLines[i] = found
		if choices, ok := doc["choices"].([]any); ok {
			if len(choices) > 1 {
				return "", fmt.Errorf("multiple choices require separate privacy evaluation")
			}
			for j, v := range choices {
				choice := obj(v)
				if choice["index"] != nil && number(choice["index"]) != "0" {
					return "", fmt.Errorf("unsupported choice index")
				}
				if choice["finish_reason"] != nil {
					terminal = true
				}
				delta := obj(choice["delta"])
				if delta == nil {
					continue
				}
				index := number(choice["index"])
				if choice["index"] == nil {
					index = strconv.Itoa(j)
				}
				base := "chat." + index + "."
				for _, key := range []string{"content", "reasoning_content", "reasoning"} {
					add(base+key, delta, key, false)
				}
				calls, _ := delta["tool_calls"].([]any)
				for k, v := range calls {
					call := obj(v)
					fn := obj(call["function"])
					if fn == nil {
						continue
					}
					idx := number(call["index"])
					if call["index"] == nil {
						idx = strconv.Itoa(k)
					}
					add(base+"call."+idx, fn, "arguments", true)
				}
			}
			continue
		}
		typ, _ := doc["type"].(string)
		if typ == "message_stop" || typ == "response.completed" || typ == "response.incomplete" || typ == "response.failed" {
			terminal = true
		}
		switch typ {
		case "content_block_start":
			b := obj(doc["content_block"])
			if b == nil {
				return "", fmt.Errorf("missing content block")
			}
			base := "anthropic." + number(doc["index"]) + "."
			add(base+"text", b, "text", false)
			add(base+"thinking", b, "thinking", false)
		case "content_block_delta":
			d := obj(doc["delta"])
			if d == nil {
				return "", fmt.Errorf("missing delta")
			}
			base := "anthropic." + number(doc["index"]) + "."
			switch d["type"] {
			case "text_delta":
				add(base+"text", d, "text", false)
			case "thinking_delta":
				add(base+"thinking", d, "thinking", false)
			case "input_json_delta":
				add(base+"args", d, "partial_json", true)
			case "signature_delta":
			default:
				return "", fmt.Errorf("unsupported content delta")
			}
		case "response.output_text.delta", "response.reasoning_summary_text.delta", "response.reasoning_text.delta", "response.function_call_arguments.delta":
			id := "responses." + number(doc["output_index"]) + "." + number(doc["content_index"]) + "." + number(doc["summary_index"]) + "." + typ
			add(id, doc, "delta", typ == "response.function_call_arguments.delta")
		case "message_start", "message_delta", "message_stop", "content_block_stop", "ping",
			"response.created", "response.in_progress", "response.output_item.added", "response.content_part.added",
			"response.reasoning_summary_part.added", "response.reasoning_summary_part.done",
			"response.output_text.done", "response.reasoning_summary_text.done", "response.reasoning_text.done",
			"response.function_call_arguments.done", "response.content_part.done", "response.output_item.done",
			"response.completed", "response.incomplete", "response.failed":
		default:
			return "", fmt.Errorf("unsupported SSE event %q", typ)
		}
	}
	if !terminal {
		return "", fmt.Errorf("incomplete upstream stream")
	}
	// Exclude delta fields from the snapshot walk: source bytes must be rewritten once.
	excluded := map[mapKey]bool{}
	sources := []string{}
	var remember func(any)
	remember = func(v any) {
		switch x := v.(type) {
		case string:
			sources = append(sources, x)
		case []any:
			for _, a := range x {
				remember(a)
			}
		case map[string]any:
			for _, a := range x {
				remember(a)
			}
		}
	}
	for _, c := range channels {
		sources = append(sources, c.text.String())
		if c.args && c.text.Len() > 0 {
			var value any
			if json.Unmarshal([]byte(c.text.String()), &value) != nil {
				return "", fmt.Errorf("incomplete tool arguments")
			}
			remember(value)
			b, _ := json.Marshal(value)
			sources = append(sources, string(b))
		}
	}
	covered := func(text string) bool {
		if text == "" {
			return true
		}
		for _, source := range sources {
			if strings.Contains(source, text) {
				return true
			}
		}
		return false
	}
	r := newRewriter(replacements)
	for _, c := range channels {
		source := c.text.String()
		rewritten := ""
		if c.args && source != "" {
			var value any
			if json.Unmarshal([]byte(source), &value) != nil {
				return "", fmt.Errorf("incomplete tool arguments")
			}
			value = rewriteLeaves(value, r)
			b, err := json.Marshal(value)
			if err != nil {
				return "", err
			}
			rewritten = string(b)
		} else {
			rewritten, _ = r.Extract(source, true)
		}
		for j, f := range c.fields {
			if j == 0 {
				f.obj[f.key] = rewritten
			} else {
				f.obj[f.key] = ""
			}
			excluded[mapKey{fmt.Sprintf("%p", f.obj), f.key}] = true
		}
	}
	var snapshotErr error
	var snapshots func(any)
	snapshots = func(v any) {
		switch m := v.(type) {
		case map[string]any:
			for key, value := range m {
				if excluded[mapKey{fmt.Sprintf("%p", m), key}] {
					continue
				}
				switch key {
				case "id", "item_id", "call_id", "tool_call_id", "type", "model", "name", "object", "role", "finish_reason", "signature":
					continue
				}
				if s, ok := value.(string); ok {
					switch key {
					case "text", "content", "thinking", "output_text", "reasoning", "reasoning_content", "message", "refusal":
						if !covered(s) {
							snapshotErr = fmt.Errorf("snapshot contains unjudged content")
							return
						}
					}
					if key == "arguments" && s != "" {
						var a any
						if json.Unmarshal([]byte(s), &a) != nil {
							snapshotErr = fmt.Errorf("invalid snapshot arguments")
							return
						}
						normalized, _ := json.Marshal(a)
						if !covered(s) && !covered(string(normalized)) {
							snapshotErr = fmt.Errorf("snapshot contains unjudged arguments")
							return
						}
						b, _ := json.Marshal(rewriteLeaves(a, r))
						m[key] = string(b)
					} else {
						m[key], _ = r.Extract(s, true)
					}
				} else {
					if key == "input" {
						if input, ok := value.(map[string]any); ok && len(input) > 0 {
							b, _ := json.Marshal(input)
							if !covered(string(b)) {
								snapshotErr = fmt.Errorf("snapshot contains unjudged tool input")
								return
							}
						}
					}
					snapshots(value)
				}
			}
		case []any:
			for _, value := range m {
				snapshots(value)
			}
		}
	}
	for i, doc := range documents {
		snapshots(doc)
		if snapshotErr != nil {
			return "", snapshotErr
		}
		b, err := json.Marshal(doc)
		if err != nil {
			return "", err
		}
		lines := strings.Split(frames[i], "\n")
		lines[dataLines[i]] = "data: " + string(b)
		frames[i] = strings.Join(lines, "\n")
	}
	return strings.Join(frames, "\n\n"), nil
}

type mapKey struct{ pointer, key string }

func rewriteLeaves(v any, r *Restorer) any {
	switch value := v.(type) {
	case string:
		out, _ := r.Extract(value, true)
		return out
	case []any:
		for i, x := range value {
			value[i] = rewriteLeaves(x, r)
		}
	case map[string]any:
		for k, x := range value {
			value[k] = rewriteLeaves(x, r)
		}
	}
	return v
}
