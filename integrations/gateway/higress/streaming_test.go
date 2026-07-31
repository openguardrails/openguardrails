package main

import (
	"strings"
	"testing"

	"github.com/tidwall/gjson"
)

var streamMapping = map[string]string{
	"${OGR_EMAIL_1}":   "ada@example.com",
	"${OGR_EMAIL_11}":  "grace@example.com",
	"__ogr_secret_1__": "sk-live-4f9a2c7e1b8d",
}

// feed pushes text through the restorer in the given chunk splits. The splits
// are the point: a token that straddles a chunk boundary must still restore.
func feed(chunks []string) string {
	sp := newStreamProcessor(streamMapping)
	out := ""
	for i, c := range chunks {
		out += sp.field(&sp.contentBuf, c, i == len(chunks)-1)
	}
	return out
}

func TestRestoreInOneChunk(t *testing.T) {
	cases := map[string]string{
		"no tokens here":            "no tokens here",
		"mail ${OGR_EMAIL_1} now":   "mail ada@example.com now",
		"${OGR_EMAIL_1}x":           "ada@example.comx",
		"key __ogr_secret_1__ end":  "key sk-live-4f9a2c7e1b8d end",
		"${OGR_EMAIL_11}":           "grace@example.com",
		"${OGR_EMAIL_2}":            "${OGR_EMAIL_2}",
		`mail ${OGR\_EMAIL\_1} now`: "mail ada@example.com now",
		`C:\notes`:                  `C:\notes`,
	}
	for in, want := range cases {
		if got := feed([]string{in}); got != want {
			t.Errorf("feed(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestRestoreAcrossChunkBoundaries(t *testing.T) {
	cases := []struct {
		chunks []string
		want   string
	}{
		{[]string{"mail ${OGR_EM", "AIL_1} now"}, "mail ada@example.com now"},
		{[]string{"mail $", "{OGR_EMAIL_1}"}, "mail ada@example.com"},
		{[]string{"${OGR_EMAIL_1", "1}"}, "grace@example.com"}, // _1 must not fire early
		{split("hi ${OGR_EMAIL_1}!"), "hi ada@example.com!"},   // one byte at a time
		{split(`hi ${OGR\_EMAIL\_1}!`), "hi ada@example.com!"},
		{[]string{"tail ${OGR_EM"}, "tail ${OGR_EM"}, // truncated at end of stream
	}
	for _, c := range cases {
		if got := feed(c.chunks); got != c.want {
			t.Errorf("feed(%v) = %q, want %q", c.chunks, got, c.want)
		}
	}
}

func split(s string) []string {
	out := make([]string, 0, len(s))
	for i := 0; i < len(s); i++ {
		out = append(out, s[i:i+1])
	}
	return out
}

func TestStreamRestoresAndReassembles(t *testing.T) {
	sp := newStreamProcessor(streamMapping)
	chunks := []string{
		`data: {"choices":[{"delta":{"content":"mail ${OGR_EM"}}]}` + "\n\n",
		`data: {"choices":[{"delta":{"content":"AIL_1} ok"}}]}` + "\n\n",
		"data: [DONE]\n\n",
	}
	out := ""
	for i, c := range chunks {
		out += string(sp.ProcessChunk([]byte(c), i == len(chunks)-1))
	}
	if !strings.Contains(out, "ada@example.com") {
		t.Errorf("stream did not restore across SSE events: %q", out)
	}
	if strings.Contains(out, "OGR_EM") {
		t.Errorf("a placeholder reached the client: %q", out)
	}
	if !strings.Contains(out, "[DONE]") {
		t.Errorf("stream terminator dropped: %q", out)
	}

	// The reassembled text is what the model PRODUCED — placeholders intact —
	// because detection runs on that, before restoration.
	content, calls := sp.Result()
	if content != "mail ${OGR_EMAIL_1} ok" {
		t.Errorf("accumulated content = %q", content)
	}
	if len(calls) != 0 {
		t.Errorf("calls = %+v", calls)
	}
}

func TestStreamReassemblesToolCallDeltas(t *testing.T) {
	sp := newStreamProcessor(map[string]string{})
	chunks := []string{
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"shell","arguments":"{\"cmd\":"}}]}}]}` + "\n\n",
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"rm -rf /\"}"}}]}}]}` + "\n\n",
		`data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}` + "\n\n",
		"data: [DONE]\n\n",
	}
	for i, c := range chunks {
		sp.ProcessChunk([]byte(c), i == len(chunks)-1)
	}
	_, calls := sp.Result()
	if len(calls) != 1 {
		t.Fatalf("calls = %+v, want the one the model asked for", calls)
	}
	if calls[0].Name != "shell" || calls[0].Arguments != `{"cmd":"rm -rf /"}` {
		t.Fatalf("reassembled call = %+v", calls[0])
	}
	if calls[0].ID != "call_1" {
		t.Fatalf("call id = %q", calls[0].ID)
	}
	if sp.finish != "tool_calls" {
		t.Fatalf("finish_reason = %q", sp.finish)
	}
}

func TestToolCallArgumentsAreRestoredForTheClient(t *testing.T) {
	// Handing the client `${OGR_EMAIL_1}` as a tool argument means it executes
	// on a broken value, so the restore has to reach inside the arguments too.
	sp := newStreamProcessor(streamMapping)
	line := `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"mail","arguments":"{\"to\":\"${OGR_EMAIL_1}\"}"}}]}}]}` + "\n"
	out := string(sp.ProcessChunk([]byte(line), true))
	if !strings.Contains(out, "ada@example.com") {
		t.Fatalf("tool argument not restored: %s", out)
	}
	if got := gjson.Get(strings.TrimPrefix(strings.TrimSpace(out), "data: "),
		"choices.0.delta.tool_calls.0.function.arguments").String(); got != `{"to":"ada@example.com"}` {
		t.Fatalf("arguments = %q", got)
	}
}

func TestEmptyMappingIsPassthrough(t *testing.T) {
	sp := newStreamProcessor(map[string]string{})
	in := `data: {"choices":[{"delta":{"content":"__ogr_secret_1__"}}]}` + "\n"
	if got := string(sp.ProcessChunk([]byte(in), true)); got != in {
		t.Errorf("empty mapping modified the stream: %q", got)
	}
}
