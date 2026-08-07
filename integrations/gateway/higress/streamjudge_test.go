package main

import (
	"strings"
	"testing"

	"github.com/tidwall/gjson"
)

func TestJudgmentWindowOpensOnNewCharactersOnly(t *testing.T) {
	sg := &streamGuard{}
	if sg.dueForJudgment(119, 120, 8) {
		t.Fatal("judged before the window filled")
	}
	if !sg.dueForJudgment(120, 120, 8) {
		t.Fatal("the window filled and nothing fired")
	}

	// One call in flight at a time: the answer keeps growing while the PDP
	// thinks, and queueing a second judgment behind the first buys nothing.
	sg.inFlight = true
	if sg.dueForJudgment(400, 120, 8) {
		t.Fatal("a second judgment was dispatched while one was in flight")
	}
	sg.inFlight = false

	// The window is measured from the LAST dispatch, not from the start.
	sg.judgedAt = 120
	if sg.dueForJudgment(239, 120, 8) {
		t.Fatal("re-judged the same text")
	}
	if !sg.dueForJudgment(240, 120, 8) {
		t.Fatal("the second window filled and nothing fired")
	}

	// Bounded per stream: past the cap the answer is still reported and judged
	// whole at end of stream, it just stops being interruptible.
	sg.calls = 8
	if sg.dueForJudgment(10000, 120, 8) {
		t.Fatal("judged past the per-stream cap")
	}

	// And once a verdict has cut the stream there is nothing left to ask.
	sg.calls, sg.cut = 0, true
	if sg.dueForJudgment(10000, 120, 8) {
		t.Fatal("judged after the stream was cut")
	}
}

func TestTheRefusalTailIsWrittenExactlyOnce(t *testing.T) {
	sg := &streamGuard{cut: true, reason: "blocked by policy"}
	first := string(sg.tail("STUB-1"))
	if !strings.Contains(first, "blocked by policy") {
		t.Fatalf("the caller was not told why: %q", first)
	}
	if !strings.Contains(first, "content_filter") || !strings.Contains(first, "[DONE]") {
		t.Fatalf("the cut stream was not closed properly: %q", first)
	}
	// Every later chunk of the upstream's answer is swallowed, and swallowed
	// means nothing — a second copy of the refusal would read as a second answer.
	if got := sg.tail("STUB-1"); got != nil {
		t.Fatalf("the refusal was written twice: %q", got)
	}
}

func TestInterimJudgmentsAreMarkedPartial(t *testing.T) {
	// The flag is the whole reason one streamed answer stays ONE row in the
	// store rather than one row per window.
	found := ""
	for _, h := range partialHeaders(Config{apiKey: "k"}) {
		if strings.EqualFold(h[0], "ogr-partial") {
			found = h[1]
		}
	}
	if found != "1" {
		t.Fatalf("ogr-partial header = %q, want 1", found)
	}
}

func TestStreamingToolArgumentsRestoreWhenSplitAcrossDeltas(t *testing.T) {
	// The live failure this was written for: arguments stream token by token, so
	// a 14-character placeholder practically never fits in one delta. Restoring
	// only the deltas that happen to contain a whole token handed the client
	// `{"to": "${OGR_EMAIL_1}"}` — an agent then acts on a value naming nobody.
	sp := newStreamProcessor(streamMapping, true)
	chunks := []string{
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"mail","arguments":"{\"to\": \"${OG"}}]}}]}` + "\n\n",
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"R_EMAIL_1}\"}"}}]}}]}` + "\n\n",
		`data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}` + "\n\n",
		"data: [DONE]\n\n",
	}
	out := ""
	for i, c := range chunks {
		out += string(sp.ProcessChunk([]byte(c), i == len(chunks)-1))
	}

	// What the CLIENT parses is the concatenation of the argument deltas.
	args := ""
	for _, line := range strings.Split(out, "\n") {
		if !strings.HasPrefix(line, "data: ") || strings.Contains(line, "[DONE]") {
			continue
		}
		for _, tc := range gjson.Get(line[6:], "choices.0.delta.tool_calls").Array() {
			args += tc.Get("function.arguments").String()
		}
	}
	if args != `{"to": "ada@example.com"}` {
		t.Fatalf("the client would call the tool with %q", args)
	}

	// The EVENT keeps the placeholders: detection runs on what the model
	// produced, before restoration.
	_, calls := sp.Result()
	if len(calls) != 1 || calls[0].Arguments != `{"to": "${OGR_EMAIL_1}"}` {
		t.Fatalf("reported call = %+v", calls)
	}
}

func TestAHeldBackTailIsFlushedBeforeTheStreamCloses(t *testing.T) {
	// The restorer holds anything that might be the start of a token. If the
	// answer ENDS there, nothing completes it — and it used to be dropped, so an
	// answer ending in `$` silently lost its last character.
	for _, ending := range []string{"data: [DONE]\n\n", `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}` + "\n\n"} {
		sp := newStreamProcessor(streamMapping, true)
		out := string(sp.ProcessChunk([]byte(`data: {"choices":[{"delta":{"content":"总价 ${OGR_EM"}}]}`+"\n\n"), false))
		out += string(sp.ProcessChunk([]byte(ending), true))

		delivered := ""
		for _, line := range strings.Split(out, "\n") {
			if !strings.HasPrefix(line, "data: ") || strings.Contains(line, "[DONE]") {
				continue
			}
			delivered += gjson.Get(line[6:], "choices.0.delta.content").String()
		}
		if delivered != "总价 ${OGR_EM" {
			t.Fatalf("ending %q: client received %q, want the text as produced", ending, delivered)
		}
	}
}

func TestBufferedRestoreReachesToolArguments(t *testing.T) {
	body := `{"choices":[{"message":{"content":"发到 ${OGR_EMAIL_1}",` +
		`"tool_calls":[{"id":"c1","function":{"name":"mail","arguments":"{\"to\":\"${OGR_EMAIL_1}\"}"}}]}}]}`
	out, changed := restoreBody(body, streamMapping)
	if !changed {
		t.Fatal("nothing was restored")
	}
	if got := gjson.Get(out, "choices.0.message.content").String(); got != "发到 ada@example.com" {
		t.Fatalf("content = %q", got)
	}
	if got := gjson.Get(out, "choices.0.message.tool_calls.0.function.arguments").String(); got != `{"to":"ada@example.com"}` {
		t.Fatalf("tool arguments = %q", got)
	}
	if _, changed := restoreBody(body, map[string]string{}); changed {
		t.Fatal("an empty mapping rewrote the reply")
	}
}
