# Local SDK patch

Base: github.com/higress-group/proxy-wasm-go-sdk
v0.0.0-20251103120604-77e9cce339d2 (commit 77e9cce339d2).
Production packages and their unit tests are copied unchanged, except as listed
below. Documentation, examples and the upstream gateway e2e harness are omitted.
Original LICENSE and NOTICE are retained.

`proxywasm/internal/abi_callback_l7.go`: ignore an HTTP response callback whose
callout has already been consumed. Higress integration fault tests reproduced a
late/duplicate response after a timeout: the upstream SDK panicked with `invalid
callout id`, permanently disabling the worker's Wasm VM. This bypassed evaluation
for later requests. Returning preserves exactly-once callback delivery and the
already-settled fail_mode decision, without changing failure handling priority.

`proxywasm/internal/duplicate_http_callback_test.go`: checks a duplicate cannot
replay a callback, change active context, or prevent a later request callback.

The root go.mod replace makes ordinary Go tests and Wasm builds use this patch.
Remove the replacement when an upstream Go 1.24 SDK incorporates the same fix.
Run the SDK tests with `make test-sdk` from the Higress plugin directory.

`proxywasm/internal/abi_enums.go`: normalized with gofmt for the repository formatting gate; no semantic change.
