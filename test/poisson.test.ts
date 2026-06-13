import { describe, expect, it } from "vitest";
import {
  expectedGoals,
  goalDiffFromWinExpectancy,
  matchProbs,
  poissonPmf,
  winExpectancy,
} from "../src/core/poisson.js";

describe("winExpectancy", () => {
  it("is 0.5 for equal ratings", () => {
    expect(winExpectancy(0)).toBeCloseTo(0.5, 10);
  });
  it("matches the Elo formula anchors", () => {
    expect(winExpectancy(400)).toBeCloseTo(10 / 11, 6); // 1/(1+10^-1)
    expect(winExpectancy(-400)).toBeCloseTo(1 / 11, 6);
  });
  it("is symmetric", () => {
    expect(winExpectancy(123) + winExpectancy(-123)).toBeCloseTo(1, 10);
  });
});

describe("goalDiffFromWinExpectancy", () => {
  it("maps We=0.5 to 0 goal difference", () => {
    expect(goalDiffFromWinExpectancy(0.5)).toBeCloseTo(0, 10);
  });
  it("maps We=0.76 to ~+1 goal (documented calibration anchor)", () => {
    expect(goalDiffFromWinExpectancy(0.76)).toBeGreaterThan(0.9);
    expect(goalDiffFromWinExpectancy(0.76)).toBeLessThan(1.1);
  });
});

describe("poissonPmf", () => {
  it("sums to ~1 over a generous support", () => {
    let sum = 0;
    for (let k = 0; k <= 30; k++) sum += poissonPmf(k, 2.6);
    expect(sum).toBeCloseTo(1, 6);
  });
  it("matches a hand value", () => {
    expect(poissonPmf(0, 1)).toBeCloseTo(Math.exp(-1), 10);
  });
});

describe("expectedGoals", () => {
  it("splits the 2.6 baseline evenly for equal teams", () => {
    const { lambdaHome, lambdaAway } = expectedGoals(0);
    expect(lambdaHome).toBeCloseTo(1.3, 6);
    expect(lambdaAway).toBeCloseTo(1.3, 6);
  });
  it("never returns a non-positive lambda even for absurd gaps", () => {
    const { lambdaAway } = expectedGoals(1500);
    expect(lambdaAway).toBeGreaterThan(0);
  });
});

describe("matchProbs", () => {
  it("gives ~equal win probs and a sane draw prob for a symmetric matchup", () => {
    const p = matchProbs(1800, 1800);
    expect(p.home).toBeCloseTo(p.away, 6);
    expect(p.draw).toBeGreaterThan(0.15);
    expect(p.draw).toBeLessThan(0.35);
    expect(p.home + p.draw + p.away).toBeCloseTo(1, 9);
  });

  it("makes a large Elo gap a strong favorite", () => {
    // Spain 2157 vs Qatar 1421 — a 736-point gap.
    const p = matchProbs(2157, 1421);
    expect(p.home).toBeGreaterThan(0.8);
    expect(p.away).toBeLessThan(0.05);
  });

  it("host advantage shifts probability toward the host", () => {
    const neutral = matchProbs(1726, 1834); // USA vs Paraguay, neutral
    const hosted = matchProbs(1726, 1834, true); // USA as WC host
    expect(hosted.home).toBeGreaterThan(neutral.home);
    expect(hosted.away).toBeLessThan(neutral.away);
  });

  it("host advantage on the away side mirrors", () => {
    const a = matchProbs(1911, 1726, false, true); // TUR vs USA, USA hosts
    const b = matchProbs(1911, 1726);
    expect(a.away).toBeGreaterThan(b.away);
  });
});
