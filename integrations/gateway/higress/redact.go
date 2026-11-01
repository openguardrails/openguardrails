package main

import (
	"sort"
	"strings"

	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
)

// Applying a verdict's modification spans to the body being forwarded.
//
// The applier is generic. The old plugin synthesized the judged texts itself, so it
// kept a registration table mapping payload paths to its own copies; a raw forwarder
// has no copies — the payload IS the body — so a span's `path` resolves directly into
// the JSON that is about to be forwarded, and the splice happens in place.
//
// The runtime deliberately does NOT return plaintext: a span carries OFFSETS and a
// replacement token, so no verdict store becomes a copy of the data it guards. The
// process that already holds the plaintext — this plugin — slices the span out of its
// own bytes, which is also how the token→value mapping for restoring the reply is
// learned (session.go).
//
// ⚠️ A span that does not resolve — a path that names no string in this body, offsets
// past the end of the value — is DROPPED and COUNTED, never applied somewhere else.
// Slicing one span's offsets out of another text masks bytes nobody detected while
// the real value travels on, and both failures look exactly like a healthy gateway.

// Span is one modification from a verdict.
type Span struct {
	Path        string
	Start, End  int
	Replacement string
}

// stripPayloadPrefix folds a wire path (`payload.messages.3.content`, bracket form
// included) to the gjson path inside the body (`messages.3.content`).
func stripPayloadPrefix(path string) string {
	p := dottedPath(path)
	if p == "payload" {
		return ""
	}
	if strings.HasPrefix(p, "payload.") {
		return p[len("payload."):]
	}
	return ""
}

// dottedPath folds `a[0].b` into `a.0.b`, the form gjson reads.
func dottedPath(path string) string {
	if !strings.ContainsRune(path, '[') {
		return path
	}
	out := make([]byte, 0, len(path))
	for i := 0; i < len(path); i++ {
		switch path[i] {
		case '[':
			if len(out) > 0 && out[len(out)-1] != '.' {
				out = append(out, '.')
			}
		case ']':
			// A `]` followed by `.` would double the separator.
			if i+1 < len(path) && path[i+1] == '.' {
				i++
			}
			if i+1 < len(path) {
				out = append(out, '.')
			}
		default:
			out = append(out, path[i])
		}
	}
	return string(out)
}

// applySpans splices every resolvable span into the body and returns the new body,
// how many spans were applied, how many were dropped as unresolvable, and the
// token→value mapping learned from the splices (the token is the runtime's
// `replacement`; the value is the text it displaced — what `Restore` puts back into
// the reply).
//
// Spans on one path are applied HIGHEST OFFSET FIRST, so an earlier splice cannot
// shift the offsets a later span was computed against.
func applySpans(body string, spans []Span) (string, int, int, map[string]string) {
	if len(spans) == 0 {
		return body, 0, 0, nil
	}
	byPath := map[string][]Span{}
	unresolved := 0
	for _, s := range spans {
		p := stripPayloadPrefix(s.Path)
		if p == "" || s.Replacement == "" {
			unresolved++
			continue
		}
		byPath[p] = append(byPath[p], s)
	}

	applied := 0
	learned := map[string]string{}
	for path, group := range byPath {
		value := gjson.Get(body, path)
		if value.Type != gjson.String {
			unresolved += len(group)
			continue
		}
		text := value.String()
		sort.Slice(group, func(i, j int) bool { return group[i].Start > group[j].Start })
		changed := false
		for _, s := range group {
			next, matched, ok := spliceRunes(text, s.Start, s.End, s.Replacement)
			if !ok {
				unresolved++
				continue
			}
			text = next
			changed = true
			applied++
			learned[s.Replacement] = matched
		}
		if !changed {
			continue
		}
		next, err := sjson.Set(body, path, text)
		if err != nil {
			// The path resolved for reading, so a write failure is a corrupt body —
			// count the group as unresolved rather than forwarding a half-edit.
			unresolved += len(group)
			applied -= len(group)
			continue
		}
		body = next
	}
	if applied < 0 {
		applied = 0
	}
	return body, applied, unresolved, learned
}

// spliceRunes replaces [start,end) — counted in CHARACTERS — with the replacement,
// returning the new text and the bytes displaced.
//
// ⚠️ Characters, not bytes: the producers count code points and Go indexes bytes. On
// Chinese text — three bytes per character — a byte splice lands a third of the way
// into the span, masks a fragment that matches nothing, and the value the verdict
// asked us to remove goes to the model untouched while the log says "masked". Found
// exactly that way on 2026-07-30.
//
// ⚠️ This comment used to name "the JavaScript runtime" among the producers that
// count code points, and that was WRONG — JS string indices count UTF-16 CODE UNITS,
// so every astral character (emoji, CJK Ext-B) before a span shifted the runtime's
// regex-derived offsets one to the right per character. Python's `str` does index code
// points, so the model spans were always right and only the runtime's own deterministic
// detectors drifted; BMP text is identical under both counts, which is why it survived
// every Chinese and English test. Fixed on the RUNTIME side (`policy-engine/
// spanOffsets.ts`, 2026-08-16) because that is where the unit is known — a span here
// carries no marking of which producer made it. Nothing changed in this file; the note
// is here so the premise is not re-assumed.
func spliceRunes(text string, start, end int, replacement string) (string, string, bool) {
	startByte, endByte, ok := runeRange(text, start, end)
	if !ok {
		return "", "", false
	}
	return text[:startByte] + replacement + text[endByte:], text[startByte:endByte], true
}

// runeRange converts character offsets to byte offsets, refusing anything out of
// range.
func runeRange(text string, start, end int) (int, int, bool) {
	if start < 0 || end <= start {
		return 0, 0, false
	}
	startByte, n := -1, 0
	for byteIdx := range text { // ranging a string yields each rune's byte index
		if n == start {
			startByte = byteIdx
		}
		if n == end {
			if startByte < 0 {
				return 0, 0, false
			}
			return startByte, byteIdx, true
		}
		n++
	}
	if n == start {
		startByte = len(text)
	}
	if n == end && startByte >= 0 {
		return startByte, len(text), true
	}
	return 0, 0, false // the span runs past the end of the text
}
