import { describe, expect, it } from "vitest";
import {
  computeEdge,
  decide,
  kellyFraction,
  takerFee,
  type DecisionConfig,
} from "../src/core/decision.js";

const cfg: DecisionConfig = { bankrollUsd: 100, kellyFraction: 0.25, edgeThreshold: 0.03 };

describe("takerFee", () => {
  it("peaks at 0.0075 (0.75%) at p=0.5 and vanishes at the extremes", () => {
    expect(takerFee(0.5)).toBeCloseTo(0.0075, 10);
    expect(takerFee(0.01)).toBeLessThan(0.001);
    expect(takerFee(0.99)).toBeLessThan(0.001);
  });
});

describe("computeEdge", () => {
  it("subtracts half-spread and fee from the raw gap", () => {
    // |0.6 - 0.5| - 0.02/2 - 0.03*0.6*0.4 = 0.1 - 0.01 - 0.0072 = 0.0828
    expect(computeEdge(0.6, 0.5, 0.02)).toBeCloseTo(0.0828, 6);
  });
  it("is symmetric in direction", () => {
    expect(computeEdge(0.4, 0.5, 0.02)).toBeCloseTo(computeEdge(0.6, 0.5, 0.02), 10);
  });
});

describe("kellyFraction", () => {
  it("is 0 with no edge and positive with edge", () => {
    expect(kellyFraction(0.5, 0.5)).toBe(0);
    expect(kellyFraction(0.6, 0.5)).toBeCloseTo(0.2, 10); // (0.6-0.5)/(0.5)
  });
});

describe("decide", () => {
  it("returns null below the edge threshold", () => {
    expect(decide({ marketSlug: "m", p: 0.51, marketMid: 0.5, spread: 0.02 }, cfg)).toBeNull();
  });

  it("buys YES when p > mid, with a sane fractional-Kelly stake", () => {
    const intent = decide({ marketSlug: "m", p: 0.6, marketMid: 0.5, spread: 0.02 }, cfg);
    expect(intent).not.toBeNull();
    expect(intent!.side).toBe("BUY_YES");
    expect(intent!.edge).toBeCloseTo(0.0828, 4);
    expect(intent!.stakeUsd).toBeGreaterThan(0);
    expect(intent!.stakeUsd).toBeLessThanOrEqual(15); // 15% of $100 cap
    expect(intent!.marketPrice).toBe(0.5);
  });

  it("buys NO when p < mid", () => {
    const intent = decide({ marketSlug: "m", p: 0.4, marketMid: 0.5, spread: 0.02 }, cfg);
    expect(intent!.side).toBe("BUY_NO");
  });

  it("caps the stake at 15% of bankroll", () => {
    const aggressive: DecisionConfig = { bankrollUsd: 100, kellyFraction: 1, edgeThreshold: 0.01 };
    const intent = decide({ marketSlug: "m", p: 0.9, marketMid: 0.5, spread: 0.02 }, aggressive);
    expect(intent!.stakeUsd).toBe(15);
  });

  it("rejects degenerate inputs", () => {
    expect(decide({ marketSlug: "m", p: 1.2, marketMid: 0.5, spread: 0.02 }, cfg)).toBeNull();
    expect(decide({ marketSlug: "m", p: 0.6, marketMid: 0, spread: 0.02 }, cfg)).toBeNull();
  });
});
