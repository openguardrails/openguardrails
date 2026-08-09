package protocol

import (
	"strings"
	"testing"

	"github.com/tidwall/gjson"
)

// What is true of `openai.chat` and of nothing else.

func TestMaskRewritesBothContentShapes(t *testing.T) {
	body := `{"messages":[
	  {"role":"user","content":"mail ada@example.com"},
	  {"role":"user","content":[{"type":"text","text":"again ada@example.com"}]}]}`
	out, n := openAIChat{}.Mask(body, []Redaction{{Token: "${OGR_EMAIL_1}", Value: "ada@example.com"}})
	if n != 2 {
		t.Fatalf("changed %d strings, want 2", n)
	}
	if strings.Contains(out, "ada@example.com") {
		t.Fatalf("plaintext survived: %s", out)
	}
	if got := gjson.Get(out, "messages.1.content.0.text").String(); got != "again ${OGR_EMAIL_1}" {
		t.Fatalf("array part = %q", got)
	}
}

func TestMaskKeepsTheDocumentValidWhenValuesCarryQuotes(t *testing.T) {
	// A blind string replace over raw JSON corrupts the document the moment a value
	// contains a quote or a backslash; the walk sets each field through sjson instead.
	body := `{"messages":[{"role":"user","content":"say \"ada@example.com\" twice"}]}`
	out, _ := openAIChat{}.Mask(body, []Redaction{{Token: "${OGR_EMAIL_1}", Value: "ada@example.com"}})
	if !gjson.Valid(out) {
		t.Fatalf("masking produced invalid JSON: %s", out)
	}
	if got := gjson.Get(out, "messages.0.content").String(); got != `say "${OGR_EMAIL_1}" twice` {
		t.Fatalf("content = %q", got)
	}
}

func TestTheSystemPromptIsMaskedLikeAnyOtherMessage(t *testing.T) {
	// It is a message in this protocol, so the ordinary walk has to cover it — the
	// other two keep it in a field of its own and mask it separately.
	body := `{"messages":[{"role":"system","content":"contact ada@example.com"},
	  {"role":"user","content":"hi"}]}`
	out, n := openAIChat{}.Mask(body, []Redaction{{Token: "${OGR_EMAIL_1}", Value: "ada@example.com"}})
	if n != 1 || strings.Contains(out, "ada@example.com") {
		t.Fatalf("system prompt not masked (%d): %s", n, out)
	}
}

func TestAToolMessageBecomesAnOutcome(t *testing.T) {
	conv, _ := openAIChat{}.ParseRequest(gjson.Parse(`{"messages":[
	  {"role":"user","content":"go"},
	  {"role":"assistant","tool_calls":[{"id":"c1","function":{"name":"f","arguments":"{}"}}]},
	  {"role":"tool","tool_call_id":"c1","name":"f","content":"done"}]}`))
	last := conv.Turns[len(conv.Turns)-1]
	if last.Role != RoleTool || last.Outcome == nil {
		t.Fatalf("last turn = %+v", last)
	}
	if last.Outcome.CallID != "c1" || last.Outcome.Name != "f" || last.Outcome.Text != "done" {
		t.Fatalf("outcome = %+v", last.Outcome)
	}
}

func TestVendorReasoningIsReadAsReasoning(t *testing.T) {
	// Several OpenAI-compatible vendors carry the model's thinking in
	// `reasoning_content` on the assistant message.
	conv, _ := openAIChat{}.ParseRequest(gjson.Parse(`{"messages":[
	  {"role":"user","content":"go"},
	  {"role":"assistant","content":"sure","reasoning_content":"first I will..."}]}`))
	if got := conv.Turns[1].Reasoning; got != "first I will..." {
		t.Errorf("Reasoning = %q", got)
	}
}

func TestAHalfTokenSplitAcrossArgumentDeltasStillRestores(t *testing.T) {
	// ⚠️ The normal case, not the exception: deltas are token-sized and the placeholder
	// is fourteen characters. Restoring only when a whole token fits inside one delta is
	// what handed the client `{"to": "${OGR_EMAIL_1}"}` and made it act on a value that
	// names nothing. What matters is that the SEQUENCE comes out restored.
	mapping := map[string]string{"${OGR_EMAIL_1}": "ada@example.com"}
	scan := NewScanner(openAIChat{}.NewDecoder(NewRestorer(mapping)))
	var out strings.Builder
	for _, frag := range []string{`{\"to\":\"${OGR`, `_EMAIL`, `_1}\"}`} {
		line := `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"` + frag + `"}}]}}]}` + "\n\n"
		out.Write(scan.Chunk([]byte(line), false))
	}
	out.Write(scan.Chunk([]byte("data: [DONE]\n\n"), true))

	// Reassemble what the client would parse.
	var args strings.Builder
	for _, block := range strings.Split(out.String(), "\n\n") {
		payload, ok := SSEData(strings.TrimSpace(block))
		if !ok || payload == "[DONE]" {
			continue
		}
		args.WriteString(gjson.Get(payload, "choices.0.delta.tool_calls.0.function.arguments").String())
	}
	if args.String() != `{"to":"ada@example.com"}` {
		t.Fatalf("the client would parse %q", args.String())
	}
}

func TestAnAnswerEndingMidTokenIsNotTruncated(t *testing.T) {
	// The restorer holds back what might be the start of a token. At the frame that
	// closes the answer nothing more can complete it, so it has to be flushed — without
	// this, an answer ending in `$` silently loses its last characters and only the
	// client could ever notice.
	scan := NewScanner(openAIChat{}.NewDecoder(NewRestorer(map[string]string{"${OGR_EMAIL_1}": "x@y.z"})))
	var out strings.Builder
	out.Write(scan.Chunk([]byte(`data: {"choices":[{"delta":{"content":"cost: $"}}]}`+"\n\n"), false))
	out.Write(scan.Chunk([]byte(`data: {"choices":[{"delta":{},"finish_reason":"stop"}]}`+"\n\n"), false))
	out.Write(scan.Chunk([]byte("data: [DONE]\n\n"), true))

	var text strings.Builder
	for _, block := range strings.Split(out.String(), "\n\n") {
		payload, ok := SSEData(strings.TrimSpace(block))
		if !ok || payload == "[DONE]" {
			continue
		}
		text.WriteString(gjson.Get(payload, "choices.0.delta.content").String())
	}
	if text.String() != "cost: $" {
		t.Fatalf("the caller received %q, want the whole answer", text.String())
	}
}
