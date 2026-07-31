package main

import (
	"sort"
	"strconv"
	"strings"

	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
)

// SSE handling: restore placeholders inline, and reassemble what the model
// produced so the stream can still be REPORTED as a model_output plus the
// tool_calls it asked for.
//
// ⚠️ Reassembly is not a nicety. A streaming reply is the ordinary shape of chat
// traffic, and a connector that only reports non-streaming replies makes the
// model's whole output side invisible — which is exactly what the previous
// connector did (its `process_output` is documented as "not called for STREAMING
// responses"), leaving a 230:21 request-to-response ratio in the event store.

// --- the restorer -----------------------------------------------------------

// restorer replaces placeholders in a byte stream by matching THE MAPPING'S OWN
// KEYS, never a hard-coded token syntax. `${OGR_EMAIL_1}` and a legacy
// `__ogr_email_1__` both restore with no configuration, the buffer bound is
// derived from the longest key, and a rendered `\` before punctuation is
// absorbed — a model that formats its answer as markdown emits
// `${OGR\_EMAIL\_1}`, and a restorer that does not know that leaves the user
// reading a placeholder instead of their own data.
//
// ⚠️ A WHOLE key must still match. Restoration MUST NOT fall back to fuzzy or
// prefix matching: a restorer that guesses is an exfiltration oracle — an
// attacker who can make the model emit near-miss tokens reads back values it was
// never shown. The defined unescape is the only latitude taken.
type restorer struct {
	mapping map[string]string
	keys    []string // longest first, so a key is never shadowed by a prefix
	maxRaw  int      // longest key's worst case: every byte preceded by an escape
	starts  [256]bool
}

func newRestorer(mapping map[string]string) *restorer {
	r := &restorer{mapping: mapping}
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

// extract replaces every complete key in text and splits the remainder into
// output and a pending tail that may be the beginning of a key. With isLast,
// nothing is held back: a partial token at end-of-stream is just text.
func (r *restorer) extract(text string, isLast bool) (output string, pending string) {
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

// matchAt tries every key at i, longest first, returning the key that matched
// and the RAW byte span it covers (escapes make that longer than the key), or
// partial=true when the text ran out before any key completed.
func (r *restorer) matchAt(text string, i int) (key string, raw int, partial bool) {
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

// isEscapable reports whether ch is punctuation a markdown renderer escapes.
// A fixed list on purpose: a backslash before anything else stays literal, so
// `C:\name` can never be read as an escape inside a token.
func isEscapable(ch byte) bool {
	switch ch {
	case '_', '*', '$', '{', '}', '[', ']', '(', ')', '#', '+', '-', '.', '!', '`', '~', '|', '<', '>', '\\':
		return true
	}
	return false
}

// --- the SSE processor ------------------------------------------------------

type streamProcessor struct {
	r *restorer

	// A response that is not an event stream still flows through here in observe
	// mode, where nothing is buffered: the bytes are passed on untouched and a
	// bounded copy is kept so the reply can be REPORTED at the end. Buffering the
	// whole body to read it — the enforce path's `BufferResponseBody` — is a
	// latency and memory cost an observer has no business imposing.
	sse bool
	raw strings.Builder

	lineBuf      string // incomplete SSE line carried across raw chunks
	contentBuf   string // pending tail of delta.content
	reasoningBuf string // pending tail of delta.reasoning_content

	content   strings.Builder
	toolCalls map[int]*streamToolCall
	finish    string
}

type streamToolCall struct {
	ID   string
	Name string
	Args strings.Builder
}

// maxRawAccum bounds the copy kept of a non-streamed reply. Past it the reply is
// still delivered whole and simply reported truncated: a huge answer must not
// turn into a huge allocation inside every Envoy worker.
const maxRawAccum = 512 * 1024

func newStreamProcessor(mapping map[string]string, sse bool) *streamProcessor {
	return &streamProcessor{r: newRestorer(mapping), sse: sse, toolCalls: map[int]*streamToolCall{}}
}

// ProcessChunk restores placeholders in one raw chunk and accumulates what the
// model produced. Line-oriented: SSE events are newline-delimited and a chunk
// boundary can fall anywhere, including inside a token.
func (s *streamProcessor) ProcessChunk(chunk []byte, isLast bool) []byte {
	if !s.sse {
		if s.raw.Len() < maxRawAccum {
			s.raw.Write(chunk)
		}
		return chunk
	}
	text := s.lineBuf + string(chunk)
	s.lineBuf = ""

	result := make([]byte, 0, len(chunk)+64)
	start := 0
	for i := 0; i < len(text); i++ {
		if text[i] == '\n' {
			result = append(result, s.processLine(text[start:i], isLast)...)
			result = append(result, '\n')
			start = i + 1
		}
	}
	if start < len(text) {
		tail := text[start:]
		if isLast {
			result = append(result, s.processLine(tail, true)...)
		} else {
			s.lineBuf = tail
		}
	}
	if isLast {
		s.contentBuf, s.reasoningBuf = "", ""
	}
	return result
}

func (s *streamProcessor) processLine(line string, isLast bool) string {
	if !strings.HasPrefix(line, "data: ") {
		return line
	}
	data := line[6:]
	if data == "[DONE]" {
		return line
	}
	parsed := gjson.Parse(data)
	if !parsed.IsObject() {
		return line
	}
	modified := data

	if dc := parsed.Get("choices.0.delta.content"); dc.Exists() && dc.Type == gjson.String {
		original := dc.String()
		s.content.WriteString(original)
		if restored := s.field(&s.contentBuf, original, isLast); restored != original {
			if next, err := sjson.Set(modified, "choices.0.delta.content", restored); err == nil {
				modified = next
			}
		}
	}

	if rc := parsed.Get("choices.0.delta.reasoning_content"); rc.Exists() && rc.Type == gjson.String {
		original := rc.String()
		if restored := s.field(&s.reasoningBuf, original, isLast); restored != original {
			if next, err := sjson.Set(modified, "choices.0.delta.reasoning_content", restored); err == nil {
				modified = next
			}
			if parsed.Get("choices.0.delta.reasoning").Exists() {
				if next, err := sjson.Set(modified, "choices.0.delta.reasoning", restored); err == nil {
					modified = next
				}
			}
		}
	}

	// tool_calls arrive as deltas that concatenate by index. They are also the
	// one place a placeholder MUST be restored whole: handing the client
	// `${OGR_EMAIL_1}` as a tool argument means it executes on a broken value.
	if tcs := parsed.Get("choices.0.delta.tool_calls"); tcs.IsArray() {
		for n, tc := range tcs.Array() {
			idx := int(tc.Get("index").Int())
			acc := s.toolCalls[idx]
			if acc == nil {
				acc = &streamToolCall{}
				s.toolCalls[idx] = acc
			}
			if id := tc.Get("id").String(); id != "" {
				acc.ID = id
			}
			if name := tc.Get("function.name").String(); name != "" {
				acc.Name = name
			}
			if args := tc.Get("function.arguments"); args.Exists() && args.Type == gjson.String {
				acc.Args.WriteString(args.String())
				// Restore per delta only when the whole token fits in it; a token
				// split across argument deltas is repaired by the caller from the
				// accumulated string, which is what the client's JSON parse sees.
				if restored := restoreString(args.String(), s.r.mapping); restored != args.String() {
					path := "choices.0.delta.tool_calls." + strconv.Itoa(n) + ".function.arguments"
					if next, err := sjson.Set(modified, path, restored); err == nil {
						modified = next
					}
				}
			}
		}
	}

	if fr := parsed.Get("choices.0.finish_reason"); fr.Exists() && fr.Type == gjson.String {
		s.finish = fr.String()
	}

	return "data: " + modified
}

func (s *streamProcessor) field(buf *string, text string, isLast bool) string {
	*buf += text
	output, pending := s.r.extract(*buf, isLast)
	*buf = pending
	return output
}

// Result returns what the model produced, for the model_output / tool_call
// events. The content is the text AS PRODUCED — still carrying our placeholders
// — because detecting on the restored text would find the very values we
// removed and block our own restoration.
func (s *streamProcessor) Result() (content string, calls []toolCallOut) {
	if !s.sse {
		body := gjson.Parse(s.raw.String())
		return body.Get("choices.0.message.content").String(),
			toolCallsOf(body.Get("choices.0.message"))
	}
	idx := make([]int, 0, len(s.toolCalls))
	for i := range s.toolCalls {
		idx = append(idx, i)
	}
	sort.Ints(idx)
	for _, i := range idx {
		tc := s.toolCalls[i]
		calls = append(calls, toolCallOut{ID: tc.ID, Name: tc.Name, Arguments: tc.Args.String()})
	}
	return s.content.String(), calls
}
