package main

import (
	"sort"
	"strconv"
	"strings"

	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
)

// Placeholder minting, masking and restoration — the plugin's half of the
// runtime's local-redaction contract.
//
// The runtime deliberately does NOT return plaintext: a verdict carries span
// OFFSETS and no `matched` text, precisely so no verdict store becomes a copy of
// the data it guards. The process that already holds the plaintext — this
// plugin, the PEP — slices those offsets out of its own copy, mints the
// placeholders, and keeps the token->value map for the session (session.go).
//
// This MUST keep mirroring the runtime's `policy-engine/redact.ts`:
// longest-prefix category mapping, a 4-character plaintext floor, dedup by
// value, and value-based (never offset-based) replacement, longest value first.

// MinValueLength is the plaintext floor. Below it, a global value replace
// mangles ordinary prose ("Ada" appearing inside "Adaptive").
const MinValueLength = 4

// placeholderTypes maps a taxonomy category to a placeholder type name.
// Longest prefix wins, mirroring the spec's rollup rule, so a new country
// variant (`privacy.pii.national_id.cn`) degrades to its bucket instead of
// falling out of the table.
//
// Only secrets and PII appear here: a moderation span is NOT masked. Masking is
// about the "we do not store secrets or PII" invariant, not about every finding.
var placeholderTypes = []struct{ prefix, name string }{
	{"security.secret_leak", "SECRET"},
	{"privacy.pii.person_name", "NAME"},
	{"privacy.pii.address", "ADDRESS"},
	{"privacy.pii.email", "EMAIL"},
	{"privacy.pii.phone_number", "PHONE"},
	{"privacy.pii.organization", "ORG"},
	{"privacy.pii.national_id", "NATIONAL_ID"},
	{"privacy.pii.tax_id", "TAX_ID"},
	{"privacy.pii.passport", "PASSPORT"},
	{"privacy.pii.driver_license", "DRIVER_LICENSE"},
	{"privacy.pii.bank_card", "BANK_CARD"},
	{"privacy.pii.bank_account", "BANK_ACCOUNT"},
	{"privacy.pii", "PII"},
}

func placeholderType(category string) string {
	best, bestLen := "", -1
	for _, t := range placeholderTypes {
		if category == t.prefix || strings.HasPrefix(category, t.prefix+".") {
			if len(t.prefix) > bestLen {
				best, bestLen = t.name, len(t.prefix)
			}
		}
	}
	return best
}

// mintToken renders the wire token for one placeholder: `${OGR_EMAIL_1}`.
//
// The TYPE stays legible on purpose: redaction hides the value from our own
// egress detectors too, so a tool_call judge still has to be able to reason
// "a credential is flowing to an external host" from the token alone.
//
// Braces, and single underscores only: a markdown renderer escapes `__` to
// `\_\_`, so a `__SECRET__1__` style token does not survive a model that formats
// its output, and `${OGR_EMAIL_1}x` has an unambiguous end where `$OGR_EMAIL_1x`
// does not.
func mintToken(typeName string, n int) string {
	return "${OGR_" + typeName + "_" + strconv.Itoa(n) + "}"
}

// Redaction is one value to remove and the token to put in its place.
type Redaction struct {
	Token string
	Value string
}

// Span is a detected range recovered from a verdict finding.
type Span struct {
	Category string
	Matched  string
}

// spansFromVerdict recovers the redactable values from span offsets plus our own
// copy of the text. This is why the spec keeps offsets on findings and drops
// `matched`: the values are recoverable from the pair by whoever holds the
// plaintext, so the verdict itself never carries any.
func spansFromVerdict(verdict gjson.Result, text string) []Span {
	var spans []Span
	for _, f := range verdict.Get("findings").Array() {
		category := f.Get("category").String()
		if category == "" {
			continue
		}
		s, e := f.Get("start"), f.Get("end")
		if !s.Exists() || !e.Exists() {
			continue
		}
		matched, ok := runeSlice(text, int(s.Int()), int(e.Int()))
		if !ok {
			continue
		}
		spans = append(spans, Span{Category: category, Matched: matched})
	}
	return spans
}

// runeSlice slices text by CHARACTER offsets, not byte offsets.
//
// ⚠️ This is the difference between masking a value and mangling a sentence. A
// finding's start/end are counted the way the producer counts: the detectors are
// Python (code points) and the runtime that relays them is JavaScript (UTF-16
// units), which agree for everything in the BMP. Go indexes BYTES, so on Chinese
// text — three bytes per character — `text[start:end]` lands a third of the way
// into the span, returns a fragment that matches nothing, and the value the
// verdict asked us to remove goes to the model untouched while the log says
// "masked". Found exactly that way on 2026-07-30, with a Chinese prompt.
//
// Astral characters (emoji) are the one case where the producers disagree with
// each other — two UTF-16 units, one code point — and nothing here can fix that
// from this side.
func runeSlice(text string, start, end int) (string, bool) {
	if start < 0 || end <= start {
		return "", false
	}
	startByte, n := -1, 0
	for byteIdx := range text { // ranging a string yields each rune's byte index
		if n == start {
			startByte = byteIdx
		}
		if n == end {
			if startByte < 0 {
				return "", false
			}
			return text[startByte:byteIdx], true
		}
		n++
	}
	if n == start {
		startByte = len(text)
	}
	if n == end && startByte >= 0 {
		return text[startByte:], true
	}
	return "", false // the span runs past the end of our copy of the text
}

// redactableValues returns (type, value) for each redactable span, deduplicated
// by value. Equal values collapse onto one entry: restoration has to map a token
// back to exactly one value, and two tokens for the same value would also
// overstate what leaked.
func redactableValues(spans []Span) []Span {
	seen := map[string]bool{}
	var out []Span
	for _, s := range spans {
		if placeholderType(s.Category) == "" {
			continue
		}
		if len(s.Matched) < MinValueLength || seen[s.Matched] {
			continue
		}
		seen[s.Matched] = true
		out = append(out, s)
	}
	return out
}

// learnFromVerdict binds the values this verdict asks us to remove to tokens,
// and returns the session's whole masking instruction set.
//
// ⚠️ The token is the RUNTIME'S when it sent one. `evaluate` already mints
// `${OGR_<TYPE>_<n>}` per span and returns it in
// `modifications.spans[].replacement`, numbered from a session-scoped counter in
// the runtime's own Redis. Minting a second, local number for the same value
// would put two names for one person in the model's context and make the two
// sides disagree about what a token means. Local minting is the fallback for a
// verdict that carries no modifications.
func learnFromVerdict(st *sessionState, v gjson.Result, text string) []Redaction {
	learned := false
	for _, s := range v.Get("modifications.spans").Array() {
		if s.Get("operator").String() != "replace" {
			continue
		}
		token := s.Get("replacement").String()
		value, ok := runeSlice(text, int(s.Get("start").Int()), int(s.Get("end").Int()))
		if token == "" || !ok || len(value) < MinValueLength {
			continue
		}
		if _, known := st.ByValue[value]; known {
			learned = true // already bound, keep the established token
			continue
		}
		st.remember(token, value)
		learned = true
	}
	if !learned {
		return learnValues(st, spansFromVerdict(v, text))
	}
	return st.redactions()
}

// learnValues gives each newly seen value a session-scoped token and reuses the
// established one for a value seen before, returning the full set of masking
// instructions for the session.
func learnValues(st *sessionState, spans []Span) []Redaction {
	for _, s := range redactableValues(spans) {
		if _, ok := st.ByValue[s.Matched]; ok {
			continue
		}
		typeName := placeholderType(s.Category)
		st.remember(mintToken(typeName, st.nextNumber(typeName)), s.Matched)
	}
	return st.redactions()
}

// maskString replaces every occurrence of each redacted value with its token.
//
// Value-based rather than offset-based on purpose: span offsets are relative to
// the one text the detector was handed, so they do not transfer to the other
// messages in the array — and replacing the value instead also catches it in the
// history turns the detector never saw this request.
//
// Longest value first, so a value that is a substring of another cannot corrupt
// it. Over-redaction is possible and accepted: masking too much is cosmetic,
// masking too little is a leak.
func maskString(text string, redactions []Redaction) string {
	if len(redactions) == 0 || text == "" {
		return text
	}
	ordered := append([]Redaction(nil), redactions...)
	sort.Slice(ordered, func(i, j int) bool { return len(ordered[i].Value) > len(ordered[j].Value) })
	out := text
	for _, r := range ordered {
		if r.Value == "" {
			continue
		}
		out = strings.ReplaceAll(out, r.Value, r.Token)
	}
	return out
}

// maskMessages rewrites every message content in a chat completions body,
// returning the new body and how many strings changed. It walks the array and
// sets each field individually rather than replacing values in the raw JSON: a
// blind string replace over raw JSON corrupts the document the moment a value
// contains a quote or a backslash.
func maskMessages(body string, redactions []Redaction) (string, int) {
	if len(redactions) == 0 {
		return body, 0
	}
	changed := 0
	out := body
	for i, m := range gjson.Get(out, "messages").Array() {
		content := m.Get("content")
		switch {
		case content.Type == gjson.String:
			masked := maskString(content.String(), redactions)
			if masked != content.String() {
				if next, err := sjson.Set(out, "messages."+strconv.Itoa(i)+".content", masked); err == nil {
					out, changed = next, changed+1
				}
			}
		case content.IsArray():
			for j, part := range content.Array() {
				t := part.Get("text")
				if !t.Exists() || t.Type != gjson.String {
					continue
				}
				masked := maskString(t.String(), redactions)
				if masked == t.String() {
					continue
				}
				path := "messages." + strconv.Itoa(i) + ".content." + strconv.Itoa(j) + ".text"
				if next, err := sjson.Set(out, path, masked); err == nil {
					out, changed = next, changed+1
				}
			}
		}
	}
	return out, changed
}

// restoreString maps tokens back to plaintext on WHOLE token matches, absorbing
// the escaping a markdown renderer inserts.
//
// ⚠️ Never fall back to fuzzy or prefix matching. A restorer that guesses is an
// exfiltration oracle: an attacker who can make the model emit near-miss tokens
// reads back values it was never shown. The one latitude taken is a defined
// unescape — `${OGR\_EMAIL\_1}` is our token, rendered. This shares its matcher
// with the streaming restorer, which has to make the same call chunk by chunk.
func restoreString(text string, mapping map[string]string) string {
	if len(mapping) == 0 || text == "" {
		return text
	}
	r := newRestorer(mapping)
	out, _ := r.extract(text, true)
	return out
}
