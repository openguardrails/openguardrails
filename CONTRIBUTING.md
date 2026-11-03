# Contributing

This repository holds the `openguardrails` command in [`cli/`](cli/), the public benchmark in
[`benchmarks/`](benchmarks/), and the Higress plugin in
[`integrations/gateway/higress/`](integrations/gateway/higress/).

## How to propose a change

1. Open an issue before a large change.
2. Submit a pull request scoped to the smallest relevant directory, with a `CHANGELOG.md` entry when
   behavior changes.
3. Run the checks for what you touched:
   - the command: `cd cli && npm install && npm test`
   - the benchmark: `python -m pip install pytest && python -m pytest`
   - the Higress plugin: `cd integrations/gateway/higress && gofmt -l . && go vet ./... && go test ./...`

## Benchmark submissions

A detector that wants to appear on the leaderboard runs through the harness in
[`benchmarks/`](benchmarks/). We never fabricate a vendor's score: numbers come from the harness or they
do not appear. A change that advantages one detector over others is out of scope.

## Licensing

By contributing you agree your contribution is licensed under Apache-2.0.
