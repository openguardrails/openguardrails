package main

import "testing"

// llm_endpoint (OGR 1.6) is the `:authority` the client dialled, normalised to a bare
// lower-cased host[:port] — and "" for anything that is not one, because the spec says a
// malformed value is IGNORED and the cheapest place to honour that is before sending.
func TestLlmEndpointOf(t *testing.T) {
	cases := map[string]string{
		"API.OpenAI.com":         "api.openai.com",
		"relay.example.net:8443": "relay.example.net:8443",
		"user:pw@gw.corp.io":     "gw.corp.io",
		"gw.corp.io/v1?x=1":      "gw.corp.io",
		"[::1]:8000":             "[::1]:8000",
		"":                       "",
		"   ":                    "",
		"not a host":             "",
		"/v1/chat":               "",
	}
	for in, want := range cases {
		if got := llmEndpointOf(in); got != want {
			t.Errorf("llmEndpointOf(%q) = %q, want %q", in, got, want)
		}
	}
}
