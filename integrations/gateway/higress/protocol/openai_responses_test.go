package protocol

import (
	"strings"
	"testing"

	"github.com/tidwall/gjson"
)

// What is true of `openai.responses` and of nothing else.

func TestAStringInputIsAConversation(t *testing.T) {
	// The minimal Responses request: `input` is a bare string, not a list.
	conv, ok := openAIResponses{}.ParseRequest(gjson.Parse(`{"model":"m","input":"hello"}`))
	if !ok {
		t.Fatal("a string input parsed to no conversation")
	}
	if len(conv.Turns) != 1 || conv.Turns[0].Text != "hello" {
		t.Fatalf("turns = %+v", conv.Turns)
	}
}

func TestOneModelTurnStaysOneTurn(t *testing.T) {
	// ⚠️ A reply that says something and then calls two tools arrives as three items.
	// Left as three turns, the agent-loop boundary — "everything after the model's LAST
	// turn" — would land in the middle of one reply, and the outcomes fed back after it
	// would be read as already-judged history.
	body := gjson.Parse(`{"input":[
	  {"type":"message","role":"user","content":[{"type":"input_text","text":"go"}]},
	  {"type":"reasoning","summary":[{"type":"summary_text","text":"I should call both"}]},
	  {"type":"message","role":"assistant","content":[{"type":"output_text","text":"on it"}]},
	  {"type":"function_call","call_id":"c1","name":"a","arguments":"{}"},
	  {"type":"function_call","call_id":"c2","name":"b","arguments":"{}"},
	  {"type":"function_call_output","call_id":"c1","output":"one"},
	  {"type":"function_call_output","call_id":"c2","output":"two"}]}`)
	conv, _ := openAIResponses{}.ParseRequest(body)

	if len(conv.Turns) != 4 {
		t.Fatalf("turns = %d, want user + one assistant + two outcomes: %+v", len(conv.Turns), conv.Turns)
	}
	a := conv.Turns[1]
	if a.Role != RoleAssistant || a.Text != "on it" || a.Reasoning != "I should call both" {
		t.Fatalf("assistant turn = %+v", a)
	}
	if len(a.Actions) != 2 {
		t.Fatalf("actions = %+v", a.Actions)
	}
	// And the loop boundary lands where it should: both outcomes are new input.
	in := conv.NewInput()
	if len(in) != 2 || in[0].Role != RoleTool || in[1].Role != RoleTool {
		t.Fatalf("NewInput = %+v", in)
	}
}

func TestInstructionsAreTheSystemPrompt(t *testing.T) {
	conv, _ := openAIResponses{}.ParseRequest(gjson.Parse(
		`{"instructions":"You are Codex.","input":"hi"}`))
	if conv.System != "You are Codex." {
		t.Errorf("System = %q", conv.System)
	}
}

func TestMaskingReachesAFunctionCallOutput(t *testing.T) {
	// The indirect-injection surface, under this protocol's own field name.
	body := `{"instructions":"prompt ada@example.com","input":[
	  {"type":"message","role":"user","content":[{"type":"input_text","text":"ask ada@example.com"}]},
	  {"type":"function_call_output","call_id":"c1","output":"the doc names ada@example.com"}]}`
	out, n := openAIResponses{}.Mask(body, []Redaction{{Token: "${OGR_EMAIL_1}", Value: "ada@example.com"}})
	if n != 3 {
		t.Errorf("masked %d strings, want 3 (instructions, question, tool output)", n)
	}
	if strings.Contains(out, "ada@example.com") {
		t.Fatalf("plaintext survived:\n%s", out)
	}
}

// ⚠️ The failure this pins is invisible until someone reads the object instead of the
// screen: an SDK assembles its final result from the TERMINAL event, which repeats the
// whole reply. Restoring only the deltas leaves every visible token correct and the
// caller's result object full of placeholders.
func TestTheTerminalEventIsRestoredToo(t *testing.T) {
	mapping := map[string]string{"${OGR_EMAIL_1}": "ada@example.com"}
	stream := `event: response.output_text.delta
data: {"type":"response.output_text.delta","output_index":0,"delta":"mail ${OGR_EMAIL_1}"}

event: response.output_text.done
data: {"type":"response.output_text.done","output_index":0,"text":"mail ${OGR_EMAIL_1}"}

event: response.completed
data: {"type":"response.completed","response":{"id":"r1","status":"completed","output_text":"mail ${OGR_EMAIL_1}"}}

`
	scan := NewScanner(openAIResponses{}.NewDecoder(NewRestorer(mapping)))
	out := string(scan.Chunk([]byte(stream), true))
	if strings.Contains(out, "${OGR_EMAIL_1}") {
		t.Fatalf("a placeholder survived into the caller's stream:\n%s", out)
	}
	if strings.Count(out, "ada@example.com") != 3 {
		t.Errorf("restored %d of 3 occurrences:\n%s", strings.Count(out, "ada@example.com"), out)
	}
	if scan.Output().Text != "mail ${OGR_EMAIL_1}" {
		t.Errorf("what we report must keep the placeholder, got %q", scan.Output().Text)
	}
}

func TestARefusalPartIsReadAsText(t *testing.T) {
	// The API's own refusal content part. A reader that only knows `output_text` would
	// report the model as having said nothing.
	out := openAIResponses{}.ParseResponse(gjson.Parse(`{"output":[
	  {"type":"message","role":"assistant","content":[{"type":"refusal","refusal":"I can't help with that."}]}]}`))
	if out.Text != "I can't help with that." {
		t.Errorf("Text = %q", out.Text)
	}
}

func TestARefusalDoesNotClaimTheModelAnswered(t *testing.T) {
	body := openAIResponses{}.Refuse("m", "no")
	if got := gjson.Get(body, "status").String(); got != "incomplete" {
		t.Errorf("status = %q — claiming `completed` tells every harness downstream "+
			"that the model answered normally", got)
	}
	if got := gjson.Get(body, "incomplete_details.reason").String(); got != "content_filter" {
		t.Errorf("incomplete_details.reason = %q", got)
	}
}

func TestResponsesUsageReadsTheReasoningAndCacheDetails(t *testing.T) {
	out := openAIResponses{}.ParseResponse(gjson.Parse(`{"output":[
	  {"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}],
	  "usage":{"input_tokens":90,"output_tokens":35,
	    "input_tokens_details":{"cached_tokens":20},
	    "output_tokens_details":{"reasoning_tokens":8}}}`))
	u := out.Usage
	if u == nil || u.InputTokens != 90 || u.OutputTokens != 35 || u.CacheReadTokens != 20 || u.ReasoningTokens != 8 {
		t.Fatalf("usage = %+v", u)
	}
}
