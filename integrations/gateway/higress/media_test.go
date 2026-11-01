package main

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/tidwall/gjson"
)

// Eliding an oversized inline media part from the EVENT (media.go). Two properties
// carry the whole file: nothing but base64 is ever removed, and every path in the
// document survives the removal.

/** base64 of n bytes, as a string of the right length. */
func b64(n int) string {
	return strings.Repeat("A", (n+2)/3*4)
}

func TestABodyUnderTheCapIsReturnedUntouched(t *testing.T) {
	body := []byte(`{"messages":[{"role":"user","content":"hi"}]}`)
	out, parts := elideMedia(body, configuredOnly(1024))
	if string(out) != string(body) || parts != nil {
		t.Fatalf("small body was rewritten: %s %v", out, parts)
	}
}

// ⚠️ `0` means "send every body verbatim" — the escape hatch for a deployment that
// wants the bytes whatever they cost.
func TestZeroDisablesEliding(t *testing.T) {
	body := []byte(`{"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,` + b64(200_000) + `"}}]}]}`)
	out, parts := elideMedia(body, configuredOnly(0))
	if len(out) != len(body) || parts != nil {
		t.Fatalf("cap 0 elided something: %d parts", len(parts))
	}
}

func TestAnOversizedImageIsDescribedAndItsBytesAreGone(t *testing.T) {
	body := []byte(`{"model":"gpt","messages":[{"role":"user","content":[{"type":"text","text":"what is in this photo"},{"type":"image_url","image_url":{"url":"data:image/png;base64,` + b64(200_000) + `"}}]}]}`)
	out, parts := elideMedia(body, configuredOnly(4096))

	if len(parts) != 1 {
		t.Fatalf("want 1 part, got %d", len(parts))
	}
	p := parts[0]
	if p.Path != "payload.messages.0.content.1.image_url.url" {
		t.Fatalf("path: %s", p.Path)
	}
	if p.Kind != "image" || p.MediaType != "image/png" {
		t.Fatalf("kind/type: %s %s", p.Kind, p.MediaType)
	}
	if p.Bytes < 199_000 || p.Bytes > 201_000 {
		t.Fatalf("bytes: %d", p.Bytes)
	}
	if strings.Contains(string(out), b64(1000)) {
		t.Fatal("base64 survived into the reported body")
	}
	if got := gjson.GetBytes(out, "messages.0.content.1.image_url.url").String(); got != mediaElidedPlaceholder {
		t.Fatalf("placeholder: %q", got)
	}
	// ⚠️ THE DESCRIPTOR RIDES THE PAYLOAD, or the runtime has a placeholder it
	// cannot explain — "something was here" with no kind, type or size.
	if n := gjson.GetBytes(out, "_ogr_media.#").Int(); n != 1 {
		t.Fatalf("_ogr_media entries: %d", n)
	}
	if !json.Valid(out) {
		t.Fatal("reported body is not valid JSON")
	}
}

// ⚠️⚠️ THE GUARANTEE THE WHOLE FILE RESTS ON. The event payload IS the judged
// input, so a long PROMPT must reach the runtime whole; only bytes no detector
// reads may be dropped. This test is the reason the recogniser is shape-based
// rather than size-based.
func TestALongProseFieldIsNeverElided(t *testing.T) {
	prose := strings.Repeat("the quick brown fox jumps over the lazy dog. ", 8000)
	body := []byte(`{"messages":[{"role":"user","content":` + mustJSON(prose) + `}]}`)
	out, parts := elideMedia(body, configuredOnly(4096))
	if parts != nil {
		t.Fatalf("prose was elided as media: %+v", parts)
	}
	if got := gjson.GetBytes(out, "messages.0.content").String(); got != prose {
		t.Fatal("prose did not survive verbatim")
	}
}

// A base64-LOOKING string under a key that carries no media is left alone too: the
// key list is part of the recogniser, not a hint.
func TestBase64UnderAnUnrelatedKeyIsLeftAlone(t *testing.T) {
	body := []byte(`{"messages":[{"role":"user","content":"x"}],"signature":"` + b64(200_000) + `"}`)
	_, parts := elideMedia(body, configuredOnly(4096))
	if parts != nil {
		t.Fatalf("elided a non-media field: %+v", parts)
	}
}

func TestAnthropicRawBase64TakesItsSiblingMediaType(t *testing.T) {
	body := []byte(`{"messages":[{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/jpeg","data":"` + b64(200_000) + `"}}]}]}`)
	_, parts := elideMedia(body, configuredOnly(4096))
	if len(parts) != 1 || parts[0].MediaType != "image/jpeg" || parts[0].Kind != "image" {
		t.Fatalf("parts: %+v", parts)
	}
	if parts[0].Path != "payload.messages.0.content.0.source.data" {
		t.Fatalf("path: %s", parts[0].Path)
	}
}

func TestAnAudioFormatBecomesAMediaType(t *testing.T) {
	body := []byte(`{"messages":[{"role":"user","content":[{"type":"input_audio","input_audio":{"data":"` + b64(200_000) + `","format":"wav"}}]}]}`)
	_, parts := elideMedia(body, configuredOnly(4096))
	if len(parts) != 1 || parts[0].MediaType != "audio/wav" || parts[0].Kind != "audio" {
		t.Fatalf("parts: %+v", parts)
	}
}

// ⚠️⚠️ PATHS AND ARRAY POSITIONS SURVIVE, which is what keeps a verdict's spans
// pointing at the text they were computed on. Dropping the element instead would
// shift every later index — and the failure would be silent, because a shifted span
// still resolves, just onto the wrong string.
func TestEveryOtherPathStillResolvesAfterEliding(t *testing.T) {
	body := []byte(`{"messages":[` +
		`{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,` + b64(200_000) + `"}},{"type":"text","text":"describe it"}]},` +
		`{"role":"user","content":"and hurry"}` +
		`]}`)
	out, parts := elideMedia(body, configuredOnly(4096))
	if len(parts) != 1 {
		t.Fatalf("parts: %d", len(parts))
	}
	if got := gjson.GetBytes(out, "messages.0.content.1.text").String(); got != "describe it" {
		t.Fatalf("sibling text moved: %q", got)
	}
	if got := gjson.GetBytes(out, "messages.1.content").String(); got != "and hurry" {
		t.Fatalf("later message moved: %q", got)
	}
	if got := gjson.GetBytes(out, "messages.#").Int(); got != 2 {
		t.Fatalf("message count: %d", got)
	}
}

func TestSeveralPartsAreAllDescribed(t *testing.T) {
	one := `{"type":"image_url","image_url":{"url":"data:image/png;base64,` + b64(200_000) + `"}}`
	body := []byte(`{"messages":[{"role":"user","content":[` + one + `,` + one + `]}]}`)
	out, parts := elideMedia(body, configuredOnly(4096))
	if len(parts) != 2 {
		t.Fatalf("parts: %d", len(parts))
	}
	if n := gjson.GetBytes(out, "_ogr_media.#").Int(); n != 2 {
		t.Fatalf("_ogr_media entries: %d", n)
	}
	if strings.Contains(string(out), b64(1000)) {
		t.Fatal("base64 survived")
	}
}

// The step's two halves go through the same cap, carried on deriveCtx so they
// cannot disagree about it.
func TestTheRequestEventReportsTheElidedBody(t *testing.T) {
	d := ctxFor("alice@acme.io")
	d.mediaLimits = configuredOnly(4096)
	raw := []byte(`{"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,` + b64(200_000) + `"}}]}]}`)
	e := requestEvent(d, raw)
	if strings.Contains(string(e.Payload), b64(1000)) {
		t.Fatal("the event carried the blob")
	}
	if gjson.GetBytes(e.Payload, "_ogr_media.0.kind").String() != "image" {
		t.Fatalf("no descriptor on the event: %s", e.Payload)
	}
	// ⚠️ The FORWARDED body is a different object and must be untouched — this
	// plugin reports, it does not rewrite the client's request.
	if !strings.Contains(string(raw), b64(1000)) {
		t.Fatal("the caller's own body was modified")
	}
}

func TestBase64Bytes(t *testing.T) {
	for _, c := range []struct {
		in   string
		want int
	}{{"AAAA", 3}, {"AAA=", 2}, {"AA==", 1}, {"", 0}} {
		if got := base64Bytes(c.in); got != c.want {
			t.Fatalf("base64Bytes(%q) = %d, want %d", c.in, got, c.want)
		}
	}
}

func mustJSON(s string) string {
	b, err := json.Marshal(s)
	if err != nil {
		panic(err)
	}
	return string(b)
}

// A kind the RUNTIME refuses is elided at any size — the transfer buys nothing,
// because the far end would record it as declined and store no bytes.
func TestAnAdvertisedZeroElidesTheKindAtAnySize(t *testing.T) {
	u := int64(capUnknown)
	// A small image, far under any configured cap, with the runtime refusing images.
	raw := []byte(`{"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,` + b64(200) + `"}}]}]}`)
	out, parts := elideMedia(raw, withAdvertised(4<<20, 0, u, u, u, u))
	if len(parts) != 1 || parts[0].Kind != "image" {
		t.Fatalf("a refused kind must be elided whatever its size: %v", parts)
	}
	if strings.Contains(string(out), b64(200)) {
		t.Fatal("the blob survived")
	}
	// ⚠️ And the SAME body with the runtime silent is reported whole — the advertised
	// limits are advisory, and a plugin that never got a beat must behave as 3.7.0 did.
	if _, parts := elideMedia(raw, configuredOnly(4<<20)); len(parts) != 0 {
		t.Fatalf("with no advertisement a small image must be reported whole: %v", parts)
	}
}

// One body, two kinds, two different caps — the reason a single number could not
// answer once the runtime started bounding per kind.
func TestPerKindCapsApplyIndependently(t *testing.T) {
	u := int64(capUnknown)
	raw := []byte(`{"messages":[{"role":"user","content":[` +
		`{"type":"image_url","image_url":{"url":"data:image/png;base64,` + b64(5_000) + `"}},` +
		`{"type":"input_audio","input_audio":{"data":"` + b64(5_000) + `","format":"wav"}}]}]}`)
	// Images capped below the part, audio well above it.
	_, parts := elideMedia(raw, withAdvertised(0, 1024, 1<<20, u, u, u))
	if len(parts) != 1 || parts[0].Kind != "image" {
		t.Fatalf("only the image should have been elided, got %v", parts)
	}
}
