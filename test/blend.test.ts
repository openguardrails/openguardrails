import { afterEach, describe, expect, it } from "vitest";
import { blend, DEFAULT_MARKET_BLEND, marketBlendLambda } from "../src/core/blend.js";

describe("blend", () => {
  const model = { home: 0.6, draw: 0.25, away: 0.15 };
  const market = { home: 0.4, draw: 0.3, away: 0.3 };

  it("λ=0 returns the model, λ=1 returns the market", () => {
    expect(blend(model, market, 0)).toEqual(model);
    expect(blend(model, market, 1)).toEqual(market);
  });

  it("λ=0.3 is the documented convex combination", () => {
    const out = blend(model, market, 0.3);
    expect(out.home).toBeCloseTo(0.7 * 0.6 + 0.3 * 0.4, 10);
    expect(out.draw).toBeCloseTo(0.7 * 0.25 + 0.3 * 0.3, 10);
    expect(out.home + out.draw + out.away).toBeCloseTo(1, 10);
  });

  it("degrades to the market prior when the model is unavailable", () => {
    expect(blend(undefined, market, 0.3)).toEqual(market);
  });

  it("clamps out-of-range lambda", () => {
    expect(blend(model, market, -5)).toEqual(model);
    expect(blend(model, market, 7).home).toBeCloseTo(market.home, 10);
  });
});

describe("marketBlendLambda", () => {
  it("defaults to 0.3", () => {
    expect(marketBlendLambda({})).toBe(DEFAULT_MARKET_BLEND);
  });
  it("reads MARKET_BLEND and clamps to [0,1]", () => {
    expect(marketBlendLambda({ MARKET_BLEND: "0.5" })).toBe(0.5);
    expect(marketBlendLambda({ MARKET_BLEND: "3" })).toBe(1);
    expect(marketBlendLambda({ MARKET_BLEND: "-1" })).toBe(0);
    expect(marketBlendLambda({ MARKET_BLEND: "garbage" })).toBe(DEFAULT_MARKET_BLEND);
  });
});
