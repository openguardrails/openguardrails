package main

import (
	"os"
	"strings"
	"testing"
)

// The heartbeat carries the plugin's version, and that is how an operator learns
// WHICH build is in the VM. A stale constant is worse than no version at all: it
// names a build that is not running, so the one signal that could have caught a
// bad rollout confirms the wrong thing instead.
//
// Nothing tied this constant to the VERSION file before, and it drifted through
// two releases — 1.3.0 and 1.4.0 both shipped while it still said 1.2.0.
func TestPluginVersionMatchesTheVERSIONFile(t *testing.T) {
	raw, err := os.ReadFile("VERSION")
	if err != nil {
		t.Fatalf("reading VERSION: %v", err)
	}
	want := strings.TrimSpace(string(raw))
	if pluginVersion != want {
		t.Fatalf("pluginVersion = %q but VERSION says %q: the heartbeat would report the wrong build",
			pluginVersion, want)
	}
}
