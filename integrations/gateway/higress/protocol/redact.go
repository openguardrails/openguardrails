package protocol

import (
	"sort"
	"strconv"
	"strings"

	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
)

// The masking and restoration machinery every adapter shares.
//
// WHICH values to mask is decided elsewhere — the runtime's verdict names them and
// the plugin holds the plaintext (see redact.go in the parent package). What lives
// here is the mechanical half each protocol needs to write those values into, and
// read them back out of, its own JSON: the value substitution, the token matcher,
// and the two JSON walks that more than one protocol happens to share.
//
// ⚠️ The shared walks are JSON-path utilities, not a normalization. Each adapter
// still decides WHICH paths its own format keeps text at; nothing here decides that
// for it, and an adapter whose shape does not fit is expected to walk it itself.

// Redaction is one value to remove and the token to put in its place.
type Redaction struct {
	Token string
	Value string
}

// MaskString replaces every occurrence of each redacted value with its token.
//
// Value-based rather than offset-based on purpose: span offsets are relative to the
// one text the detector was handed, so they do not transfer to the other messages in
// the array — and replacing the value instead also catches it in the history turns
// the detector never saw this request.
//
// Longest value first, so a value that is a substring of another cannot corrupt it.
// Over-redaction is possible and accepted: masking too much is cosmetic, masking too
// little is a leak.
func MaskString(text string, redactions []Redaction) string {
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

// RestoreString maps tokens back to plaintext on WHOLE token matches.
func RestoreString(text string, mapping map[string]string) string {
	if len(mapping) == 0 || text == "" {
		return text
	}
	out, _ := NewRestorer(mapping).Extract(text, true)
	return out
}

// --- shared JSON walks -------------------------------------------------------

// maskAt masks one JSON string field, reporting whether it changed.
func maskAt(body, path string, redactions []Redaction) (string, int) {
	f := gjson.Get(body, path)
	if f.Type != gjson.String {
		return body, 0
	}
	masked := MaskString(f.String(), redactions)
	if masked == f.String() {
		return body, 0
	}
	if next, err := sjson.Set(body, path, masked); err == nil {
		return next, 1
	}
	return body, 0
}

// maskTextOrBlocks masks a field that is EITHER a bare string OR a list of typed
// blocks carrying `.text`. All three protocols have at least one such field, which
// is why it is here rather than copied three times; which fields those are is still
// each adapter's own business.
func maskTextOrBlocks(body, path string, redactions []Redaction) (string, int) {
	f := gjson.Get(body, path)
	if f.Type == gjson.String {
		return maskAt(body, path, redactions)
	}
	out, changed := body, 0
	for i := range f.Array() {
		next, n := maskAt(out, path+"."+strconv.Itoa(i)+".text", redactions)
		out, changed = next, changed+n
	}
	return out, changed
}

// restoreAt restores one JSON string field.
func restoreAt(body, path string, mapping map[string]string) (string, bool) {
	f := gjson.Get(body, path)
	if f.Type != gjson.String {
		return body, false
	}
	restored := RestoreString(f.String(), mapping)
	if restored == f.String() {
		return body, false
	}
	if next, err := sjson.Set(body, path, restored); err == nil {
		return next, true
	}
	return body, false
}

// restoreRawAt restores inside a JSON SUBTREE by treating its raw text as a string.
//
// For an arguments object carried as JSON rather than as a string: a placeholder can
// only appear inside a string literal of that subtree, and the token alphabet
// contains nothing JSON escapes, so substituting in the raw text cannot produce
// invalid JSON.
func restoreRawAt(body, path string, mapping map[string]string) (string, bool) {
	raw := gjson.Get(body, path).Raw
	if raw == "" {
		return body, false
	}
	restored := RestoreString(raw, mapping)
	if restored == raw {
		return body, false
	}
	if next, err := sjson.SetRaw(body, path, restored); err == nil {
		return next, true
	}
	return body, false
}

// --- the restorer ------------------------------------------------------------

// Restorer replaces placeholders in text by matching THE MAPPING'S OWN KEYS, never
// a hard-coded token syntax. `${OGR_EMAIL_1}` and a legacy `__ogr_email_1__` both
// restore with no configuration, the buffer bound is derived from the longest key,
// and a rendered `\` before punctuation is absorbed — a model that formats its
// answer as markdown emits `${OGR\_EMAIL\_1}`, and a restorer that does not know
// that leaves the user reading a placeholder instead of their own data.
//
// ⚠️ A WHOLE key must still match. Restoration MUST NOT fall back to fuzzy or prefix
// matching: a restorer that guesses is an exfiltration oracle — an attacker who can
// make the model emit near-miss tokens reads back values it was never shown. The
// defined unescape is the only latitude taken.
type Restorer struct {
	mapping map[string]string
	keys    []string // longest first, so a key is never shadowed by a prefix
	maxRaw  int      // longest key's worst case: every byte preceded by an escape
	starts  [256]bool
}

func NewRestorer(mapping map[string]string) *Restorer {
	r := &Restorer{mapping: mapping}
	longest := 0
	for k := range mapping {
		if k == "" {
			continue
		}
		r.keys = append(r.keys, k)
		if len(k) > longest {
			longest = len(k)
		}
		r.starts[k[0]] = true
	}
	sort.Slice(r.keys, func(i, j int) bool { return len(r.keys[i]) > len(r.keys[j]) })
	r.starts['\\'] = true // a key may begin at an escaped first character
	r.maxRaw = longest*2 + 2
	return r
}

// Active reports whether this restorer has anything to do.
func (r *Restorer) Active() bool { return len(r.keys) > 0 }

// Extract replaces every complete key in text and splits the remainder into output
// and a pending tail that may be the beginning of a key. With isLast, nothing is
// held back: a partial token at end-of-stream is just text.
func (r *Restorer) Extract(text string, isLast bool) (output string, pending string) {
	if len(r.keys) == 0 || text == "" {
		return text, ""
	}
	out := make([]byte, 0, len(text)+32)
	i := 0
	for i < len(text) {
		if !r.starts[text[i]] {
			out = append(out, text[i])
			i++
			continue
		}
		key, raw, partial := r.matchAt(text, i)
		if raw > 0 {
			out = append(out, r.mapping[key]...)
			i += raw
			continue
		}
		if partial && !isLast && len(text)-i <= r.maxRaw {
			return string(out), text[i:]
		}
		out = append(out, text[i])
		i++
	}
	return string(out), ""
}

// Feed is Extract against a caller-held tail: the shape a streaming decoder needs,
// where a token routinely straddles two deltas. It appends text to *buf, returns
// what is safe to emit, and leaves the unresolved tail in *buf.
//
// ⚠️ Every streamed text field needs its OWN buf. Two tool calls stream interleaved,
// and one call's half-token must never be completed by the other's next delta.
func (r *Restorer) Feed(buf *string, text string, isLast bool) string {
	*buf += text
	output, pending := r.Extract(*buf, isLast)
	*buf = pending
	return output
}

// matchAt tries every key at i, longest first, returning the key that matched and
// the RAW byte span it covers (escapes make that longer than the key), or
// partial=true when the text ran out before any key completed.
func (r *Restorer) matchAt(text string, i int) (key string, raw int, partial bool) {
	for _, k := range r.keys {
		n, status := matchKey(text, i, k)
		if status == matchFull {
			return k, n, false
		}
		if status == matchTruncated {
			partial = true // keep looking: a SHORTER key may still match in full
		}
	}
	return "", 0, partial
}

const (
	matchNone = iota
	matchFull
	matchTruncated // the text ended before the key did
)

func matchKey(text string, i int, key string) (int, int) {
	p := i
	for k := 0; k < len(key); k++ {
		if p >= len(text) {
			return 0, matchTruncated
		}
		if text[p] == '\\' && key[k] != '\\' {
			if p+1 >= len(text) {
				return 0, matchTruncated // the escaped character has not arrived
			}
			if isEscapable(text[p+1]) {
				p++
			}
		}
		if text[p] != key[k] {
			return 0, matchNone
		}
		p++
	}
	return p - i, matchFull
}

// isEscapable reports whether ch is punctuation a markdown renderer escapes. A fixed
// list on purpose: a backslash before anything else stays literal, so `C:\name` can
// never be read as an escape inside a token.
func isEscapable(ch byte) bool {
	switch ch {
	case '_', '*', '$', '{', '}', '[', ']', '(', ')', '#', '+', '-', '.', '!', '`', '~', '|', '<', '>', '\\':
		return true
	}
	return false
}
