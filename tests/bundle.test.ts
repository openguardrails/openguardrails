// Pure picker tests for decideBundle. Cloud-side cycling integration is
// covered separately in tests/cloud-decide.test.ts.

import { describe, expect, it } from "bun:test";

import { ZERO_LEG_USAGE, decideBundle, legKey, legUsageFromRuns } from "../src/policy/bundle.js";
import type { BundlePolicy } from "../src/policy/types.js";
import type { RunRecord } from "../src/runs/types.js";

function bundle(legs: BundlePolicy["legs"]): BundlePolicy {
  return { id: "bundle", legs };
}

function record(overrides: Partial<RunRecord>): RunRecord {
  return {
    runId: "r",
    agent: "claude-code",
    startedAt: "2026-05-08T00:00:00Z",
    endedAt: "2026-05-08T00:00:00Z",
    durationMs: 0,
    status: "ok",
    inboundProtocol: "anthropic",
    outboundProvider: "openai",
    outboundModel: "gpt-4o",
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    streamed: false,
    httpStatus: 200,
    errorMessage: null,
    failovers: 0,
    failoverNote: null,
    ...overrides,
  };
}

describe("decideBundle — leg picker", () => {
  it("picks the head leg when no usage", () => {
    const b = bundle([
      { target: { provider: "openai", model: "gpt-4o" }, priority: 0, capUsdPerDay: 5 },
      { target: { provider: "deepseek", model: "deepseek-chat" }, priority: 1, capUsdPerDay: 5 },
    ]);
    const result = decideBundle(b, new Map());
    expect(result.target).toEqual({ provider: "openai", model: "gpt-4o" });
    expect(result.legIndex).toBe(0);
  });

  it("advances past a spend-exhausted leg", () => {
    const b = bundle([
      { target: { provider: "openai", model: "gpt-4o" }, priority: 0, capUsdPerDay: 5 },
      { target: { provider: "deepseek", model: "deepseek-chat" }, priority: 1, capUsdPerDay: 5 },
    ]);
    const usage = new Map([[legKey("openai", "gpt-4o"), { calls: 100, spend: 5.5 }]]);
    const result = decideBundle(b, usage);
    expect(result.target).toEqual({ provider: "deepseek", model: "deepseek-chat" });
    expect(result.legIndex).toBe(1);
    expect(result.reason).toContain("deepseek/deepseek-chat");
  });

  it("advances past a calls-exhausted leg", () => {
    const b = bundle([
      { target: { provider: "openai", model: "gpt-4o" }, priority: 0, capCallsPerDay: 10 },
      { target: { provider: "kimi", model: "kimi-k2" }, priority: 1, capCallsPerDay: 100 },
    ]);
    const usage = new Map([[legKey("openai", "gpt-4o"), { calls: 10, spend: 0 }]]);
    const result = decideBundle(b, usage);
    expect(result.target).toEqual({ provider: "kimi", model: "kimi-k2" });
    expect(result.legIndex).toBe(1);
  });

  it("does not exhaust a leg when its spend is unknown (subscription2api)", () => {
    // capUsdPerDay set, but legSpend=null (e.g. subscription provider with no
    // priced runs). The dollar cap can't be evaluated honestly — stay on the
    // leg unless a calls cap also exists and trips.
    const b = bundle([
      { target: { provider: "claude-sub", model: "claude" }, priority: 0, capUsdPerDay: 5 },
      { target: { provider: "openai", model: "gpt-4o" }, priority: 1 },
    ]);
    const usage = new Map([[legKey("claude-sub", "claude"), { calls: 50, spend: null }]]);
    const result = decideBundle(b, usage);
    expect(result.target).toEqual({ provider: "claude-sub", model: "claude" });
    expect(result.legIndex).toBe(0);
  });

  it("calls cap still trips with null spend", () => {
    const b = bundle([
      {
        target: { provider: "claude-sub", model: "claude" },
        priority: 0,
        capUsdPerDay: 5,
        capCallsPerDay: 50,
      },
      { target: { provider: "openai", model: "gpt-4o" }, priority: 1 },
    ]);
    const usage = new Map([[legKey("claude-sub", "claude"), { calls: 50, spend: null }]]);
    const result = decideBundle(b, usage);
    expect(result.legIndex).toBe(1);
  });

  it("sticks on the tail when all legs are exhausted", () => {
    const b = bundle([
      { target: { provider: "openai", model: "gpt-4o" }, priority: 0, capUsdPerDay: 5 },
      { target: { provider: "deepseek", model: "deepseek-chat" }, priority: 1, capUsdPerDay: 5 },
    ]);
    const usage = new Map([
      [legKey("openai", "gpt-4o"), { calls: 0, spend: 6 }],
      [legKey("deepseek", "deepseek-chat"), { calls: 0, spend: 6 }],
    ]);
    const result = decideBundle(b, usage);
    expect(result.target).toEqual({ provider: "deepseek", model: "deepseek-chat" });
    expect(result.legIndex).toBe(1);
    expect(result.reason).toContain("all 2 bundle legs exhausted");
  });

  it("throws on empty legs (caller must guard)", () => {
    expect(() => decideBundle({ id: "bundle", legs: [] }, new Map())).toThrow();
  });
});

describe("legUsageFromRuns — aggregation", () => {
  it("groups runs by (provider, model) and sums calls + cost", () => {
    const usage = legUsageFromRuns([
      record({ outboundProvider: "openai", outboundModel: "gpt-4o", cost: 0.1 }),
      record({ outboundProvider: "openai", outboundModel: "gpt-4o", cost: 0.2 }),
      record({ outboundProvider: "deepseek", outboundModel: "deepseek-chat", cost: 0.05 }),
    ]);
    const openai = usage.get(legKey("openai", "gpt-4o"))!;
    expect(openai.calls).toBe(2);
    expect(openai.spend).toBeCloseTo(0.3, 6);
    const deepseek = usage.get(legKey("deepseek", "deepseek-chat"))!;
    expect(deepseek.calls).toBe(1);
    expect(deepseek.spend).toBeCloseTo(0.05, 6);
  });

  it("yields spend=null for a leg if any of its runs lacked pricing", () => {
    const usage = legUsageFromRuns([
      record({ outboundProvider: "openai", outboundModel: "gpt-4o", cost: 0.1 }),
      record({ outboundProvider: "openai", outboundModel: "gpt-4o", cost: null }),
    ]);
    expect(usage.get(legKey("openai", "gpt-4o"))).toEqual({ calls: 2, spend: null });
  });

  it("returns ZERO_LEG_USAGE-equivalent for unobserved legs (default in picker)", () => {
    const usage = legUsageFromRuns([]);
    expect(usage.size).toBe(0);
    // The picker substitutes ZERO_LEG_USAGE when get() returns undefined,
    // which keeps capped legs available until the first run.
    expect(ZERO_LEG_USAGE).toEqual({ calls: 0, spend: 0 });
  });
});
