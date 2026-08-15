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

// Chunk processes one raw chunk and returns the bytes to forward.
func (s *Scanner) Chunk(chunk []byte, isLast bool) []byte {
	text := s.carry + string(chunk)
	s.carry = ""

	out := make([]byte, 0, len(chunk)+64)
	start := 0
	for i := 0; i < len(text); i++ {
		if text[i] != '\n' {
			continue
		}
		out = append(out, s.dec.Line(text[start:i], isLast)...)
		out = append(out, '\n')
		start = i + 1
	}
	if start < len(text) {
		tail := text[start:]
		if isLast {
			out = append(out, s.dec.Line(tail, true)...)
		} else {
			s.carry = tail
		}
	}
	if isLast {
		// Backstop for a stream that ends without its own terminator — a dropped
		// upstream connection. Nothing more is coming, so whatever the restorer is
		// holding is text, not the start of a token.
		out = append(out, s.dec.Flush()...)
	}
	return out
}

// Output is the reply reassembled so far.
func (s *Scanner) Output() Output { return s.dec.Output() }
