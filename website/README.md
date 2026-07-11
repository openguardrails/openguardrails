# openguardrails.com

The marketing site for OpenGuardrails — **the open standard & benchmark for AI
agent safety & security.** Next.js (App Router) static export, deployable by
nginx (matches the current host).

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # static HTML in ./out  →  rsync to the nginx web root
```

## Narrative

This site replaces the old "enterprise guardrail product" framing. OGR is now the
neutral protocol + the referee:

- **Hero** — the open standard; one protocol, one benchmark.
- **Problem** — `N×M×L×S` integration mess → `N+M+L+S`.
- **How it works** — three altitudes, one decision; provenance-first; safety + security.
- **Leaderboard** — the flip: OGR does not submit a detector, it runs the board
  that ranks LlamaGuard / Qwen3Guard / vendors. Numbers come from
  [`openguardrails-bench`](https://github.com/openguardrails/openguardrails/tree/main/benchmarks);
  edit `lib/leaderboard.ts`.
- **Proof** — the runnable [`openguardrails-poc`](https://github.com/openguardrails/openguardrails-poc) result.

## Deploy

`npm run build` emits a static `out/`. Point the existing nginx root at it (or
rsync). No server runtime required.

## Status

`v0.1`. Single-page homepage. Sub-pages (docs, vendors, conformance) to follow.
The legacy product/SDK links should move under a "Legacy / Product" group during
the transition (non-destructive pivot).
