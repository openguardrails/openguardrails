package main

import (
	"strings"
	"time"

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
// ⚠️ And it must be reassembly for THIS protocol — each protocol brings its own
// decoder (protocol/sse.go), so there is no protocol whose stream this build can only
// shrug at.
//
// The processor also OBSERVES TIMING. The canonical `step/response` payload carries
// `timing {started_at, first_token_at, completed_at}` — facts only the thing in the
// byte path can measure, and what lets the platform split time-to-first-token from
// decoding.

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

	// Wall-clock facts for the canonical payload's `timing`. startedAt is when the
	// request was RELEASED upstream (threaded in from the request phase — the
	// response phase opens only when the first chunk is already arriving, so
	// measuring from here would read TTFT as ~0); firstAt is the first chunk that
	// carried bytes; doneAt is the last chunk.
	startedAt time.Time
	firstAt   time.Time
	doneAt    time.Time
}

// newStreamProcessor builds the reader for one reply. startedAt zero means the
// request phase never stamped a release time (it always should); fall back to
// now rather than fabricate a past. suppressUsageFrame arms the decoder to
// withhold the usage-only frame the gateway's OWN opt-in produced — only ever
// true when this plugin injected `include_usage` itself (see
// protocol.UsageFrameSuppressor).
func newStreamProcessor(proto protocol.Protocol, mapping map[string]string, sse bool,
	startedAt time.Time, suppressUsageFrame bool) *streamProcessor {
	if startedAt.IsZero() {
		startedAt = time.Now()
	}
	s := &streamProcessor{proto: proto, sse: sse, startedAt: startedAt}
	if sse {
		dec := proto.NewDecoder(protocol.NewRestorer(mapping))
		if suppressUsageFrame {
			if sup, ok := dec.(protocol.UsageFrameSuppressor); ok {
				sup.SuppressUsageFrame()
			}
		}
		s.scan = protocol.NewScanner(dec)
	}
	return s
}

// ProcessChunk restores placeholders in one raw chunk and accumulates what the model
// produced.
func (s *streamProcessor) ProcessChunk(chunk []byte, isLast bool) []byte {
	if len(chunk) > 0 && s.firstAt.IsZero() {
		s.firstAt = time.Now()
	}
	if isLast {
		s.doneAt = time.Now()
	}
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

// ContentBytes is how much CLIENT-VISIBLE content (text, reasoning, tool-call
// arguments — no SSE framing) has been reassembled so far, in UTF-8 bytes. The
// tail-hold lane asks after every chunk, which is why it is a builder-length sum
// (protocol.ContentMeter) and not a rebuild of the reply. For a non-SSE body there
// is no per-frame content to meter and the tail-hold buffers the whole reply
// anyway, so the raw byte count is returned for the log's benefit only.
func (s *streamProcessor) ContentBytes() int {
	if !s.sse {
		return s.raw.Len()
	}
	return s.scan.ContentBytes()
}

// SawBytes reports whether there was anything to read at all.
func (s *streamProcessor) SawBytes() bool { return s.bytes > 0 }

// Timing renders what this processor observed, for the canonical payload. Fields the
// stream never reached stay absent rather than fabricated — an unread stream has no
// first token, and inventing one would be the timeline lying.
func (s *streamProcessor) Timing() *canonicalTiming {
	t := &canonicalTiming{StartedAt: s.startedAt.UTC().Format(time.RFC3339Nano)}
	if !s.firstAt.IsZero() {
		t.FirstTokenAt = s.firstAt.UTC().Format(time.RFC3339Nano)
	}
	if !s.doneAt.IsZero() {
		t.CompletedAt = s.doneAt.UTC().Format(time.RFC3339Nano)
	}
	return t
}

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
