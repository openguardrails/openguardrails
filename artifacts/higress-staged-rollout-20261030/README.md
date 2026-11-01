# Dual OGR v5 / AIRS Higress rollout validation

Executed on t4090 on 2026-10-30 (America/Los_Angeles), with both freshly built
connectors loaded into an isolated Higress container using the existing lab image
`higress-all-in-one:local-from-t4090`. Existing `ogr-higress` was not reconfigured
or restarted. Test container and mock service were stopped afterwards.

AIRS SHA256: `7caf10595214ef80a99ab00147b7eb26d14fb9a447c54c3e5594463b2e3d5b7c`.
Legacy SHA256: `4b12fec0fe3d830df678d8157000c902af1dda5e2bf41c3b1ffb28f4d3b3335c`.

## Behavior

Both plugins receive the same staged_rollout string. Membership is the union of
consumer, group, ungrouped, all_consumers and the og-airs beta flag. Legacy OGR
skips members; AIRS uses configured mode for members and observe for everyone
else. Membership is read from request headers and persists to the LLM reply.
All mock model replies omit beta/consumer/group headers.

## Results

- 24 sequential exchanges: 12 scenarios, each JSON and SSE. All passed.
- 20 concurrent exchanges: 10 members, 10 non-members. Legacy input/output calls
  were 10/10; AIRS evaluate calls were 40 (request + response for all exchanges).
- Delay probe: evaluate sleeps 1.2 seconds per call. Non-member JSON exchange
  returned in 0.043 seconds; member enforce exchange took 2.445 seconds.
  This verifies observe does not await verdicts, not a general performance benchmark.
- Local package/protocol tests and vendored SDK tests passed; WASM build passed.

Tests verify actual Higress/WASM lifecycle and API dispatch using deterministic
HTTP mocks, not real detector/model quality. SSE mock includes complete terminal
frames; mock verdict supplies response_policy.pii=off, required by the current
AIRS output-policy contract. An earlier incomplete mock verdict triggered the
plugin's fail-closed protection; no production fix was needed.

Legacy non-member SSE still has its pre-existing behavior: input detection and
placeholder restoration, no legacy output API call. AIRS observe reports both
request and streamed response for those exchanges.

## Reproduce

setup.py generates /tmp/og-dual-rollout-e2e/data. Copy the legacy WASM as
plugin.wasm and AIRS WASM as airs.wasm there. Run mock.py on host port 18090.
The isolated container mounts data at /data, binds 127.0.0.1:28484 to port 8080,
and reaches the mock at Docker bridge host 172.17.0.1:18090. AIRS priority is 210,
legacy priority is 200. Run test.py on t4090; results.json records dispatch paths.
