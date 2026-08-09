package main

import (
	"strings"

	"github.com/openguardrails/higress/protocol"
	"github.com/tidwall/gjson"
)

// Reading the model's reply, streamed or not.
//
// ⚠️ Reassembly is not a nicety. A streaming reply is the ordinary shape of chat
// traffic, and a connector that only reports non-streaming replies makes the model's
// whole output side invisible — which is exactly what the previous connector did (its
// `process_output` is documented as "not called for STREAMING responses"), leaving a
// 230:21 request-to-response ratio in the event store.
//
// ⚠️ And it must be reassembly for THIS protocol. There used to be a
// `streamReassemblySupported()` that answered true for `openai.chat` and false for the
// other two, because the reader hard-coded `choices.0.delta.*`: fed an Anthropic or a
// Responses stream it accumulated nothing, `Result()` came back empty, and the output
// side of every streamed answer went unreported. That is gone — each protocol brings
// its own decoder (protocol/sse.go), so there is no longer a protocol whose stream this
// build can only shrug at.

// maxRawAccum bounds the copy kept of a non-streamed reply. Past it the reply is still
// delivered whole and simply reported truncated: a huge answer must not turn into a
// huge allocation inside every Envoy worker.
const maxRawAccum = 512 * 1024

type streamProcessor struct {
	proto protocol.Protocol

	// sse distinguishes a real event stream from a plain body flowing through this
	// hook. A non-streamed response still passes here in OBSERVE mode, where nothing
	// is buffered: the bytes are passed on untouched and a bounded copy is kept so the
	// reply can be REPORTED at the end. Buffering the whole body to read it — the
	// enforce path's `BufferResponseBody` — is a latency and memory cost an observer
	// has no business imposing.
	sse  bool
	scan *protocol.Scanner
	raw  strings.Builder
	// bytes is how much the upstream actually sent. It is the evidence that separates
	// "the model said nothing" from "we could not read a single frame of what it sent"
	// — two states that look identical from an empty Result and mean opposite things.
	bytes int
}

func newStreamProcessor(proto protocol.Protocol, mapping map[string]string, sse bool) *streamProcessor {
	s := &streamProcessor{proto: proto, sse: sse}
	if sse {
		s.scan = protocol.NewScanner(proto.NewDecoder(protocol.NewRestorer(mapping)))
	}
	return s
}

// ProcessChunk restores placeholders in one raw chunk and accumulates what the model
// produced.
func (s *streamProcessor) ProcessChunk(chunk []byte, isLast bool) []byte {
	s.bytes += len(chunk)
	if !s.sse {
		if s.raw.Len() < maxRawAccum {
			s.raw.Write(chunk)
		}
		return chunk
	}
	return s.scan.Chunk(chunk, isLast)
}

// Bytes is how much the upstream sent.
func (s *streamProcessor) Bytes() int { return s.bytes }

// SawBytes reports whether there was anything to read at all.
func (s *streamProcessor) SawBytes() bool { return s.bytes > 0 }

// Result is what the model produced.
//
// ⚠️ The text is AS PRODUCED — still carrying our placeholders — because detecting on
// the restored text would find the very values we removed and block our own
// restoration.
func (s *streamProcessor) Result() protocol.Output {
	if !s.sse {
		return s.proto.ParseResponse(gjson.Parse(s.raw.String()))
	}
	return s.scan.Output()
}
