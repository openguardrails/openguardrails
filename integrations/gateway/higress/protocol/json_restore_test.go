package protocol

import (
	"encoding/json"
	"testing"
)

func TestStreamedArgumentRestorationEscapesJSON(t *testing.T) {
	value := "secret-\"quoted\"\nC:\\keys"
	frame := func(v any) string { b, _ := json.Marshal(v); return "data: " + string(b) + "\n\n" }
	chat := func(piece string) string {
		return frame(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": "c", "function": map[string]any{"name": "send", "arguments": piece}}}}}}})
	}
	anthropic := func(piece string) string {
		return frame(map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "input_json_delta", "partial_json": piece}})
	}
	responses := func(piece string) string {
		return frame(map[string]any{"type": "response.function_call_arguments.delta", "output_index": 0, "delta": piece})
	}
	cases := map[string]string{
		"openai.chat":        chat(`{"key":"OGRKR`) + chat(`0000001"}`) + "data: [DONE]\n\n",
		"anthropic.messages": frame(map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "tool_use", "id": "c", "name": "send"}}) + anthropic(`{"key":"OGRKR`) + anthropic(`0000001"}`) + frame(map[string]any{"type": "message_stop"}),
		"openai.responses":   frame(map[string]any{"type": "response.output_item.added", "output_index": 0, "item": map[string]any{"type": "function_call", "call_id": "c", "name": "send"}}) + responses(`{"key":"OGRKR`) + responses(`0000001"}`) + frame(map[string]any{"type": "response.completed", "response": map[string]any{}}),
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			p := ByName(name)
			scanner := NewScanner(p.NewDecoder(NewRestorer(map[string]string{"OGRKR0000001": value})))
			out := scanner.Chunk([]byte(raw), true)
			client := NewScanner(p.NewDecoder(NewRestorer(nil)))
			client.Chunk(out, true)
			actions := client.Output().Actions
			if len(actions) != 1 {
				t.Fatalf("actions=%+v", actions)
			}
			var args map[string]string
			if err := json.Unmarshal([]byte(actions[0].Arguments), &args); err != nil {
				t.Fatal(err)
			}
			if args["key"] != value {
				t.Fatalf("key=%q", args["key"])
			}
		})
	}
}

func TestFinalSnapshotRestorationEscapesJSON(t *testing.T) {
	value := "secret-\"quoted\"\nC:\\keys"
	raw := `{"type":"response.completed","response":{"output_text":"OGRKR0000001","output":[{"type":"function_call","arguments":"{\"key\":\"OGRKR0000001\"}"}]}}`
	out := restoreSnapshotJSON(raw, map[string]string{"OGRKR0000001": value})
	var doc map[string]any
	if err := json.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatal(err)
	}
	r := doc["response"].(map[string]any)
	if r["output_text"] != value {
		t.Fatal(r)
	}
	args := r["output"].([]any)[0].(map[string]any)["arguments"].(string)
	var input map[string]string
	if err := json.Unmarshal([]byte(args), &input); err != nil {
		t.Fatal(err)
	}
	if input["key"] != value {
		t.Fatal(input)
	}
}
