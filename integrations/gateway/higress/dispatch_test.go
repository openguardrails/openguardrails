package main

import (
	"os"
	"strings"
	"testing"
)

// The pseudo-headers Envoy requires, plus the one bug that would be invisible: a
// caller-supplied `:path` riding along and making every callout malformed, or worse,
// sending events somewhere else. Ours are the only ones that may appear.
func TestCallHeadersOwnsThePseudoHeaders(t *testing.T) {
	h := callHeaders("runtime.example", "/v1/evaluate",
		[][2]string{{"Content-Type", "application/json"}, {":path", "/hijacked"}})

	seen := map[string]int{}
	got := map[string]string{}
	for _, kv := range h {
		seen[kv[0]]++
		got[kv[0]] = kv[1]
	}
	if seen[":path"] != 1 {
		t.Fatalf(":path appears %d times, want exactly one: %v", seen[":path"], h)
	}
	if got[":path"] != "/v1/evaluate" {
		t.Fatalf(":path = %q, want the configured path", got[":path"])
	}
	if got[":method"] != "POST" || got[":authority"] != "runtime.example" {
		t.Fatalf("method/authority = %q/%q", got[":method"], got[":authority"])
	}
	if h[0][0] != "Content-Type" {
		t.Fatalf("caller headers must survive, got %v", h)
	}
	for i, kv := range h[len(h)-3:] {
		if kv[0][0] != ':' {
			t.Fatalf("header %d of the last three is %q, not a pseudo-header", i, kv[0])
		}
	}
}

// A configured base_path is joined by the caller; a mount that lost its leading
// slash must still produce a legal :path rather than a silent 400 per event.
func TestCallHeadersNormalises(t *testing.T) {
	h := callHeaders("", "v1/evaluate", nil)
	got := map[string]string{}
	for _, kv := range h {
		got[kv[0]] = kv[1]
	}
	if got[":path"] != "/v1/evaluate" {
		t.Fatalf(":path = %q", got[":path"])
	}
	// ⚠️ Not "": an empty authority is rejected before the call leaves, and the
	// dispatch error that results says nothing about the missing host.
	if got[":authority"] != "unknownhost" {
		t.Fatalf(":authority = %q, want unknownhost", got[":authority"])
	}
}

// Every caller reads the status to decide whether a verdict exists. Anything that
// is not a readable status must land on non-200, because "the call came back but
// not from something speaking HTTP" is exactly a response with no verdict in it.
func TestCallStatus(t *testing.T) {
	cases := []struct {
		name    string
		headers [][2]string
		want    int
	}{
		{"ok", [][2]string{{"content-type", "application/json"}, {":status", "200"}}, 200},
		{"error status", [][2]string{{":status", "503"}}, 503},
		{"absent", [][2]string{{"content-type", "application/json"}}, 502},
		{"unparsable", [][2]string{{":status", "20x"}}, 502},
		{"empty", [][2]string{{":status", ""}}, 502},
		{"zero", [][2]string{{":status", "000"}}, 502},
	}
	for _, tc := range cases {
		if got := callStatus(tc.headers); got != tc.want {
			t.Errorf("%s: callStatus = %d, want %d", tc.name, got, tc.want)
		}
	}
}

// ⚠️ The regression this file exists to prevent, guarded mechanically because it is
// invisible in review: `wrapper.HttpClient` is one import away, its Post reads
// exactly like ours, and reaching for it puts the user's prompt back in the
// gateway's stdout at info — under log.go's floor, where no config can reach it.
// If you need a client method the wrapper has and ogrClient does not, write it here.
func TestNoWrapperHttpClientInTheEventPath(t *testing.T) {
	banned := []string{"wrapper.HttpClient", "wrapper.NewClusterClient", "wrapper.HttpCall", "wrapper.TargetCluster"}
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read package dir: %v", err)
	}
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		src, err := os.ReadFile(name)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		for _, b := range banned {
			// The prohibition is on CALLING it; log.go and dispatch.go name it in
			// prose to say why, and a comment prints nothing.
			for _, line := range strings.Split(string(src), "\n") {
				trimmed := strings.TrimSpace(line)
				if strings.HasPrefix(trimmed, "//") || strings.HasPrefix(trimmed, "*") || strings.HasPrefix(trimmed, "/*") {
					continue
				}
				if strings.Contains(line, b) {
					t.Errorf("%s uses %s — events must post through ogrClient (dispatch.go), which does not log the payload:\n\t%s",
						name, b, trimmed)
				}
			}
		}
	}
}
