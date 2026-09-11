package protocol

import (
	"bytes"
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

func TestBareReasoningIsReadAsReasoning(t *testing.T) {
	// ⚠️ THE OTHER SPELLING, AND IT ARRIVES ALONE. `reasoning_content` is DeepSeek's
	// and vLLM's; `reasoning` is what OpenRouter normalises to and what the qwen3.6
	// family sends — 240 deltas of it against 0 of `reasoning_content` on the traffic
	// that found this. A reader that knows only the first reports the reply EMPTY.
	conv, _ := openAIChat{}.ParseRequest(gjson.Parse(`{"messages":[
	  {"role":"user","content":"go"},
	  {"role":"assistant","content":"sure","reasoning":"first I will..."}]}`))
	if got := conv.Turns[1].Reasoning; got != "first I will..." {
		t.Errorf("request turn Reasoning = %q", got)
	}
	out := openAIChat{}.ParseResponse(gjson.Parse(
		`{"choices":[{"message":{"role":"assistant","content":"sure","reasoning":"because"}}]}`))
	if out.Reasoning != "because" {
		t.Errorf("response Reasoning = %q", out.Reasoning)
	}
	if out.Empty() {
		t.Error("a reply with prose and bare reasoning reads as empty")
	}
}

func TestBufferedRestoreCoversBothReasoningSpellings(t *testing.T) {
	// An unrestored placeholder in the thinking pane is the cosmetic half of the
	// same defect — and it was ONLY ever fixed for one spelling, in the stream.
	mapping := map[string]string{"${OGR_PHONE_1}": "13800000000"}
	for _, field := range []string{"reasoning_content", "reasoning"} {
		body := `{"choices":[{"message":{"content":"done","` + field + `":"call ${OGR_PHONE_1} first"}}]}`
		out, changed := openAIChat{}.Restore(body, mapping)
		if !changed {
			t.Fatalf("%s: nothing restored", field)
		}
		if got := gjson.Get(out, "choices.0.message."+field).String(); got != "call 13800000000 first" {
			t.Errorf("%s restored to %q", field, got)
		}
	}
}

func TestAStreamedBareReasoningIsAccumulatedAndRestored(t *testing.T) {
	// Both halves of the bug in one stream: the text has to reach Output (or the
	// response half is lost as `unreadable`), and the placeholder has to come back
	// out restored under the SPELLING THE CLIENT IS READING.
	mapping := map[string]string{"${OGR_PHONE_1}": "13800000000"}
	dec := openAIChat{}.NewDecoder(NewRestorer(mapping))
	scan := NewScanner(dec)
	var out strings.Builder
	for _, frag := range []string{"call ${OGR", "_PHONE", "_1} now"} {
		out.Write(scan.Chunk([]byte(`data: {"choices":[{"delta":{"reasoning":"`+frag+`"}}]}`+"\n\n"), false))
	}
	out.Write(scan.Chunk([]byte("data: [DONE]\n\n"), true))

	got := dec.Output()
	if got.Reasoning != "call ${OGR_PHONE_1} now" {
		t.Errorf("accumulated reasoning = %q", got.Reasoning)
	}
	if got.Empty() {
		t.Error("a pure bare-reasoning reply reads as empty")
	}
	if !strings.Contains(out.String(), "13800000000") {
		t.Errorf("placeholder not restored to the client:\n%s", out.String())
	}
	if strings.Contains(out.String(), "${OGR_PHONE_1}") {
		t.Errorf("placeholder still on the wire:\n%s", out.String())
	}
	// ⚠️ The held tail is flushed under the stream's OWN spelling: a client reading
	// `reasoning` never sees a `reasoning_content` frame.
	if strings.Contains(out.String(), "reasoning_content") {
		t.Errorf("flushed under the wrong field name:\n%s", out.String())
	}
}

func TestAMirroredReasoningPairStaysConsistent(t *testing.T) {
	// A vendor that sends both must not be accumulated twice (one pending tail is
	// shared) and must not be delivered half-restored.
	mapping := map[string]string{"${OGR_PHONE_1}": "13800000000"}
	dec := openAIChat{}.NewDecoder(NewRestorer(mapping))
	scan := NewScanner(dec)
	var out strings.Builder
	line := `data: {"choices":[{"delta":{"reasoning_content":"call ${OGR_PHONE_1}","reasoning":"call ${OGR_PHONE_1}"}}]}` + "\n\n"
	out.Write(scan.Chunk([]byte(line), false))
	out.Write(scan.Chunk([]byte("data: [DONE]\n\n"), true))

	if got := dec.Output().Reasoning; got != "call ${OGR_PHONE_1}" {
		t.Errorf("mirrored reasoning counted %d times: %q", strings.Count(got, "call"), got)
	}
	frame := out.String()
	if strings.Count(frame, "13800000000") != 2 {
		t.Errorf("both spellings should carry the restored value:\n%s", frame)
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

func TestEnsureStreamUsageOptsInExactlyWhenNeeded(t *testing.T) {
	// A non-stream request is untouched: buffered replies carry usage anyway.
	if out, injected := (openAIChat{}).EnsureStreamUsage(`{"model":"m","messages":[]}`); injected || gjson.Get(out, "stream_options").Exists() {
		t.Fatalf("a non-stream request was rewritten: %s", out)
	}
	// A client that opted in already keeps its body byte-identical — and keeps its
	// usage frame (injected=false means nothing gets swallowed).
	in := `{"model":"m","stream":true,"stream_options":{"include_usage":true},"messages":[]}`
	if out, injected := (openAIChat{}).EnsureStreamUsage(in); injected || out != in {
		t.Fatalf("an already-opted-in request was rewritten: %s", out)
	}
	// A stream with no opt-in gets one, and the injection is reported so the
	// synthetic frame can be withheld from the client.
	out, injected := openAIChat{}.EnsureStreamUsage(`{"model":"m","stream":true,"messages":[{"role":"user","content":"hi"}]}`)
	if !injected {
		t.Fatal("a bare stream request was not opted in")
	}
	if !gjson.Get(out, "stream_options.include_usage").Bool() {
		t.Fatalf("include_usage not set: %s", out)
	}
	if gjson.Get(out, "messages.0.content").String() != "hi" {
		t.Fatalf("the conversation was disturbed: %s", out)
	}
}

func TestTheInjectedUsageFrameIsSwallowedOnlyWhenArmed(t *testing.T) {
	usageFrame := `data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}` + "\n\n"

	// Armed: the gateway injected the opt-in, so the client never asked for this
	// frame — captured for the report, withheld from the wire.
	dec := openAIChat{}.NewDecoder(NewRestorer(nil))
	dec.(*chatDecoder).SuppressUsageFrame()
	scan := NewScanner(dec)
	out := string(scan.Chunk([]byte(usageFrame+"data: [DONE]\n\n"), true))
	if strings.Contains(out, "prompt_tokens") {
		t.Fatalf("the synthetic usage frame reached the client: %q", out)
	}
	if !strings.Contains(out, "[DONE]") {
		t.Fatalf("the stream terminator was lost: %q", out)
	}
	u := scan.Output().Usage
	if u == nil || u.InputTokens != 10 || u.OutputTokens != 5 {
		t.Fatalf("the swallowed frame was not captured: %+v", u)
	}

	// Not armed: the client (or the provider, unasked) produced the frame, and it
	// passes through untouched.
	plain := NewScanner(openAIChat{}.NewDecoder(NewRestorer(nil)))
	out = string(plain.Chunk([]byte(usageFrame+"data: [DONE]\n\n"), true))
	if !strings.Contains(out, "prompt_tokens") {
		t.Fatalf("a frame the client asked for was swallowed: %q", out)
	}
	if u := plain.Output().Usage; u == nil || u.InputTokens != 10 {
		t.Fatalf("usage not captured on the passthrough: %+v", u)
	}
}

func TestAUsageBearingContentChunkIsNeverSwallowed(t *testing.T) {
	// Some vendors report usage on the LAST CONTENT chunk instead of a dedicated
	// frame. Swallowing that one would eat part of the answer.
	dec := openAIChat{}.NewDecoder(NewRestorer(nil))
	dec.(*chatDecoder).SuppressUsageFrame()
	scan := NewScanner(dec)
	frame := `data: {"choices":[{"delta":{"content":"bye"},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":3}}` + "\n\n"
	out := string(scan.Chunk([]byte(frame+"data: [DONE]\n\n"), true))
	if !strings.Contains(out, "bye") {
		t.Fatalf("a content chunk was swallowed with its usage: %q", out)
	}
	if u := scan.Output().Usage; u == nil || u.InputTokens != 7 {
		t.Fatalf("usage on a content chunk was not captured: %+v", u)
	}
}

func TestChatUsageReadsTheDetailCounters(t *testing.T) {
	out := openAIChat{}.ParseResponse(gjson.Parse(`{"choices":[{"message":{"content":"ok"}}],
	  "usage":{"prompt_tokens":100,"completion_tokens":40,
	    "prompt_tokens_details":{"cached_tokens":25},
	    "completion_tokens_details":{"reasoning_tokens":12}}}`))
	u := out.Usage
	if u == nil || u.CacheReadTokens != 25 || u.ReasoningTokens != 12 {
		t.Fatalf("detail counters lost: %+v", u)
	}
}

/*
 * ⚠️⚠️ ChunkSegments is what makes a head budget smaller than one arrival spendable:
 * an upstream chunk here is ~16 KB, so releasing in whole chunks cannot express any
 * bound below a third of the answer. Three properties, and each one has a failure
 * the others do not catch.
 */
func TestChunkSegmentsSplitsAtFrameBoundaries(t *testing.T) {
	frame := func(txt string) string {
		return `data: {"choices":[{"index":0,"delta":{"content":"` + txt + `"}}]}` + "\n\n"
	}
	raw := frame("ab") + frame("cde") + frame("f")

	s := NewScanner(openAIChat{}.NewDecoder(NewRestorer(nil)))
	segs := s.ChunkSegments([]byte(raw), false)

	if len(segs) != 3 {
		t.Fatalf("got %d segments, want one per frame", len(segs))
	}
	// ① The running content tag is the exposure AFTER each frame — what the release
	// rule compares against — and it is cumulative, not per-frame.
	for i, want := range []int{2, 5, 6} {
		if segs[i].Content != want {
			t.Errorf("segment %d content tag = %d, want %d", i, segs[i].Content, want)
		}
	}
	// ② Every segment is a COMPLETE frame: releasing a `data:` line without its blank
	// terminator hands the client an event it can never dispatch.
	for i, seg := range segs {
		if !bytes.HasSuffix(seg.Bytes, []byte("\n\n")) {
			t.Errorf("segment %d does not end on a frame boundary: %q", i, seg.Bytes)
		}
	}
	// ③ Concatenated, they are byte-identical to what the unheld lane forwards — the
	// split is a release unit, never a change to the stream.
	var joined []byte
	for _, seg := range segs {
		joined = append(joined, seg.Bytes...)
	}
	if got := string(NewScanner(openAIChat{}.NewDecoder(NewRestorer(nil))).Chunk([]byte(raw), false)); got != string(joined) {
		t.Fatalf("segments != Chunk output:\n  %q\n  %q", joined, got)
	}
}

// ⚠️ A frame split across two arrivals must not be released in halves: the carry
// holds the partial line, so the first arrival yields no complete frame at all.
func TestChunkSegmentsHoldsAFrameSplitAcrossArrivals(t *testing.T) {
	full := `data: {"choices":[{"index":0,"delta":{"content":"hello"}}]}` + "\n\n"
	s := NewScanner(openAIChat{}.NewDecoder(NewRestorer(nil)))
	if segs := s.ChunkSegments([]byte(full[:20]), false); len(segs) != 0 {
		t.Fatalf("a partial frame produced %d segments — the client would get half an event", len(segs))
	}
	segs := s.ChunkSegments([]byte(full[20:]), false)
	if len(segs) != 1 || string(segs[0].Bytes) != full {
		t.Fatalf("the rejoined frame came out as %q", segs)
	}
	if segs[0].Content != 5 {
		t.Fatalf("content tag = %d, want 5", segs[0].Content)
	}
}
