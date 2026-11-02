package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/openguardrails/higress/protocol"
)

// Filters after this plugin can parse each injected buffer as SSE. Compression
// must preserve the frame boundaries used by the uncompressed release path.
func TestCompressedReplayInjectsCompleteSSEFrames(t *testing.T) {
	for _, ending := range []string{"\n", "\r\n"} {
		for _, size := range []int{73, 32768, 100000} {
			t.Run(fmt.Sprintf("ending=%q/argument=%d", ending, size), func(t *testing.T) {
				h := newTailHold(-1, true)
				var want []byte
				for i := 0; i < 1200; i++ {
					b, err := json.Marshal(map[string]any{
						"choices": []any{map[string]any{
							"delta": map[string]any{"tool_calls": []any{map[string]any{
								"index": 0, "function": map[string]any{"arguments": strings.Repeat("x", size)},
							}}},
						}},
					})
					if err != nil {
						t.Fatal(err)
					}
					frame := append([]byte("data: "), b...)
					frame = append(frame, ending+ending...)
					want = append(want, frame...)
					h.add(frame, 0, true)
					if len(want) > 300000 {
						break
					}
				}
				if h.z == nil {
					t.Fatal("fixture did not enter compressed replay")
				}
				var got []byte
				ends := 0
				h.releaseAll(func(b []byte, last bool) {
					if !bytes.HasSuffix(b, []byte(ending+ending)) {
						t.Errorf("injected %d bytes ending inside an SSE frame", len(b))
					}
					got = append(got, b...)
					if last {
						ends++
					}
				})
				if !bytes.Equal(got, want) || ends != 1 {
					t.Fatalf("replay changed bytes or endStream: %d", ends)
				}
			})
		}
	}
}

func TestCompressedReplayPreservesBinaryBodiesAndUnterminatedTails(t *testing.T) {
	for _, sse := range []bool{false, true} {
		t.Run(fmt.Sprintf("sse=%t", sse), func(t *testing.T) {
			h := newTailHold(-1, sse)
			// No final newline: even a malformed upstream tail must be preserved,
			// never repaired by adding a byte or silently lost at EOF.
			want := bytes.Repeat([]byte("raw\x00tail"), 16000)
			h.add(want, 0, true)
			var got []byte
			ends := 0
			h.releaseAll(func(b []byte, last bool) {
				if !sse && len(b) > 32<<10 {
					t.Errorf("binary replay grew past its chunk bound: %d", len(b))
				}
				got = append(got, b...)
				if last {
					ends++
				}
			})
			if !bytes.Equal(got, want) || ends != 1 {
				t.Fatalf("replay changed bytes or endStream: %d", ends)
			}
		})
	}
}

// THE COMPRESSED TAIL (2026-09-23). What is pinned: the client receives EXACTLY the
// bytes the model sent — the hold understands nothing about them — and a held file
// write occupies about its compressed size, not its frames.

// replay drives a stream through the processor and the hold and returns everything
// the client received (released early + released on allow) and the hold.
func replay(t *testing.T, spec streamSpec, max int) (wire []byte, got []byte, h *tailHold) {
	t.Helper()
	sp := newStreamProcessor(protocol.ByName("openai.chat"), nil, true, time.Now(), false)
	h = newTailHold(-1, true)
	h.max = max
	var out bytes.Buffer
	cs := chunks(spec.frames())
	for i, c := range cs {
		wire = append(wire, c...)
		last := i == len(cs)-1
		h.sawCalls = sp.SawCalls()
		for _, seg := range sp.ProcessChunkSegments(c, last) {
			if last {
				h.add(seg.Bytes, seg.Content, true)
				continue
			}
			for _, b := range h.push(seg.Bytes, seg.Content, seg.Hold) {
				out.Write(b)
			}
		}
	}
	return wire, out.Bytes(), h
}

func TestTheCompressedTailReachesTheClientByteForByte(t *testing.T) {
	spec := streamSpec{name: "write", text: "writing it", callArgs: fileArgs(150 << 10)}
	wire, early, h := replay(t, spec, 0)
	if h.z == nil {
		t.Fatal("a 12 MB held call was never compressed")
	}
	var lastSeen, lastCount int
	all := append([]byte(nil), early...)
	h.releaseAll(func(b []byte, last bool) {
		all = append(all, b...)
		if last {
			lastCount++
			lastSeen = len(all)
		}
	})
	if !bytes.Equal(all, wire) {
		t.Fatalf("the client did not receive the model's bytes: got %d, want %d", len(all), len(wire))
	}
	if lastCount != 1 || lastSeen != len(all) {
		t.Fatalf("endStream must ride exactly the final piece (count %d)", lastCount)
	}
}

// ⚠️ PINNED: before compression this was 12 MB — past the 8 MiB bound, so the write
// went out UNJUDGED under fail-open.
func TestAHeldFileWriteOccupiesItsCompressedSize(t *testing.T) {
	spec := streamSpec{name: "write", text: "ok", callArgs: fileArgs(150 << 10)}
	_, _, h := replay(t, spec, 8<<20)
	if h.memBytes() > 1<<20 {
		t.Fatalf("a 150 KB write occupies %d bytes", h.memBytes())
	}
	if h.overflowed() {
		t.Fatal("a 150 KB write overflowed the 8 MiB bound")
	}
}

func TestATextReplyNeverStartsTheCompressor(t *testing.T) {
	zh := strings.Repeat("这是一段不含工具调用的长回答，", 3000)
	_, _, h := replay(t, streamSpec{name: "text", text: zh}, 0)
	if h.z != nil {
		t.Fatal("a text reply, which holds only its ending, paid for a compressor")
	}
}

// Overflow under fail-open releases what is held, compressed part included, in order.
func TestABypassReleasesTheCompressedTailInOrder(t *testing.T) {
	spec := streamSpec{name: "write", text: "ok", callArgs: fileArgs(150 << 10)}
	wire, early, h := replay(t, spec, 0)
	h.settled, h.bypass = true, true
	all := append([]byte(nil), early...)
	h.releaseAll(func(b []byte, _ bool) { all = append(all, b...) })
	if !bytes.Equal(all, wire) {
		t.Fatal("a bypass reordered or lost held bytes")
	}
	if !h.releasedCalls {
		t.Fatal("released call bytes were not recorded — a soft ending would be allowed")
	}
}

func TestDropDiscardsTheCompressedTail(t *testing.T) {
	_, _, h := replay(t, streamSpec{name: "write", text: "ok", callArgs: fileArgs(150 << 10)}, 0)
	h.drop()
	if h.z != nil || h.memBytes() != 0 {
		t.Fatal("drop kept the compressed tail")
	}
}
