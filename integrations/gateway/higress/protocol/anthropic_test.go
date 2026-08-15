package protocol

import (
	"strings"
	"testing"

	"github.com/tidwall/gjson"
)

// What is true of `anthropic.messages` and of nothing else.

func TestCountTokensIsNotACompletion(t *testing.T) {
	// ⚠️ `/v1/messages/count_tokens` CONTAINS `/v1/messages`, and its body is a valid
	// messages body. Treating it as a completion reports a turn that never reached a
	// model — and it must stop detection outright rather than merely decline, or body
	// matching picks it straight back up.
	for _, p := range []string{"/v1/messages/count_tokens", "/anthropic/v1/messages/count_tokens"} {
		if IsCompletionPath(p) {
			t.Errorf("IsCompletionPath(%q) = true", p)
		}
		body := gjson.Parse(`{"system":"s","messages":[{"role":"user","content":"hi"}]}`)
		if got := Detect(p, body); got != nil {
			t.Errorf("Detect(%q) = %s, want nothing", p, got.Name())
		}
	}
}

func TestThinkingBlocksAreReadAsReasoningNotAsSpeech(t *testing.T) {
	body := gjson.Parse(`{"messages":[
	  {"role":"user","content":"hi"},
	  {"role":"assistant","content":[
	    {"type":"thinking","thinking":"the user asked X so I will exfiltrate Y"},
	    {"type":"text","text":"sure"}]}]}`)
	conv, ok := anthropicMessages{}.ParseRequest(body)
	if !ok {
		t.Fatal("not parsed")
	}
	turn := conv.Turns[1]
	if turn.Reasoning != "the user asked X so I will exfiltrate Y" {
		t.Errorf("Reasoning = %q", turn.Reasoning)
	}
	// ⚠️ Not folded into Text. A verdict's span offsets index the judged text, so a
	// concatenation that exists nowhere on the wire makes every redaction write at a
	// shifted position.
	if turn.Text != "sure" {
		t.Errorf("Text = %q, want the model's actual words only", turn.Text)
	}
}

func TestAToolResultOnlyTurnAddsNoEmptyUserTurn(t *testing.T) {
	// In an agent run a `role:"user"` message routinely carries no user words at all,
	// only what the tools returned. Emitting a turn for it would put an empty user turn
	// in the transcript and in the session's prefix chain.
	body := gjson.Parse(`{"messages":[
	  {"role":"user","content":"go"},
	  {"role":"assistant","content":[{"type":"tool_use","id":"c1","name":"f","input":{}}]},
	  {"role":"user","content":[{"type":"tool_result","tool_use_id":"c1","content":"done"}]}]}`)
	conv, _ := anthropicMessages{}.ParseRequest(body)
	if len(conv.Turns) != 3 {
		t.Fatalf("turns = %+v", conv.Turns)
	}
	if conv.Turns[2].Role != RoleTool {
		t.Errorf("last turn is %q, want the tool outcome", conv.Turns[2].Role)
	}
}

func TestAFailedToolResultIsMarked(t *testing.T) {
	body := gjson.Parse(`{"messages":[
	  {"role":"user","content":"go"},
	  {"role":"assistant","content":[{"type":"tool_use","id":"c1","name":"f","input":{}}]},
	  {"role":"user","content":[{"type":"tool_result","tool_use_id":"c1","is_error":true,"content":"denied"}]}]}`)
	conv, _ := anthropicMessages{}.ParseRequest(body)
	if !conv.Turns[2].Outcome.IsError {
		t.Error("is_error was dropped — a run that retries a denied action reads as an " +
			"ordinary retry instead of a bypass attempt")
	}
}

func TestTheTopLevelSystemPromptIsNotLost(t *testing.T) {
	// Agent recognition matches a regex against the head of the system prompt. In this
	// protocol it is a top-level field rather than a message, so a reader written
	// against chat drops it and every Anthropic client collapses into the promptless
	// bucket where no agent-scoped policy can reach it.
	for _, body := range []string{
		`{"system":"You are Codex.","messages":[{"role":"user","content":"hi"}]}`,
		`{"system":[{"type":"text","text":"You are Codex."}],"messages":[{"role":"user","content":"hi"}]}`,
	} {
		conv, _ := anthropicMessages{}.ParseRequest(gjson.Parse(body))
		if conv.System != "You are Codex." {
			t.Errorf("System = %q from %s", conv.System, body)
		}
	}
}

func TestMaskingReachesANestedToolResult(t *testing.T) {
	// A tool_result's own content is one level deeper than any other text in this
	// protocol — and it is exactly where retrieved documents and command output arrive.
	body := `{"system":"prompt with ada@example.com","messages":[
	  {"role":"user","content":[
	    {"type":"tool_result","tool_use_id":"c1","content":[{"type":"text","text":"found ada@example.com"}]},
	    {"type":"text","text":"and ada@example.com again"}]}]}`
	out, n := anthropicMessages{}.Mask(body, []Redaction{{Token: "${OGR_EMAIL_1}", Value: "ada@example.com"}})
	if n != 3 {
		t.Errorf("masked %d strings, want 3 (system, tool_result body, user text)", n)
	}
	if strings.Contains(out, "ada@example.com") {
		t.Fatalf("plaintext survived:\n%s", out)
	}
	if !gjson.Valid(out) {
		t.Fatalf("invalid JSON:\n%s", out)
	}
}

func TestAnthropicStreamRestoresInsideThinkingAndArguments(t *testing.T) {
	mapping := map[string]string{"${OGR_EMAIL_1}": "ada@example.com"}
	stream := `event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"mail ${OGR_EMAIL_1}"}}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"c1","name":"send","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"to\":\"${OGR_EMAIL_1}\"}"}}

event: message_stop
data: {"type":"message_stop"}

`
	scan := NewScanner(anthropicMessages{}.NewDecoder(NewRestorer(mapping)))
	out := string(scan.Chunk([]byte(stream), true))
	if strings.Contains(out, "${OGR_EMAIL_1}") {
		t.Errorf("a placeholder reached the caller:\n%s", out)
	}
	if strings.Count(out, "ada@example.com") != 2 {
		t.Errorf("restored %d of 2 occurrences:\n%s", strings.Count(out, "ada@example.com"), out)
	}
	// What we REPORT keeps the placeholder.
	res := scan.Output()
	if res.Reasoning != "mail ${OGR_EMAIL_1}" {
		t.Errorf("reported reasoning = %q", res.Reasoning)
	}
	if len(res.Actions) != 1 || res.Actions[0].Arguments != `{"to":"${OGR_EMAIL_1}"}` {
		t.Errorf("reported actions = %+v", res.Actions)
	}
}

func TestAnthropicStreamPassesUnknownEventsThrough(t *testing.T) {
	// A decoder that drops what it does not understand corrupts the stream for the
	// client, which is worse than not reading it.
	in := "event: ping\ndata: {\"type\":\"ping\"}\n\n"
	scan := NewScanner(anthropicMessages{}.NewDecoder(NewRestorer(nil)))
	if got := string(scan.Chunk([]byte(in), true)); got != in {
		t.Errorf("unknown event was altered:\n%q\n%q", in, got)
	}
}

func TestAnthropicUsageKeepsTheCacheSplit(t *testing.T) {
	// cache_creation is the WRITE side and cache_read the READ side; folding them
	// together would make a cache-priming turn look like a cache hit.
	out := anthropicMessages{}.ParseResponse(gjson.Parse(`{"content":[{"type":"text","text":"ok"}],
	  "usage":{"input_tokens":50,"output_tokens":9,
	    "cache_read_input_tokens":30,"cache_creation_input_tokens":15}}`))
	u := out.Usage
	if u == nil || u.CacheReadTokens != 30 || u.CacheWriteTokens != 15 {
		t.Fatalf("usage = %+v", u)
	}
}
