package main

import (
	"encoding/json"
	"fmt"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/openguardrails/higress/protocol"
)

// WHAT ONE ENFORCED STREAM COSTS IN THE HEAP (2026-09-23).
//
// mcd reported gateways restarting; a Go-compiled Wasm heap never shrinks, so what
// matters is each worker VM's PEAK. This replays realistic streams through the same
// code the filter runs (scanner → decoder → hold → end-of-stream evaluate body) and
// reports, per stream: the withheld frames, the reassembly, what is live at the
// verdict moment, and the total allocated (garbage the GC has to catch up with).
//
// Host Go, not Wasm — the allocation SIZES are the same code's; the collector's
// timing is not. Run with OGR_MEMREPORT=1 to print the table.

const chatHead = `{"id":"chatcmpl-AJq8Zb3xY7pQ2mN9vK4tR1sL","object":"chat.completion.chunk","created":1758600000,"model":"gpt-4.1-2025-04-14","system_fingerprint":"fp_3f58d112f7","choices":[{"index":0,"delta":`
const chatTail = `,"logprobs":null,"finish_reason":null}]}`

func chatFrame(delta string) string { return "data: " + chatHead + delta + chatTail + "\n\n" }

func jsonStr(s string) string { b, _ := json.Marshal(s); return string(b) }

// tokens splits text into ~4-byte pieces, the delta size a provider emits.
func tokens(text string, per int) []string {
	r := []rune(text)
	var out []string
	for i := 0; i < len(r); i += per {
		j := i + per
		if j > len(r) {
			j = len(r)
		}
		out = append(out, string(r[i:j]))
	}
	return out
}

type streamSpec struct {
	name      string
	reasoning string
	text      string
	callArgs  string // a Write-style call's JSON arguments; "" = none
}

func (s streamSpec) frames() []string {
	var f []string
	f = append(f, chatFrame(`{"role":"assistant","content":""}`))
	for _, t := range tokens(s.reasoning, 2) {
		f = append(f, chatFrame(`{"reasoning_content":`+jsonStr(t)+`}`))
	}
	for _, t := range tokens(s.text, 2) {
		f = append(f, chatFrame(`{"content":`+jsonStr(t)+`}`))
	}
	if s.callArgs != "" {
		f = append(f, chatFrame(`{"tool_calls":[{"index":0,"id":"call_abc123","type":"function","function":{"name":"Write","arguments":""}}]}`))
		for _, t := range tokens(s.callArgs, 4) {
			f = append(f, chatFrame(`{"tool_calls":[{"index":0,"function":{"arguments":`+jsonStr(t)+`}}]}`))
		}
	}
	f = append(f, "data: "+chatHead+`{}`+strings.Replace(chatTail, `"finish_reason":null`, `"finish_reason":"stop"`, 1)+"\n\n")
	f = append(f, "data: [DONE]\n\n")
	return f
}

// chunks packs frames into ~4 KB upstream chunks.
func chunks(frames []string) [][]byte {
	var out [][]byte
	var cur strings.Builder
	for _, f := range frames {
		cur.WriteString(f)
		if cur.Len() >= 4096 {
			out = append(out, []byte(cur.String()))
			cur.Reset()
		}
	}
	if cur.Len() > 0 {
		out = append(out, []byte(cur.String()))
	}
	return out
}

func live() uint64 {
	runtime.GC()
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return m.HeapAlloc
}

func totalAlloc() uint64 {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return m.TotalAlloc
}

type memReport struct {
	wire, held, reassembled, allocated uint64
	liveBeforeVerdict, liveAtVerdict   int64
}

// runStream drives one stream exactly as holdChunk + judgeFinal do, minus proxywasm.
func runStream(t *testing.T, spec streamSpec) memReport {
	t.Helper()
	cs := chunks(spec.frames())
	var wire uint64
	for _, c := range cs {
		wire += uint64(len(c))
	}
	base := live()
	alloc0 := totalAlloc()

	sp := newStreamProcessor(protocol.ByName("openai.chat"), nil, true, time.Now(), false)
	h := newTailHold(-1, true)
	for i, c := range cs {
		last := i == len(cs)-1
		h.sawCalls = sp.SawCalls()
		segs := sp.ProcessChunkSegments(c, last)
		for _, seg := range segs {
			if last {
				h.add(seg.Bytes, seg.Content, true)
				continue
			}
			_ = h.push(seg.Bytes, seg.Content, seg.Hold) // released = injected and gone
		}
	}
	before := int64(live()) - int64(base)

	// The verdict moment: finishAllow's body + the evaluate request.
	rs := &reqState{derive: &deriveCtx{stepID: "st-x", protocol: "openai.chat"}, model: "gpt-4.1"}
	out := sp.Result()
	e := responseEventCanonical(rs.derive, canonicalOf(rs, out, sp.Timing()))
	payload, _ := json.Marshal(e)
	held := uint64(h.memBytes())
	// finishAllow: segment by segment into the chain; each is gone once injected.
	var peak int64
	h.releaseAll(func(b []byte, last bool) {
		if l := int64(live()) - int64(base); l > peak {
			peak = l
		}
	})
	at := peak
	rep := memReport{
		wire:              wire,
		held:              held,
		reassembled:       uint64(len(out.Text) + len(out.Reasoning) + len(argsOf(out))),
		liveBeforeVerdict: before,
		liveAtVerdict:     at,
		allocated:         totalAlloc() - alloc0,
	}
	runtime.KeepAlive(sp)
	runtime.KeepAlive(h)
	runtime.KeepAlive(payload)
	runtime.KeepAlive(cs)
	return rep
}

func argsOf(o protocol.Output) string {
	var b strings.Builder
	for _, a := range o.Actions {
		b.WriteString(a.Arguments)
	}
	return b.String()
}

func fileArgs(size int) string {
	line := "    const handler = async (req, res) => { res.json({ ok: true, id: req.params.id }); };\n"
	body := strings.Repeat(line, size/len(line)+1)[:size]
	b, _ := json.Marshal(map[string]string{"file_path": "/repo/src/server/routes.ts", "content": body})
	return string(b)
}

func memSpecs() []streamSpec {
	zh := strings.Repeat("这是一段用来测量网关插件内存占用的中文回答文本，", 800) // ~20k chars
	return []streamSpec{
		{name: "text 20k chars + reasoning 5k", reasoning: zh[:len(zh)/4], text: zh},
		{name: "prose + Write 30 KB", text: zh[:600], callArgs: fileArgs(30 << 10)},
		{name: "prose + Write 150 KB", text: zh[:600], callArgs: fileArgs(150 << 10)},
	}
}

func TestMemoryPerStream(t *testing.T) {
	if os.Getenv("OGR_MEMREPORT") == "" {
		t.Skip("set OGR_MEMREPORT=1 to measure")
	}
	kb := func(n uint64) string { return fmt.Sprintf("%8.0f KB", float64(n)/1024) }
	kbi := func(n int64) string { return fmt.Sprintf("%8.0f KB", float64(n)/1024) }
	t.Logf("%-32s %11s %11s %11s %11s %11s %11s", "stream", "wire", "held", "reassembled", "live@end", "live@verdict", "allocated")
	for _, s := range memSpecs() {
		r := runStream(t, s)
		t.Logf("%-32s %s %s %s %s %s %s", s.name, kb(r.wire), kb(r.held), kb(r.reassembled), kbi(r.liveBeforeVerdict), kbi(r.liveAtVerdict), kb(r.allocated))
	}
}
