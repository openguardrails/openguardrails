package protocol

import "strings"

// SSE framing, shared; SSE SEMANTICS, per protocol.
//
// All three protocols stream `data: <json>` lines, so the byte-level work — finding
// line boundaries, carrying a line that a chunk split in half — is identical and
// lives here. What the JSON MEANS is not remotely identical:
//
//	openai.chat        choices[].delta.{content,tool_calls[].function.arguments}
//	openai.responses   response.output_text.delta, response.function_call_arguments.delta
//	anthropic.messages content_block_delta.delta.{text,partial_json}, keyed by index
//
// They do not share a single field name, which is why reassembly is a Decoder each
// protocol implements rather than one reader with three branches. Feeding one
// protocol's stream to another's decoder accumulates nothing and reports the model
// as having said nothing — a failure indistinguishable from a silent model.

// Decoder reassembles one protocol's streamed reply and restores placeholders in the
// frames on their way to the caller.
type Decoder interface {
	// Line handles one complete SSE line, newline stripped, and returns the text to
	// forward in its place. A line it does not recognise must be returned unchanged:
	// a decoder that drops what it does not understand corrupts the stream for the
	// client, which is a worse outcome than not reading it.
	Line(line string, isLast bool) string

	// Flush renders whatever the restorer is still holding as complete extra frames,
	// or "" when it holds nothing.
	//
	// ⚠️ Frames, not bare bytes. The client parses frames; text written outside one
	// is not part of the answer, it is a protocol error.
	Flush() string

	// Output is the reply reassembled so far.
	//
	// ⚠️ The text is AS PRODUCED — still carrying our placeholders — because
	// detecting on the restored text would find the very values we removed and block
	// our own restoration.
	Output() Output
}

/*
 * CallWatcher is implemented by a Decoder that can say whether it has seen any
 * TOOL-CALL bytes yet. Optional, and type-asserted exactly like FrameCounter.
 *
 * ⚠️⚠️ It exists for ONE decision, and getting it wrong executes an action nobody
 * approved. A refused stream that already released bytes can be ended on a normal
 * `stop` — which is what lets an agent loop survive — only while the client cannot
 * have assembled an actionable tool call from what it has. Once tool-call deltas are
 * out, the client holds a partial call, and harnesses act on `tool_calls` being
 * non-empty rather than on the finish reason (measured in hermes:
 * `if assistant_message.tool_calls:`). Ending THAT on `stop` would have it run a call
 * with truncated arguments.
 *
 * ⚠️ A decoder that does not implement this is treated as HAVING seen calls — the
 * side that keeps the hard retraction, which is today's behaviour and refuses whole.
 */
type CallWatcher interface {
	SawCalls() bool
}

// FrameCounter is implemented by a Decoder that counts the data frames it
// RECOGNISED as its own protocol's — a chat chunk with a `choices` array, an
// anthropic event of a known type, a `response.*` event. It exists to split an
// empty reassembly's two very different causes: a WELL-FORMED stream whose
// answer was genuinely empty (frames recognised — the model said nothing, which
// is a reportable reply), and bytes this decoder could not read at all (zero —
// a wrong dialect, a compressed body, garbage), which is the real `unreadable`.
type FrameCounter interface {
	RecognizedFrames() int
}

// RecognizedFrames is the count of protocol-recognised data frames, or 0 for a
// decoder that does not count (which conservatively reads as "unreadable" when
// the reassembly is empty — never as a fabricated empty reply).
func (s *Scanner) RecognizedFrames() int {
	if c, ok := s.dec.(FrameCounter); ok {
		return c.RecognizedFrames()
	}
	return 0
}

// SawCalls delegates to the decoder — see CallWatcher.
//
// ⚠️ TRUE when the decoder cannot answer, which is the side that keeps the hard
// retraction. The opposite default would end a stream normally while the client held
// a partial call.
func (s *Scanner) SawCalls() bool {
	if w, ok := s.dec.(CallWatcher); ok {
		return w.SawCalls()
	}
	return true
}

// ContentMeter is implemented by a Decoder that can report, cheaply, how much
// CLIENT-VISIBLE content it has reassembled so far: text, reasoning and tool-call
// arguments, in UTF-8 bytes, excluding all SSE framing. It exists for the
// tail-hold enforcement lane, which withholds the stream's last N content bytes
// and needs a running total on every chunk — cheap enough to ask per chunk, where
// rebuilding Output() would be O(reply) each time.
type ContentMeter interface {
	ContentBytes() int
}

// ContentBytes is the running client-visible content total, via the decoder's
// ContentMeter when it has one, else by measuring a freshly built Output (correct,
// just O(reply) per call — every decoder in this package implements the meter).
func (s *Scanner) ContentBytes() int {
	if m, ok := s.dec.(ContentMeter); ok {
		return m.ContentBytes()
	}
	out := s.dec.Output()
	n := len(out.Text) + len(out.Reasoning)
	for _, a := range out.Actions {
		n += len(a.Arguments)
	}
	return n
}

// SSEData returns the payload of a `data:` line.
func SSEData(line string) (string, bool) {
	if !strings.HasPrefix(line, "data:") {
		return "", false
	}
	return strings.TrimPrefix(line[5:], " "), true
}

// SSEFrame wraps a payload as one complete SSE event.
func SSEFrame(payload string) string { return "data: " + payload + "\n\n" }

// Scanner splits a byte stream into SSE lines and hands each to a Decoder.
type Scanner struct {
	dec Decoder
	// carry is an incomplete line held across chunks. A chunk boundary can fall
	// anywhere, including inside a JSON string, so nothing may be parsed until its
	// line is whole.
	carry string
}

func NewScanner(dec Decoder) *Scanner { return &Scanner{dec: dec} }

/*
 * Segment is one complete SSE FRAME on its way to the caller, tagged with the
 * running client-visible content total at the moment it was produced.
 *
 * ⚠️⚠️ **A FRAME, NEVER A LINE AND NEVER A CHUNK.** The frame is what the client
 * DISPATCHES — a `data:` line is inert until its blank terminator arrives — so it is
 * the smallest unit that may be released on its own. And the CHUNK is far too coarse
 * to be that unit: measured on this lab, one upstream chunk is ~16 KB carrying 329
 * bytes of content, so a release rule working in whole chunks cannot express any
 * bound smaller than a third of the answer. That is not a tuning problem, it is the
 * difference between a head budget that means what it says and one that silently
 * rounds to "the first chunk".
 *
 * ⚠️ Anything that is not a terminated frame — a comment, a trailing partial, the
 * end-of-stream Flush — accumulates into the segment being built and is closed out
 * at the end of the chunk. Never dropped and never reordered.
 */
type Segment struct {
	Bytes []byte
	// Content is the scanner's running ContentBytes() AFTER this segment, i.e.
	// exactly the exposure a caller holds once it has been released.
	Content int
}

// Chunk processes one raw chunk and returns the bytes to forward.
//
// The concatenation of ChunkSegments, for callers that do not enforce on the stream.
func (s *Scanner) Chunk(chunk []byte, isLast bool) []byte {
	var out []byte
	for _, seg := range s.ChunkSegments(chunk, isLast) {
		out = append(out, seg.Bytes...)
	}
	return out
}

// ChunkSegments processes one raw chunk and returns the bytes to forward, split at
// FRAME boundaries so a release rule can work in units the client can actually act
// on. See Segment.
func (s *Scanner) ChunkSegments(chunk []byte, isLast bool) []Segment {
	text := s.carry + string(chunk)
	s.carry = ""

	var segs []Segment
	cur := make([]byte, 0, len(chunk)+64)
	start := 0
	for i := 0; i < len(text); i++ {
		if text[i] != '\n' {
			continue
		}
		line := text[start:i]
		cur = append(cur, s.dec.Line(line, isLast)...)
		cur = append(cur, '\n')
		start = i + 1
		/*
		 * ⚠️ An EMPTY line terminates a frame, and that is where a segment closes —
		 * the blank line travels WITH the data line it terminates, never as a segment
		 * of its own. Releasing a `data:` line while holding its terminator would give
		 * the client an event it can never dispatch: bytes delivered, nothing rendered,
		 * and the exposure counted against the budget all the same.
		 * ⚠️ `\r` is trimmed for the emptiness test only — a CRLF stream's terminator
		 * is still a terminator, and the bytes forwarded are untouched either way.
		 */
		if strings.TrimRight(line, "\r") == "" {
			segs = append(segs, Segment{Bytes: cur, Content: s.ContentBytes()})
			cur = make([]byte, 0, 64)
		}
	}
	if start < len(text) {
		tail := text[start:]
		if isLast {
			cur = append(cur, s.dec.Line(tail, true)...)
		} else {
			s.carry = tail
		}
	}
	if isLast {
		// Backstop for a stream that ends without its own terminator — a dropped
		// upstream connection. Nothing more is coming, so whatever the restorer is
		// holding is text, not the start of a token.
		cur = append(cur, s.dec.Flush()...)
	}
	// Whatever did not end on a frame boundary — a comment, a flush, a stream that
	// never terminates its last frame — closes the chunk as its own segment rather
	// than being dropped or merged into the NEXT chunk's first frame.
	if len(cur) > 0 {
		segs = append(segs, Segment{Bytes: cur, Content: s.ContentBytes()})
	}
	return segs
}

// Output is the reply reassembled so far.
func (s *Scanner) Output() Output { return s.dec.Output() }
