package main

import "testing"

func TestQuietIsTheDefaultAndATypoDoesNotTurnLoggingOn(t *testing.T) {
	// The failure mode of this setting is disk, so anything unrecognised must fall to
	// quiet. An operator who meant `info` notices silence long before a fleet notices
	// a full volume.
	for _, in := range []string{"", "verbose", "INFO", "warn", "true", "1"} {
		if got := parseLogLevel(in); got != logQuiet {
			t.Errorf("parseLogLevel(%q) = %d, want quiet", in, got)
		}
	}
	if parseLogLevel("info") != logInfo {
		t.Error("info")
	}
	if parseLogLevel("debug") != logDebug {
		t.Error("debug")
	}
}

// ⚠️ THIS IS THE TEST THAT WOULD HAVE CAUGHT THE BUG THE COUNTERS SHIPPED WITH.
//
// `counters()` carried its own four-element name list while the slot enum had grown to
// six, so `stream_stopped` and `unresolved_spans` were incremented on every occurrence
// and then dropped — the runtime received a heartbeat asserting they had never
// happened. Nothing failed; the numbers were simply absent, which reads as evidence of
// absence.
//
// It matters more now: `log.go` silences those warnings by default and the counter is
// what carries them instead. A slot without a name is a signal with no way out.
func TestEverySlotHasAName(t *testing.T) {
	if len(counterNames) != cntLen {
		t.Fatalf("counterNames has %d entries, cntLen is %d", len(counterNames), cntLen)
	}
	seen := map[string]int{}
	for slot, name := range counterNames {
		if name == "" {
			t.Errorf("counter slot %d has no wire name — it can be bumped but never reported", slot)
			continue
		}
		if prev, dup := seen[name]; dup {
			t.Errorf("slots %d and %d both report as %q — one of them is invisible", prev, slot, name)
		}
		seen[name] = slot
	}
}

// The slots are packed positionally into one shared-data blob, so an insert in the
// middle silently re-reads every existing counter as its neighbour. Pin the original
// four SLOTS; appending is safe, reordering is not. (Slot 2's WIRE NAME changed with
// v0.8 — "ingested" became "reported" when /v1/ingest left the API — which is a
// rename of what the number is called, not a move of where it is stored: the blob
// stays readable across the upgrade.)
func TestTheOriginalSlotOrderIsFrozen(t *testing.T) {
	for i, want := range []string{"evaluated", "unchecked", "reported", "mirrored"} {
		if counterNames[i] != want {
			t.Errorf("slot %d is %q, want %q — reordering re-reads every stored counter as its neighbour",
				i, counterNames[i], want)
		}
	}
}
