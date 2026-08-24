package main

import "testing"

/**
 * WHAT THE RUNTIME SAYS IT WILL ACCEPT (3.8.0).
 *
 * ⚠️ Every case here runs WITHOUT a wasm host, which is why `parseAdvertised` and
 * `mediaLimits` are pure and only the shared-data read/write is not. A test that
 * needs Envoy to answer "did we understand the beat" is a test nobody runs.
 */

/** The 3.7.0 world: a configured cap and a runtime that has never advertised. */
func configuredOnly(n int) mediaLimits {
	return mediaLimits{
		configured: n,
		advertised: [5]int64{capUnknown, capUnknown, capUnknown, capUnknown, capUnknown},
	}
}

func withAdvertised(configured int, image, audio, video, document, file int64) mediaLimits {
	return mediaLimits{
		configured: configured,
		advertised: [5]int64{image, audio, video, document, file},
	}
}

func TestMediaLimitFoldsConfiguredAndAdvertised(t *testing.T) {
	u := int64(capUnknown)
	cases := []struct {
		name       string
		lim        mediaLimits
		kind       string
		wantLimit  int
		wantElide  bool
	}{
		// ⚠️ THE WHOLE POINT OF THIS TABLE: `0` means "no eliding configured" on one
		// side and "this kind is refused" on the other. Both appear here.
		{"unconfigured, never advertised: 3.7.0 behaviour", configuredOnly(0), "image", 0, false},
		{"configured only", configuredOnly(1024), "image", 1024, false},
		{"advertised only", withAdvertised(0, 2048, u, u, u, u), "image", 2048, false},
		{"advertised is smaller", withAdvertised(4096, 1024, u, u, u, u), "image", 1024, false},
		{"configured is smaller — the operator's link, not ours", withAdvertised(512, 4096, u, u, u, u), "image", 512, false},
		{"advertised ZERO refuses the kind outright", withAdvertised(4096, 0, u, u, u, u), "image", 0, true},
		{"advertised ZERO refuses even with no configured cap", withAdvertised(0, 0, u, u, u, u), "image", 0, true},
		{"a kind the beat did not name falls back to the config", withAdvertised(1024, 2048, u, u, u, u), "video", 1024, false},
		{"per KIND, not one number for all", withAdvertised(0, 2048, 8192, u, u, u), "audio", 8192, false},
	}
	for _, c := range cases {
		limit, elide := c.lim.mediaLimit(c.kind)
		if limit != c.wantLimit || elide != c.wantElide {
			t.Errorf("%s: mediaLimit(%q) = (%d, %v), want (%d, %v)",
				c.name, c.kind, limit, elide, c.wantLimit, c.wantElide)
		}
	}
}

func TestScanFloorSkipsTheWalkOnlyWhenNothingCanBeElided(t *testing.T) {
	u := int64(capUnknown)
	if _, scan := configuredOnly(0).scanFloor(); scan {
		t.Error("nothing is capped and nothing is refused — the walk must be skipped entirely")
	}
	floor, scan := withAdvertised(4096, 1024, 8192, u, u, u).scanFloor()
	if !scan || floor != 1024 {
		t.Errorf("scanFloor = (%d, %v), want the SMALLEST cap in force (1024, true)", floor, scan)
	}
	// ⚠️ A refused kind forces a floor of 0: size stops mattering for it, so the
	// body's size cannot rule the walk out either.
	floor, scan = withAdvertised(4096, 0, u, u, u, u).scanFloor()
	if !scan || floor != 0 {
		t.Errorf("a refused kind must force floor 0, got (%d, %v)", floor, scan)
	}
}

func TestParseAdvertised(t *testing.T) {
	caps, ok := parseAdvertised([]byte(`{"ok":true,"limits":{"max_request_bytes":8388608,"media":{"image":8388608,"audio":0,"video":0,"document":16777216,"file":8388608},"media_parts_max":16}}`))
	if !ok {
		t.Fatal("a beat carrying limits must be learned from")
	}
	if caps[0] != 8388608 || caps[1] != 0 || caps[3] != 16777216 {
		t.Errorf("caps = %v, want the advertised numbers in kindOrder", caps)
	}

	// ⚠️ A runtime older than 0065 answers `{"ok":true}`. Reading that as "everything
	// is refused" would stop a working deployment reporting its attachments at all.
	if _, ok := parseAdvertised([]byte(`{"ok":true}`)); ok {
		t.Error("a beat with no limits must leave what we already knew alone")
	}
	// `"media": {}` names no kind — same rule.
	if _, ok := parseAdvertised([]byte(`{"ok":true,"limits":{"media":{}}}`)); ok {
		t.Error("an empty media object names no kind and must not be learned from")
	}
	// A non-200 body, or anything else that is not a beat reply.
	if _, ok := parseAdvertised([]byte(`upstream connect error`)); ok {
		t.Error("a body that is not JSON must not be learned from")
	}
	// ⚠️ A negative advertised cap is nonsense; it clamps to 0 (refused) rather than
	// being read as `capUnknown`, which is a value the wire can never send.
	caps, ok = parseAdvertised([]byte(`{"limits":{"media":{"image":-5}}}`))
	if !ok || caps[0] != 0 {
		t.Errorf("a negative cap must clamp to refused, got %v", caps[0])
	}
}

func TestKindOrderIsFrozen(t *testing.T) {
	// ⚠️ POSITIONAL, like the counter slots: reordering silently re-points every cap
	// at the wrong kind and nothing anywhere would fail.
	want := [5]string{"image", "audio", "video", "document", "file"}
	if kindOrder != want {
		t.Errorf("kindOrder = %v, want %v — the blob is positional", kindOrder, want)
	}
}
