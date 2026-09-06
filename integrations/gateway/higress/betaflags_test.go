package main

import "testing"

// ⚠️ TEMPORARY, and it goes when betaflags.go goes.
//
// The gray-release gate has exactly one property worth pinning: it can only ever
// move a request TOWARD observe. Everything below is that sentence, split in two —
// who is in the gray set (hasBetaFlag) and what membership buys (gatedMode).

func TestHasBetaFlag(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{"og-airs", true},
		{"og-airs,other-beta", true},
		{"other-beta,og-airs", true},
		{" og-airs , other ", true}, // the header is written by hand; spaces happen
		{"OG-AIRS", true},           // token case is not a membership decision
		{"a,,og-airs,", true},       // empty tokens are not a parse failure

		{"", false},           // no header at all — the overwhelmingly common case
		{"   ", false},        // present and empty says nothing
		{"other-beta", false}, // someone else's rollout
		// ⚠️ Exact tokens, never substrings: a future flag that merely CONTAINS
		// our name must not enroll its traffic into ours.
		{"og-airs-v2", false},
		{"xog-airs", false},
		{"og-airsx", false},
	}
	for _, c := range cases {
		if got := hasBetaFlag(c.in); got != c.want {
			t.Errorf("hasBetaFlag(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestGatedModeOnlyEverNarrows(t *testing.T) {
	// In the gray set: the configured mode applies, unchanged, both ways.
	if got := gatedMode(true, modeEnforce); got != modeEnforce {
		t.Errorf("og-airs + mode:enforce = %q, want enforce — the gate must not disable a mode it was asked for", got)
	}
	if got := gatedMode(true, modeObserve); got != modeObserve {
		t.Errorf("og-airs + mode:observe = %q, want observe", got)
	}

	// Out of it: observe, whatever the config says. This is the whole point.
	if got := gatedMode(false, modeEnforce); got != modeObserve {
		t.Errorf("no flag + mode:enforce = %q, want observe — ungated traffic must never be enforced on", got)
	}
	if got := gatedMode(false, modeObserve); got != modeObserve {
		t.Errorf("no flag + mode:observe = %q, want observe", got)
	}

	// ⚠️ The direction property, stated as itself: there is no input for which the
	// gate produces enforce out of a request that carries no flag.
	for _, configured := range []string{modeEnforce, modeObserve, "", "nonsense"} {
		if gatedMode(false, configured) == modeEnforce {
			t.Fatalf("gatedMode(false, %q) reached enforce — the gate may only narrow", configured)
		}
	}
}
