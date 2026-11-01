package main

import "testing"

// The identity floor. These cases are all about ONE property: two different
// callers must never end up as one agent, and one caller must never split into
// two. Everything else about the value is deliberately unspecified.
func TestDeriveCallerID(t *testing.T) {
	headers := []string{"authorization", "x-api-key", "api-key"}
	get := func(m map[string]string) func(string) string {
		return func(h string) string { return m[h] }
	}

	t.Run("bearer and bare forms of one key are the SAME caller", func(t *testing.T) {
		// ⚠️ The load-bearing case. If these differed, a caller moving their key
		// from Authorization to x-api-key would silently become a second agent —
		// the inventory would grow a row and nobody would know why.
		viaBearer := deriveCallerID(get(map[string]string{"authorization": "Bearer sk-abc123"}), headers)
		viaLower := deriveCallerID(get(map[string]string{"authorization": "bearer sk-abc123"}), headers)
		viaHeader := deriveCallerID(get(map[string]string{"x-api-key": "sk-abc123"}), headers)
		if viaBearer != viaHeader || viaLower != viaHeader {
			t.Fatalf("same credential, three ids: %q %q %q", viaBearer, viaLower, viaHeader)
		}
	})

	t.Run("different credentials are different callers", func(t *testing.T) {
		a := deriveCallerID(get(map[string]string{"authorization": "Bearer sk-aaa"}), headers)
		b := deriveCallerID(get(map[string]string{"authorization": "Bearer sk-bbb"}), headers)
		if a == b {
			t.Fatalf("two credentials collapsed into one agent: %q", a)
		}
	})

	t.Run("the credential never appears in the id", func(t *testing.T) {
		// The id is shipped to the runtime and rendered in a console. A prefix of
		// the secret would be a credential leak with an audience.
		const secret = "sk-super-secret-value"
		id := deriveCallerID(get(map[string]string{"authorization": "Bearer " + secret}), headers)
		if len(id) != len(callerPrefix)+callerHexLen {
			t.Fatalf("unexpected id shape: %q", id)
		}
		for i := 4; i <= len(secret); i++ {
			if contains(id, secret[:i]) {
				t.Fatalf("id %q contains %d bytes of the credential", id, i)
			}
		}
	})

	t.Run("no credential at all yields NO identity, never a constant", func(t *testing.T) {
		// Empty means "say nothing and let the runtime decide". Returning some
		// fixed string here would recreate the one-agent-per-gateway collapse
		// this whole path exists to remove.
		if id := deriveCallerID(get(map[string]string{}), headers); id != "" {
			t.Fatalf("expected no id, got %q", id)
		}
		if id := deriveCallerID(get(map[string]string{"authorization": "  "}), headers); id != "" {
			t.Fatalf("whitespace credential produced %q", id)
		}
		if id := deriveCallerID(get(map[string]string{"authorization": "Bearer "}), headers); id != "" {
			t.Fatalf("empty bearer produced %q", id)
		}
	})

	t.Run("header order decides, and a later header still answers", func(t *testing.T) {
		both := deriveCallerID(get(map[string]string{"authorization": "Bearer first", "x-api-key": "second"}), headers)
		first := deriveCallerID(get(map[string]string{"authorization": "Bearer first"}), headers)
		if both != first {
			t.Fatalf("first non-empty header should win: %q vs %q", both, first)
		}
		if id := deriveCallerID(get(map[string]string{"api-key": "third"}), headers); id == "" {
			t.Fatal("a credential in the last configured header was ignored")
		}
	})
}

func contains(haystack, needle string) bool {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}

// The identity header chains: the OGR spelling wins, the MSE spelling answers
// when it is absent, and nothing else is consulted.
func TestFirstHeaderChain(t *testing.T) {
	chain := []string{"x-ogr-agent-id", "x-mse-consumer"}
	get := func(m map[string]string) func(string) string {
		return func(h string) string { return m[h] }
	}

	t.Run("the OGR header outranks the MSE one", func(t *testing.T) {
		got := firstHeader(get(map[string]string{
			"x-ogr-agent-id": "alice@acme.io",
			"x-mse-consumer": "someone-else",
		}), chain)
		if got != "alice@acme.io" {
			t.Fatalf("expected the x-ogr value, got %q", got)
		}
	})

	t.Run("the MSE header answers when the OGR one is absent", func(t *testing.T) {
		// The compatibility half: higress key-auth and Alibaba MSE write
		// x-mse-consumer, not our spelling, and they must keep working with
		// zero plugin configuration.
		got := firstHeader(get(map[string]string{"x-mse-consumer": "alice@acme.io"}), chain)
		if got != "alice@acme.io" {
			t.Fatalf("expected the x-mse fallback, got %q", got)
		}
	})

	t.Run("whitespace is absence, not a value", func(t *testing.T) {
		got := firstHeader(get(map[string]string{
			"x-ogr-agent-id": "  ",
			"x-mse-consumer": "alice@acme.io",
		}), chain)
		if got != "alice@acme.io" {
			t.Fatalf("a whitespace header should not shadow the fallback, got %q", got)
		}
		if v := firstHeader(get(map[string]string{}), chain); v != "" {
			t.Fatalf("no headers should resolve to nothing, got %q", v)
		}
	})
}
