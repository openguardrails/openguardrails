package main

import (
	"strings"
	"testing"

	"github.com/openguardrails/higress/protocol"
	"github.com/tidwall/gjson"
)

// judgedOn builds the minimal judged event these tests need: one text, at the payload
// path a finding with no `path` of its own is taken to mean.
func judgedOn(text string) *GuardEvent {
	return (&GuardEvent{}).withText("payload.text", text)
}

func TestTokenShape(t *testing.T) {
	if got := mintToken("EMAIL", 1); got != "${OGR_EMAIL_1}" {
		t.Fatalf("mintToken = %q", got)
	}
	// `__` is bold markup: a model formatting its answer escapes it to `\_\_`,
	// and a token that depends on it arriving intact never restores.
	if strings.Contains(mintToken("NATIONAL_ID", 999), "__") {
		t.Fatal("token carries a double underscore")
	}
}

func TestPlaceholderTypeLongestPrefixWins(t *testing.T) {
	cases := map[string]string{
		"privacy.pii.email":            "EMAIL",
		"privacy.pii.national_id.cn":   "NATIONAL_ID", // a new variant rolls up
		"privacy.pii.unheard_of":       "PII",
		"security.secret_leak.aws_key": "SECRET",
		"safety.violent_crime":         "", // moderation is judged, never masked
		"security.supply_chain":        "",
	}
	for category, want := range cases {
		if got := placeholderType(category); got != want {
			t.Errorf("placeholderType(%q) = %q, want %q", category, got, want)
		}
	}
}

func TestSpansAreRecoveredFromOffsetsAndOurOwnCopy(t *testing.T) {
	text := "mail ada@example.com now"
	v := gjson.Parse(`{"findings":[{"category":"privacy.pii.email","start":5,"end":20}]}`)
	spans, _ := spansFromVerdict(v, judgedOn(text))
	if len(spans) != 1 || spans[0].Matched != "ada@example.com" {
		t.Fatalf("spans = %+v", spans)
	}
}

func TestOffsetsAreCharactersNotBytes(t *testing.T) {
	// The regression this suite exists for: on a Chinese prompt, byte slicing
	// lands a third of the way into the span, so the value that had to be
	// removed reaches the model while the logs say "masked".
	text := "请原样复述这个邮箱：kate@example.com"
	v := gjson.Parse(`{"findings":[{"category":"privacy.pii.email","start":10,"end":26}]}`)
	spans, _ := spansFromVerdict(v, judgedOn(text))
	if len(spans) != 1 || spans[0].Matched != "kate@example.com" {
		t.Fatalf("spans = %+v, want the email", spans)
	}

	st := newSessionState("sess-cn")
	red := learnValues(st, spans)
	masked := protocol.MaskString(text, red)
	if strings.Contains(masked, "kate@example.com") {
		t.Fatalf("plaintext survived masking: %q", masked)
	}
	if !strings.Contains(masked, "请原样复述这个邮箱：") {
		t.Fatalf("masking mangled the surrounding text: %q", masked)
	}
	if protocol.RestoreString(masked, st.Mapping) != text {
		t.Fatalf("round trip broke: %q", protocol.RestoreString(masked, st.Mapping))
	}
}

func TestRuneSliceBoundaries(t *testing.T) {
	text := "你好 world"
	cases := []struct {
		start, end int
		want       string
		ok         bool
	}{
		{0, 2, "你好", true},
		{3, 8, "world", true},
		{0, 8, text, true},
		{7, 8, "d", true},
		{0, 9, "", false}, // past the end of our copy
		{9, 10, "", false},
		{2, 2, "", false},
		{-1, 3, "", false},
	}
	for _, c := range cases {
		got, ok := runeSlice(text, c.start, c.end)
		if got != c.want || ok != c.ok {
			t.Errorf("runeSlice(%d,%d) = %q,%v want %q,%v", c.start, c.end, got, ok, c.want, c.ok)
		}
	}
}

func TestOutOfRangeOffsetsAreDropped(t *testing.T) {
	// A verdict computed against a different text must never slice this one.
	v := gjson.Parse(`{"findings":[
	  {"category":"privacy.pii.email","start":5,"end":9999},
	  {"category":"privacy.pii.email","start":-1,"end":4},
	  {"category":"privacy.pii.email","start":7,"end":7}]}`)
	if spans, _ := spansFromVerdict(v, judgedOn("short text")); len(spans) != 0 {
		t.Fatalf("spans = %+v, want none", spans)
	}
}

func TestShortValuesAreNotMasked(t *testing.T) {
	// A global replace of "Ada" would mangle "Adaptive" everywhere in the prompt.
	spans := []Span{{Category: "privacy.pii.person_name", Matched: "Ada"}}
	if got := redactableValues(spans); len(got) != 0 {
		t.Fatalf("got %+v, want none", got)
	}
}

func TestEqualValuesCollapseToOneToken(t *testing.T) {
	spans := []Span{
		{Category: "privacy.pii.email", Matched: "ada@example.com"},
		{Category: "privacy.pii.email", Matched: "ada@example.com"},
	}
	if got := redactableValues(spans); len(got) != 1 {
		t.Fatalf("got %d entries, want 1", len(got))
	}
}

func TestSessionReusesTheTokenForAValueSeenBefore(t *testing.T) {
	st := newSessionState("sess-x")
	learnValues(st, []Span{{Category: "privacy.pii.email", Matched: "ada@example.com"}})
	learnValues(st, []Span{{Category: "privacy.pii.email", Matched: "ada@example.com"}})
	if len(st.Mapping) != 1 {
		t.Fatalf("mapping = %v, want one token for one value", st.Mapping)
	}
	// A second, different value gets the next number in the SESSION — not a
	// fresh 1 per request, which would make two values claim one token.
	learnValues(st, []Span{{Category: "privacy.pii.email", Matched: "grace@example.com"}})
	if st.Mapping["${OGR_EMAIL_2}"] != "grace@example.com" {
		t.Fatalf("mapping = %v", st.Mapping)
	}
}

func TestLongestValueFirstSoSubstringsCannotCorrupt(t *testing.T) {
	red := []Redaction{
		{Token: "${OGR_PII_1}", Value: "1234"},
		{Token: "${OGR_PII_2}", Value: "1234567890"},
	}
	if got := protocol.MaskString("id 1234567890", red); got != "id ${OGR_PII_2}" {
		t.Fatalf("masked = %q", got)
	}
}

func TestRestoreRoundTrip(t *testing.T) {
	st := newSessionState("sess-x")
	red := learnValues(st, []Span{{Category: "privacy.pii.email", Matched: "ada@example.com"}})
	masked := protocol.MaskString("mail ada@example.com now", red)
	if masked != "mail ${OGR_EMAIL_1} now" {
		t.Fatalf("masked = %q", masked)
	}
	if got := protocol.RestoreString(masked, st.Mapping); got != "mail ada@example.com now" {
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

func TestRestoreReadsAnyShapeTheMapNames(t *testing.T) {
	// The matcher keys off the mapping, so a legacy `__entity_n__` map restores
	// with no configuration — that is what lets one connector serve both.
	mapping := map[string]string{"__email_1__": "ada@example.com"}
	if got := protocol.RestoreString(`mail \_\_email\_1\_\_`, mapping); got != "mail ada@example.com" {
		t.Fatalf("restored = %q", got)
	}
}
