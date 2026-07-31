package main

import (
	"strings"
	"testing"

	"github.com/tidwall/gjson"
)

var testKey = []byte("0123456789abcdef0123456789abcdef") // 32 bytes

func TestSealRoundTrip(t *testing.T) {
	plain := []byte(`{"m":{"${OGR_EMAIL_1}":"kate@example.com"}}`)
	sealed, err := seal(testKey, plain)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(sealed, "kate@example.com") {
		t.Fatal("the plaintext is readable in the sealed value")
	}
	out, err := open(testKey, sealed)
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != string(plain) {
		t.Fatalf("round trip = %q", out)
	}
}

func TestSealUsesAFreshNonce(t *testing.T) {
	// GCM nonce reuse under one key leaks the keystream. Two seals of the same
	// value must not produce the same bytes.
	a, _ := seal(testKey, []byte("same"))
	b, _ := seal(testKey, []byte("same"))
	if a == b {
		t.Fatal("two seals produced identical ciphertext")
	}
}

func TestOpenRefusesAWrongOrTamperedValue(t *testing.T) {
	sealed, _ := seal(testKey, []byte("secret"))
	other := []byte("ffffffffffffffffffffffffffffffff")
	if _, err := open(other, sealed); err == nil {
		t.Error("a wrong key decrypted the session")
	}
	tampered := sealed[:len(sealed)-2] + "AA"
	if _, err := open(testKey, tampered); err == nil {
		t.Error("a tampered value decrypted")
	}
	if _, err := open(testKey, "not base64 at all!!"); err == nil {
		t.Error("garbage decrypted")
	}
}

func TestSessionKeyParsing(t *testing.T) {
	hexKey := "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"
	if k, err := parseSessionKey(hexKey); err != nil || len(k) != 32 {
		t.Errorf("hex key: %v %d", err, len(k))
	}
	if k, err := parseSessionKey("MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="); err != nil || len(k) != 32 {
		t.Errorf("base64 key: %v %d", err, len(k))
	}
	// A short key must be a configuration ERROR, never a silently weaker one.
	for _, bad := range []string{"", "abcd", "00112233445566778899aabbccddeeff"} {
		if _, err := parseSessionKey(bad); err == nil {
			t.Errorf("parseSessionKey(%q) accepted a %d-char key", bad, len(bad))
		}
	}
}

func TestSessionSurvivesTheRoundTripThroughTheStore(t *testing.T) {
	st := newSessionState("sess-1")
	st.remember("${OGR_EMAIL_1}", "kate@example.com")
	st.markCall("call_1")
	st.markResult("call_1")
	st.markUserText("hello")
	st.setToolsHash("abc123")

	blob, err := st.encode()
	if err != nil {
		t.Fatal(err)
	}
	back := decodeSession("sess-1", blob)

	if back.Mapping["${OGR_EMAIL_1}"] != "kate@example.com" {
		t.Error("token map lost")
	}
	// ByValue is what re-masking reads; it has to be rebuilt on load or turn 2
	// masks nothing.
	if back.ByValue["kate@example.com"] != "${OGR_EMAIL_1}" {
		t.Error("value index not rebuilt on load")
	}
	if !back.seenCall("call_1") || !back.seenResult("call_1") {
		t.Error("dedup markers lost — the history would be re-reported as new")
	}
	if !back.sawUserText("hello") {
		t.Error("last user turn lost")
	}
	if back.ToolsHash != "abc123" {
		t.Error("tool set hash lost")
	}
}

func TestAnUnreadableBlobStartsAFreshSession(t *testing.T) {
	st := decodeSession("sess-1", []byte("{not json"))
	if len(st.Mapping) != 0 || st.userHash != "" {
		t.Fatal("a partial session was reconstructed from garbage")
	}
}

func TestTheRuntimesTokenWins(t *testing.T) {
	// evaluate already minted a session-scoped token; minting a second local
	// number for the same value would put two names for one person in the
	// model's context.
	st := newSessionState("sess-1")
	text := "mail kate@example.com now"
	v := gjson.Parse(`{"decision":"redact","modifications":{"spans":[
	  {"path":"payload.text","start":5,"end":21,"operator":"replace","ref":"OGR_EMAIL_7","replacement":"${OGR_EMAIL_7}"}]}}`)

	red := learnFromVerdict(st, v, text)
	if st.Mapping["${OGR_EMAIL_7}"] != "kate@example.com" {
		t.Fatalf("mapping = %v", st.Mapping)
	}
	if got := maskString(text, red); got != "mail ${OGR_EMAIL_7} now" {
		t.Fatalf("masked = %q", got)
	}
	if len(st.Counters) != 0 {
		t.Errorf("a local number was minted alongside the runtime's: %v", st.Counters)
	}
}

func TestVerdictWithoutModificationsFallsBackToLocalMinting(t *testing.T) {
	st := newSessionState("sess-1")
	text := "mail kate@example.com now"
	v := gjson.Parse(`{"decision":"redact","findings":[
	  {"category":"privacy.pii.email","start":5,"end":21}]}`)

	red := learnFromVerdict(st, v, text)
	if got := maskString(text, red); got != "mail ${OGR_EMAIL_1} now" {
		t.Fatalf("masked = %q", got)
	}
}
