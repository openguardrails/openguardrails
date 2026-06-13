import { describe, expect, it } from "vitest";
import { devig } from "../src/core/devig.js";

describe("devig", () => {
  it("normalizes prices to sum 1 and reports the overround", () => {
    // Real shape from fifwc-usa-par-2026-06-12 on 2026-06-12: 0.475 / 0.295 / 0.245.
    const { probs, overround } = devig({ home: 0.475, draw: 0.295, away: 0.245 });
    expect(probs.home + probs.draw + probs.away).toBeCloseTo(1, 10);
    expect(overround).toBeCloseTo(1.015, 10);
    expect(probs.home).toBeCloseTo(0.475 / 1.015, 10);
  });

  it("is a no-op (proportionally) when prices already sum to 1", () => {
    const { probs, overround } = devig({ home: 0.5, draw: 0.3, away: 0.2 });
    expect(overround).toBeCloseTo(1, 10);
    expect(probs.home).toBeCloseTo(0.5, 10);
    expect(probs.draw).toBeCloseTo(0.3, 10);
    expect(probs.away).toBeCloseTo(0.2, 10);
  });

  it("preserves ordering", () => {
    const { probs } = devig({ home: 0.6, draw: 0.25, away: 0.21 });
    expect(probs.home).toBeGreaterThan(probs.draw);
    expect(probs.draw).toBeGreaterThan(probs.away);
  });

  it("rejects prices outside (0,1)", () => {
    expect(() => devig({ home: 0, draw: 0.3, away: 0.2 })).toThrow(/home/);
    expect(() => devig({ home: 0.5, draw: 1, away: 0.2 })).toThrow(/draw/);
    expect(() => devig({ home: 0.5, draw: 0.3, away: Number.NaN })).toThrow(/away/);
  });
});
