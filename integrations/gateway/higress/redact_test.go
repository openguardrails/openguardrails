package main

import (
	"strings"
	"testing"

	"github.com/openguardrails/higress/protocol"
	"github.com/tidwall/gjson"
)

// The span applier is the interop surface with the runtime's `modifications.spans`,
// and it fails SILENTLY in both directions: a span we cannot resolve masks nothing,
// and a span applied to the wrong bytes masks something nobody detected while the
// real value travels on. Both look like a healthy gateway — which is why every drop
// is COUNTED (unresolved), never swallowed.

const spanBody = `{"model":"m","messages":[` +
	`{"role":"system","content":"You are a helper."},` +
	`{"role":"user","content":"mail ada@example.com now"}]}`

func TestASpanIsSplicedInPlaceAndTheValueLearned(t *testing.T) {
	spans := []Span{{
		Path: "payload.messages.1.content", Start: 5, End: 20,
		Replacement: "${OGR_EMAIL_1}",
	}}
	body, applied, unresolved, learned := applySpans(spanBody, spans)
	if applied != 1 || unresolved != 0 {
		t.Fatalf("applied=%d unresolved=%d", applied, unresolved)
	}
	if got := gjson.Get(body, "messages.1.content").String(); got != "mail ${OGR_EMAIL_1} now" {
		t.Fatalf("content = %q", got)
	}
	// What the splice displaced is the restore map: the model may echo the token and
	// the caller must receive its own data back.
	if learned["${OGR_EMAIL_1}"] != "ada@example.com" {
		t.Fatalf("learned = %v", learned)
	}
	// The rest of the body is untouched.
	if gjson.Get(body, "messages.0.content").String() != "You are a helper." {
		t.Fatal("an unrelated field changed")
	}
}

func TestOffsetsAreCharactersNotBytes(t *testing.T) {
	// The regression this suite exists for: on a Chinese prompt, byte slicing lands a
	// third of the way into the span, so the value that had to be removed reaches the
	// model while the logs say "masked". Found live 2026-07-30.
	body := `{"messages":[{"role":"user","content":"请原样复述这个邮箱：kate@example.com"}]}`
	spans := []Span{{
		Path: "payload.messages.0.content", Start: 10, End: 26,
		Replacement: "${OGR_EMAIL_1}",
	}}
	next, applied, _, learned := applySpans(body, spans)
	if applied != 1 {
		t.Fatalf("applied = %d", applied)
	}
	got := gjson.Get(next, "messages.0.content").String()
	if strings.Contains(got, "kate@example.com") {
		t.Fatalf("plaintext survived masking: %q", got)
	}
	if !strings.Contains(got, "请原样复述这个邮箱：") {
		t.Fatalf("masking mangled the surrounding text: %q", got)
	}
	if learned["${OGR_EMAIL_1}"] != "kate@example.com" {
		t.Fatalf("learned = %v", learned)
	}
}

func TestSpansOnOnePathApplyHighestOffsetFirst(t *testing.T) {
	// Two spans on one string: applying the earlier one first would shift the bytes
	// the later offsets were computed against.
	body := `{"messages":[{"role":"user","content":"a@b.io and c@d.io wrote"}]}`
	spans := []Span{
		{Path: "payload.messages.0.content", Start: 0, End: 6, Replacement: "${OGR_EMAIL_1}"},
		{Path: "payload.messages.0.content", Start: 11, End: 17, Replacement: "${OGR_EMAIL_2}"},
	}
	next, applied, unresolved, _ := applySpans(body, spans)
	if applied != 2 || unresolved != 0 {
		t.Fatalf("applied=%d unresolved=%d", applied, unresolved)
	}
	if got := gjson.Get(next, "messages.0.content").String(); got != "${OGR_EMAIL_1} and ${OGR_EMAIL_2} wrote" {
		t.Fatalf("content = %q", got)
	}
}

func TestAnUnresolvableSpanIsDroppedAndCountedNeverAppliedElsewhere(t *testing.T) {
	cases := [][]Span{
		{{Path: "payload.nope", Start: 0, End: 4, Replacement: "${X}"}},                  // no such field
		{{Path: "payload.messages", Start: 0, End: 4, Replacement: "${X}"}},              // not a string
		{{Path: "payload.messages.1.content", Start: 5, End: 9999, Replacement: "${X}"}}, // past the end
		{{Path: "payload.messages.1.content", Start: -1, End: 4, Replacement: "${X}"}},   // negative
		{{Path: "payload.messages.1.content", Start: 7, End: 7, Replacement: "${X}"}},    // empty range
		{{Path: "payload.messages.1.content", Start: 0, End: 4, Replacement: ""}},        // no token
		{{Path: "messages.1.content", Start: 0, End: 4, Replacement: "${X}"}},            // no payload. prefix
		{{Path: "payload", Start: 0, End: 4, Replacement: "${X}"}},                       // the whole payload
	}
	for _, spans := range cases {
		next, applied, unresolved, _ := applySpans(spanBody, spans)
		if applied != 0 || unresolved != 1 {
			t.Errorf("%+v → applied=%d unresolved=%d, want 0/1", spans[0], applied, unresolved)
		}
		if next != spanBody {
			t.Errorf("%+v changed the body", spans[0])
		}
	}
}

func TestBracketPathsFoldToTheDottedForm(t *testing.T) {
	spans := []Span{{
		Path: "payload.messages[1].content", Start: 5, End: 20,
		Replacement: "${OGR_EMAIL_1}",
	}}
	next, applied, _, _ := applySpans(spanBody, spans)
	if applied != 1 {
		t.Fatalf("bracket path did not resolve")
	}
	if got := gjson.Get(next, "messages.1.content").String(); got != "mail ${OGR_EMAIL_1} now" {
		t.Fatalf("content = %q", got)
	}
}

// --- the restore half ----------------------------------------------------------
//
// Masking rewrites the request; the reply may echo the token, and the caller must
// receive its own data back. The mapping learned from applySpans feeds the same
// protocol Restore machinery the streaming path uses.

func TestMaskThenRestoreRoundTrip(t *testing.T) {
	spans := []Span{{
		Path: "payload.messages.1.content", Start: 5, End: 20,
		Replacement: "${OGR_EMAIL_1}",
	}}
	_, _, _, learned := applySpans(spanBody, spans)

	reply := "your address is ${OGR_EMAIL_1}"
	if got := protocol.RestoreString(reply, learned); got != "your address is ada@example.com" {
		t.Fatalf("restored = %q", got)
	}
}

func TestRestoreIsWholeTokenOnly(t *testing.T) {
	// A restorer that guesses is an exfiltration oracle: near misses must not
	// resolve to a value the attacker was never shown.
	mapping := map[string]string{"${OGR_EMAIL_1}": "ada@example.com"}
	for _, near := range []string{"${OGR_EMAIL_2}", "${OGR_EMAIL_1", "$OGR_EMAIL_1", "${OGR_EMAIL_11}"} {
		if got := protocol.RestoreString(near, mapping); got != near {
			t.Errorf("RestoreString(%q) = %q, want it left alone", near, got)
		}
	}
}

func TestRestoreAbsorbsMarkdownEscaping(t *testing.T) {
	mapping := map[string]string{"${OGR_EMAIL_1}": "ada@example.com"}
	cases := map[string]string{
		`mail ${OGR\_EMAIL\_1} now`: "mail ada@example.com now",
		`\$\{OGR\_EMAIL\_1\}`:       "ada@example.com",
		`C:\notes stay literal`:     `C:\notes stay literal`,
	}
	for in, want := range cases {
		if got := protocol.RestoreString(in, mapping); got != want {
			t.Errorf("RestoreString(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSessionAdoptsBoundedly(t *testing.T) {
	st := newSessionState()
	big := map[string]string{}
	for i := 0; i < maxTokens+50; i++ {
		big["${OGR_PII_"+string(rune('a'+i%26))+string(rune('a'+(i/26)%26))+string(rune('a'+i/676))+"}"] = "value"
	}
	st.adopt(big)
	if len(st.Mapping) > maxTokens {
		t.Fatalf("mapping grew to %d, cap is %d", len(st.Mapping), maxTokens)
	}
}
