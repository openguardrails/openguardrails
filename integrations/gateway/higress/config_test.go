package main

import "testing"

// The canonical binding (specification/runtime-api.md) is a joining contract:
// a configured base plus `/v1/...`, and no other prefix hard-coded. These
// tests pin the two halves — the constants ARE the canonical paths, and the
// normalizer can never produce a join with a double or missing slash.

func TestCanonicalPathsAreTheV1Root(t *testing.T) {
	// Two paths, not three — /v1/ingest left the API in v0.8.
	if pathEvaluate != "/v1/evaluate" || pathHeartbeat != "/v1/heartbeat" {
		t.Fatalf("the path constants must be the canonical /v1/* paths, got %q %q — a prefix belongs in base_path, not here",
			pathEvaluate, pathHeartbeat)
	}
}

func TestNormalizeBasePath(t *testing.T) {
	cases := []struct{ in, want string }{
		{"", ""},                                   // canonical root, the default
		{"/", ""},                                  // a lone slash would join to //v1/...
		{"/api/public/ogr", "/api/public/ogr"},     // the reference runtime's legacy mount
		{"/api/public/ogr/", "/api/public/ogr"},    // trailing slash absorbed
		{"api/public/ogr", "/api/public/ogr"},      // leading slash supplied
		{"  /api/public/ogr  ", "/api/public/ogr"}, // YAML whitespace absorbed
		{"/api/public/ogr//", "/api/public/ogr"},   // every trailing slash, not just one
	}
	for _, c := range cases {
		if got := normalizeBasePath(c.in); got != c.want {
			t.Errorf("normalizeBasePath(%q) = %q, want %q", c.in, got, c.want)
		}
		// The property the callers rely on: joined with a canonical path, the
		// result has exactly one slash at the seam.
		joined := normalizeBasePath(c.in) + pathEvaluate
		if want := c.want + "/v1/evaluate"; joined != want {
			t.Errorf("join for %q = %q, want %q", c.in, joined, want)
		}
	}
}
