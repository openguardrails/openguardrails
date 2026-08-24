package main

import (
	"encoding/json"
	"strconv"
	"strings"

	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
)

// ELIDING AN OVERSIZED MEDIA PART FROM THE EVENT (OGR 1.1, plugin 3.7.0).
//
// A provider body carries images, audio, video and documents INLINE, as base64 —
// a `data:` URI under `image_url.url`, Anthropic's `source.data`,
// `input_audio.data`, `file.file_data`. A short video is tens of megabytes, and in
// ENFORCE mode the caller waits while this plugin dispatches every one of those
// bytes to the runtime and waits for a verdict on them. Nothing in that round trip
// reads the bytes: no guardrail opens an image.
//
// So above `media_max_bytes` the part is replaced, IN THE EVENT ONLY, by the
// placeholder `ogr-media:elided`, and a descriptor of what was there rides
// `payload._ogr_media` — kind, media type, size, and the path it sat at. The
// runtime records "a 41 MB video/mp4 was here, unjudged" instead of either
// carrying it or losing it silently.
//
// ⚠️⚠️ **THE FORWARDED BODY IS NEVER TOUCHED.** This rewrites the copy that becomes
// `GuardEvent.payload`; the model gets the request the client sent, byte for byte.
// A plugin that stripped a user's screenshot out of their own prompt would be
// corrupting traffic to save bandwidth on a report.
//
// ⚠️⚠️ **ONLY BASE64-SHAPED STRINGS, NEVER PROSE, AND THIS IS LOAD-BEARING.** The
// event payload IS the judged input — the runtime evaluates what we send it — so
// eliding a long TEXT would blind the detectors to exactly the largest prompts.
// What makes eliding a blob safe is that no detector reads one; the moment a
// detector can, this whole file has to be reconsidered rather than tuned.
//
// ⚠️ **PATHS AND ARRAY POSITIONS ARE PRESERVED.** A verdict's spans resolve by PATH
// and then by offsets INSIDE that string (redact.go), so replacing one string's
// value cannot move another's offsets. Removing the element instead — the obvious
// "just drop it" — would shift every later index in the array and silently
// re-target every span behind it.

const (
	// Above this many bytes of base64 a part is elided from the event. Roomy on
	// purpose: an ordinary screenshot or photo (100 KB – 2 MB) still reaches the
	// runtime and renders in the console, while the shapes that make a caller wait
	// — video, a scanned PDF, a raw audio capture — do not. `0` disables eliding.
	defaultMediaMaxBytes = 4 << 20

	// What replaces an elided value. The runtime recognises the prefix and pairs it
	// with the descriptor at the same path.
	mediaElidedPlaceholder = "ogr-media:elided"

	// Bound on how many parts one event may describe, so a pathological body cannot
	// turn one report into a directory of them.
	maxMediaParts = 32

	// Below this, a string is not worth testing: base64 of 64 bytes is 88 chars.
	minBase64Len = 88
)

// mediaPart is one elided part, as it rides `payload._ogr_media`.
//
// ⚠️ It describes what WAS there; it never claims anything about where the bytes
// are now, because they are nowhere — this gateway stores nothing. A runtime treats
// every field here as a producer CLAIM.
type mediaPart struct {
	// Dotted path of the value inside `payload`, e.g.
	// `payload.messages.3.content.1.image_url.url` — the same grammar a verdict
	// span uses, so the runtime can pair the descriptor with the placeholder.
	Path string `json:"path"`
	// image | audio | video | document | file
	Kind string `json:"kind"`
	// The media type the body named, `""` when it named none.
	MediaType string `json:"media_type,omitempty"`
	// DECODED size of what was elided.
	Bytes int `json:"bytes"`
}

// elideMedia returns the body to REPORT and the parts that were removed from it.
// The input slice is never modified; with nothing to elide it is returned as-is,
// which is the overwhelmingly common path and costs one walk.
func elideMedia(body []byte, lim mediaLimits) ([]byte, []mediaPart) {
	floor, scan := lim.scanFloor()
	if !scan {
		return body, nil
	}
	// A body smaller than the SMALLEST cap in force cannot contain a part over it.
	// ⚠️ `floor == 0` means some kind is refused outright (`limits.go`), and then the
	// body's size rules nothing out — the walk has to run.
	if floor > 0 && len(body) <= floor {
		return body, nil
	}
	root := gjson.ParseBytes(body)
	if !root.IsObject() {
		return body, nil
	}
	var parts []mediaPart
	walkMedia(root, "", lim, &parts)
	if len(parts) == 0 {
		return body, nil
	}
	out := body
	for _, p := range parts {
		// ⚠️ sjson splices the one value and leaves every other byte where it was.
		// A parse-and-re-marshal would re-escape strings and move every span offset
		// in the document — the rule spliceTiming states in events.go.
		next, err := sjson.SetBytes(out, strings.TrimPrefix(p.Path, "payload."), mediaElidedPlaceholder)
		if err != nil {
			continue
		}
		out = next
	}
	blob, err := json.Marshal(parts)
	if err != nil {
		return out, parts
	}
	return spliceRaw(out, "_ogr_media", blob), parts
}

// walkMedia finds every oversized base64-shaped string, deepest-first order being
// irrelevant since each is replaced by path afterwards.
func walkMedia(v gjson.Result, path string, lim mediaLimits, out *[]mediaPart) {
	if len(*out) >= maxMediaParts {
		return
	}
	switch {
	case v.IsObject():
		v.ForEach(func(k, child gjson.Result) bool {
			walkMediaChild(v, k.String(), child, path, lim, out)
			return len(*out) < maxMediaParts
		})
	case v.IsArray():
		i := 0
		v.ForEach(func(_, child gjson.Result) bool {
			walkMediaChild(v, strconv.Itoa(i), child, path, lim, out)
			i++
			return len(*out) < maxMediaParts
		})
	}
}

func walkMediaChild(parent gjson.Result, key string, child gjson.Result, path string, lim mediaLimits, out *[]mediaPart) {
	next := key
	if path != "" {
		next = path + "." + key
	}
	if child.Type != gjson.String {
		walkMedia(child, next, lim, out)
		return
	}
	s := child.String()
	if len(s) < minBase64Len {
		return
	}
	mediaType, payload, ok := splitInlineMedia(parent, key, s)
	if !ok {
		return
	}
	n := base64Bytes(payload)
	kind := mediaKind(mediaType)
	// ⚠️ PER KIND since 3.8.0. The runtime accepts different sizes of image, audio
	// and document and may refuse a kind outright — so one number cannot answer, and
	// `elideAll` is a separate flag rather than a `0` doing double duty (limits.go).
	limit, elideAll := lim.mediaLimit(kind)
	if !elideAll && (limit <= 0 || n <= limit) {
		return
	}
	*out = append(*out, mediaPart{
		Path:      "payload." + next,
		Kind:      kind,
		MediaType: mediaType,
		Bytes:     n,
	})
}

// splitInlineMedia decides whether this string is an inline media blob, and what
// its media type is.
//
// Two shapes qualify and nothing else:
//   - a `data:<type>;base64,…` URI, wherever it appears — self-describing;
//   - raw base64 under a key that carries one (`data`, `file_data`, `b64_json`),
//     with the type taken from a SIBLING (`media_type` / `mimeType` / `format`).
//
// ⚠️ A long string that is neither is left alone. That is the prose guarantee at
// the top of this file: the report must keep every byte a detector might read.
func splitInlineMedia(parent gjson.Result, key, s string) (mediaType, payload string, ok bool) {
	if strings.HasPrefix(s, "data:") {
		comma := strings.IndexByte(s, ',')
		if comma < 0 {
			return "", "", false
		}
		meta := s[5:comma]
		if !strings.HasSuffix(meta, ";base64") {
			return "", "", false // percent-encoded text is not an attachment
		}
		return strings.TrimSuffix(meta, ";base64"), s[comma+1:], true
	}
	switch key {
	case "data", "file_data", "b64_json":
	default:
		return "", "", false
	}
	if !looksBase64(s) {
		return "", "", false
	}
	return siblingMediaType(parent), s, true
}

func siblingMediaType(parent gjson.Result) string {
	for _, k := range []string{"media_type", "mimeType", "mime_type", "content_type"} {
		if v := parent.Get(k); v.Exists() && strings.Contains(v.String(), "/") {
			return v.String()
		}
	}
	// `{"data": …, "format": "wav"}` — the audio shape.
	if v := parent.Get("format"); v.Exists() && v.String() != "" {
		return "audio/" + v.String()
	}
	return ""
}

// looksBase64 rejects the obvious miss (a URL, a sentence, a JSON blob) rather than
// validating an encoding: it only ever runs on a key already known to carry base64.
func looksBase64(s string) bool {
	head := s
	if len(head) > 256 {
		head = head[:256]
	}
	for i := 0; i < len(head); i++ {
		c := head[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9':
		case c == '+', c == '/', c == '=', c == '-', c == '_':
		default:
			return false
		}
	}
	return true
}

// base64Bytes is the DECODED length, counted rather than decoded — the point is to
// know a 41 MB video is 41 MB without allocating it.
func base64Bytes(s string) int {
	n := len(s)
	if n == 0 {
		return 0
	}
	pad := 0
	for i := n - 1; i >= 0 && pad < 2 && s[i] == '='; i-- {
		pad++
	}
	return n*3/4 - pad
}

func mediaKind(mediaType string) string {
	t := strings.ToLower(mediaType)
	switch {
	case strings.HasPrefix(t, "image/"):
		return "image"
	case strings.HasPrefix(t, "audio/"):
		return "audio"
	case strings.HasPrefix(t, "video/"):
		return "video"
	case t == "application/pdf", strings.HasPrefix(t, "text/"),
		strings.Contains(t, "officedocument"), strings.Contains(t, "msword"):
		return "document"
	default:
		return "file"
	}
}

// spliceRaw inserts one top-level key carrying already-marshalled JSON, by the same
// byte insertion spliceTiming uses and for the same reason: every original byte —
// and every string a span can name — stays exactly where it was.
func spliceRaw(body []byte, key string, blob []byte) []byte {
	trimmed := strings.TrimLeft(string(body), " \t\r\n")
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return body
	}
	if gjson.Parse(trimmed).Get(key).Exists() {
		return body // never write a duplicate key
	}
	rest := trimmed[1:]
	sep := ","
	if next := strings.TrimLeft(rest, " \t\r\n"); len(next) > 0 && next[0] == '}' {
		sep = ""
	}
	out := make([]byte, 0, len(trimmed)+len(blob)+len(key)+8)
	out = append(out, '{', '"')
	out = append(out, key...)
	out = append(out, '"', ':')
	out = append(out, blob...)
	out = append(out, sep...)
	out = append(out, rest...)
	return out
}
