package main

import (
	"strings"

	"github.com/higress-group/proxy-wasm-go-sdk/proxywasm"
)

// Why this plugin dispatches its own HTTP calls.
//
// Until 3.8.1 every evaluate POST went through `wrapper.HttpClient` from
// higress-group/wasm-go, which is a thin shell over `proxywasm.DispatchHttpCall`
// with one addition that made it unusable here:
//
//	proxywasm.LogInfof("http call start, id: %s, ..., body: %s, timeout: %d", ...)
//	proxywasm.LogInfof("http call end, id: %s, code: %d, normal: %t, body: %s", ...)
//
// Unconditional, at INFO, in `pkg/wrapper/http_wrapper.go`. Envoy's default log
// level IS info, so a gateway running this plugin printed the FULL GuardEvent —
// which carries the provider body raw, i.e. the user's prompt, the whole tool
// schema, the model's reply — plus the runtime's whole response, twice per model
// call, to stdout and from there into the container's json-file log.
//
// A customer found this in production on 3.8.0: their gateway log was their
// agent's conversations in plaintext.
//
// ⚠️ **`log_level` did not and could not gate it.** That setting (log.go) governs
// this plugin's own lines; the wrapper's are the SDK's, one layer down. The only
// lever was Envoy's `wasm` logger — an operator action, on every gateway, that also
// silences everything else the plugin says. A guardrail must not need a log-level
// workaround to stop being the leak.
//
// So the wrapper is gone from the request path. What remains here is the part of it
// that was actually doing work — assemble the pseudo-headers, dispatch, read the
// status back — and nothing that narrates. Everything this plugin says still goes
// through log.go, where the rule is one sentence and quiet means quiet.
//
// ⚠️ Do NOT reintroduce `wrapper.HttpClient` (or any `HttpCall` helper) for
// posting events. The convenience it offers is the URL parsing below; the price is
// putting the payload back in the log.

// ogrClient names an upstream the way Envoy needs it: a cluster to route to and an
// authority to present. It replaces `wrapper.HttpClient` (an interface, hence
// nil-able) with a value — the zero value is "no upstream configured", and a post
// against it fails the same way an unreachable runtime does, which is a path every
// caller already handles.
type ogrClient struct {
	cluster string
	host    string
}

// callResponse is what a caller wants back. ⚠️ Deliberately narrower than the
// wrapper's `ResponseCallback`: no `http.Header`. Every call site ignored the
// headers (`func(status int, _ http.Header, body []byte)`), so building the map cost
// an allocation per evaluate to be discarded. If a future response header ever
// matters — a rate-limit hint, say — widen this then, not before.
type callResponse func(status int, body []byte)

// callHeaders assembles what Envoy requires on a dispatched call: the caller's own
// headers, then `:method` / `:path` / `:authority`.
//
// ⚠️ A pseudo-header from a CALLER is dropped, not appended alongside ours — the
// wrapper did the same, and for a better reason than tidiness: two `:path` entries
// is a malformed callout, and whether the host rejects it or picks one is not
// something this plugin should be betting an event on. There is exactly one path
// for a call, and it is the one passed in.
//
// ⚠️ `unknownhost` rather than "" when no host is configured: an empty `:authority`
// is rejected by the host before the call leaves, which surfaces as a dispatch error
// with no hint of the cause. A bogus authority reaches the runtime and comes back a
// readable 404/421 — same behaviour as the wrapper, kept on purpose.
func callHeaders(host, path string, extra [][2]string) [][2]string {
	if host == "" {
		host = "unknownhost"
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	h := make([][2]string, 0, len(extra)+3)
	for _, kv := range extra {
		if strings.HasPrefix(kv[0], ":") {
			continue
		}
		h = append(h, kv)
	}
	return append(h,
		[2]string{":method", "POST"},
		[2]string{":path", path},
		[2]string{":authority", host},
	)
}

// callStatus reads `:status` off a response. Anything missing or unparsable is 502 —
// the wrapper's default, and the right one: "the call came back but not from
// something speaking HTTP" is a bad gateway, and every caller treats non-200 as
// "no verdict", which is what a caller must do with a response it cannot read.
func callStatus(headers [][2]string) int {
	for _, h := range headers {
		if h[0] == ":status" {
			n := 0
			for i := 0; i < len(h[1]); i++ {
				c := h[1][i]
				if c < '0' || c > '9' {
					return 502
				}
				n = n*10 + int(c-'0')
			}
			if n == 0 {
				return 502
			}
			return n
		}
	}
	return 502
}

// post sends one JSON body to the runtime and calls back when it answers.
//
// The returned error means the call NEVER LEFT — no cluster, no capacity, a host
// that would not take it. That is the distinction every caller depends on: an error
// here means nothing was judged (fail-open or fail-closed decides what happens
// next), while a callback with a non-200 means the runtime answered and declined.
func (c ogrClient) post(path string, headers [][2]string, body []byte, timeoutMs uint32, cb callResponse) error {
	_, err := proxywasm.DispatchHttpCall(c.cluster, callHeaders(c.host, path, headers), body, nil, timeoutMs,
		func(_, bodySize, _ int) {
			var respBody []byte
			if bodySize > 0 {
				// ⚠️ An unreadable body is not a failure to report: the status still
				// says what happened, and a caller that needs the body treats empty
				// as "no verdict" already. Logging here would be one line per
				// evaluate — the thing this file exists to stop.
				respBody, _ = proxywasm.GetHttpCallResponseBody(0, bodySize)
			}
			status := 502
			if h, err := proxywasm.GetHttpCallResponseHeaders(); err == nil {
				status = callStatus(h)
			}
			cb(status, respBody)
		})
	return err
}
