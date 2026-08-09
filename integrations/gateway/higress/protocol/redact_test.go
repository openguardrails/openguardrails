package protocol

import "testing"

// The masking and restoration machinery, independent of any protocol.

func TestLongestValueFirstSoSubstringsCannotCorrupt(t *testing.T) {
	red := []Redaction{
		{Token: "${OGR_PII_1}", Value: "1234"},
		{Token: "${OGR_PII_2}", Value: "1234567890"},
	}
	if got := MaskString("id 1234567890", red); got != "id ${OGR_PII_2}" {
		t.Fatalf("masked = %q", got)
	}
}

func TestMaskingIsValueBasedSoItReachesHistoryTheDetectorNeverSaw(t *testing.T) {
	red := []Redaction{{Token: "${OGR_EMAIL_1}", Value: "ada@example.com"}}
	got := MaskString("first ada@example.com, later ada@example.com", red)
	if got != "first ${OGR_EMAIL_1}, later ${OGR_EMAIL_1}" {
		t.Fatalf("masked = %q", got)
	}
}

func TestRestoreIsWholeTokenOnly(t *testing.T) {
	// ⚠️ A restorer that guesses is an exfiltration oracle: an attacker who can make the
	// model emit near-miss tokens reads back values it was never shown.
	mapping := map[string]string{"${OGR_EMAIL_1}": "ada@example.com"}
	for _, near := range []string{"${OGR_EMAIL_2}", "${OGR_EMAIL_1", "$OGR_EMAIL_1", "${OGR_EMAIL_11}"} {
		if got := RestoreString(near, mapping); got != near {
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
		if got := RestoreString(in, mapping); got != want {
			t.Errorf("RestoreString(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestRestoreReadsAnyShapeTheMapNames(t *testing.T) {
	// The matcher keys off the mapping, so a legacy `__entity_n__` map restores with no
	// configuration — that is what lets one connector serve both.
	mapping := map[string]string{"__email_1__": "ada@example.com"}
	if got := RestoreString(`mail \_\_email\_1\_\_`, mapping); got != "mail ada@example.com" {
		t.Fatalf("restored = %q", got)
	}
}

func TestFeedHoldsBackAPartialTokenAndReleasesItAtTheEnd(t *testing.T) {
	r := NewRestorer(map[string]string{"${OGR_EMAIL_1}": "ada@example.com"})
	var buf string
	if got := r.Feed(&buf, "mail ${OGR", false); got != "mail " {
		t.Fatalf("emitted %q, want the safe prefix only", got)
	}
	if got := r.Feed(&buf, "_EMAIL_1} now", false); got != "ada@example.com now" {
		t.Fatalf("emitted %q", got)
	}
	// A partial token at end of stream is just text.
	buf = ""
	if got := r.Feed(&buf, "cost: ${OGR", true); got != "cost: ${OGR" {
		t.Fatalf("end of stream held back %q", got)
	}
}

func TestTwoStreamsDoNotCompleteEachOthersTokens(t *testing.T) {
	// ⚠️ Two tool calls stream interleaved. One call's half-token must never be
	// completed by the other's next delta, which is why each streamed field carries its
	// own tail.
	r := NewRestorer(map[string]string{"${OGR_EMAIL_1}": "ada@example.com"})
	var a, b string
	r.Feed(&a, "${OGR", false)
	if got := r.Feed(&b, "_EMAIL_1}", false); got == "ada@example.com" {
		t.Fatal("one field's tail completed another field's token")
	}
}

func TestAnEmptyMapIsPassthrough(t *testing.T) {
	if got := MaskString("nothing to do", nil); got != "nothing to do" {
		t.Errorf("MaskString = %q", got)
	}
	if got := RestoreString("nothing to do", nil); got != "nothing to do" {
		t.Errorf("RestoreString = %q", got)
	}
	if NewRestorer(nil).Active() {
		t.Error("an empty restorer claims it is active")
	}
}
