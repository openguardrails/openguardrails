package main

import (
	"strings"
	"testing"
	"time"
)

func TestPrivacyFailureRetainsOriginalForFailOpen(t *testing.T) {
	for _, tc := range []struct {
		name, raw string
		spans     []Span
	}{
		{name: "unknown event", raw: chunk("13800138000 OGRKR0000001") + "data: {\"type\":\"future.private\",\"text\":\"13800138000\"}\n\ndata: [DONE]\n\n"},
		{name: "truncated upstream", raw: chunk("13800138000 OGRKR0000001")},
		{name: "invalid span", raw: chunk("13800138000 OGRKR0000001") + "data: [DONE]\n\n", spans: []Span{{Path: "payload.missing", Start: 0, End: 1, Replacement: "mask"}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rs := &reqState{piiHold: true, proto: chatProto(t), session: &sessionState{Mapping: map[string]string{"OGRKR0000001": "known-secret", "${OGR_EMAIL_1}": "must-not-restore"}}, hold: newTailHold(-1, true)}
			rs.hold.holdAll = true
			rs.hold.add([]byte(tc.raw), 11, true)
			rs.sp = newStreamProcessor(rs.proto, nil, true, time.Time{}, false)
			if err := rs.finishPrivateStream([]byte(`{"text":"13800138000 OGRKR0000001"}`), tc.spans); err == nil {
				t.Fatal("expected processing failure")
			}
			var out strings.Builder
			rs.hold.releaseAll(func(b []byte, last bool) { out.Write(rs.restoreFallback(b, last)) })
			if !strings.Contains(out.String(), "known-secret") || !strings.Contains(out.String(), "13800138000") {
				t.Fatalf("original or restored secret lost on fail-open: %s", out.String())
			}
		})
	}
}

func TestPrivacyOverflowRestorerContinuesAcrossBufferedAndLiveSegments(t *testing.T) {
	rs := &reqState{piiHold: true, proto: chatProto(t), session: &sessionState{Mapping: map[string]string{"OGRKR0000001": "known-secret", "${OGR_EMAIL_1}": "must-not-restore"}}, hold: newTailHold(-1, true)}
	var out strings.Builder
	for i, part := range []string{chunk("13800138000 OGRKR"), chunk("0000"), chunk("001 ${OGR_EMAIL_1}"), "data: [DONE]\n\n"} {
		out.Write(rs.restoreFallback([]byte(part), i == 3))
	}
	reader := newStreamProcessor(rs.proto, nil, true, time.Time{}, false)
	reader.ProcessChunk([]byte(out.String()), true)
	if got := reader.Result().Text; got != "13800138000 known-secret ${OGR_EMAIL_1}" {
		t.Fatalf("bad fail-open continuation: %q", got)
	}
}
