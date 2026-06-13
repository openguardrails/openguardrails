import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendForecast,
  appendSettlement,
  calibrationReport,
  latestPerMarket,
  ledgerDir,
  markSubmitted,
  readForecasts,
  readSettlements,
  readState,
} from "../src/core/ledger.js";
import type { Forecast } from "../src/core/types.js";

function forecast(marketSlug: string, p: number, workId = `w_${marketSlug}`): Forecast {
  return {
    schema: "openthomas/forecast@0.1",
    workId,
    marketSlug,
    tokenLabel: "T",
    p,
    prior: { value: p, method: "elo_poisson+market_devig" },
    ts: new Date().toISOString(),
  };
}

describe("ledger round-trip", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "openthomas-ledger-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("appends and reads forecasts in order, byte-for-byte JSON round-trip", async () => {
    const a = forecast("fifwc-usa-par-2026-06-12-usa", 0.47);
    const b = forecast("fifwc-usa-par-2026-06-12-par", 0.25);
    await appendForecast(a, dir);
    await appendForecast(b, dir);
    const back = await readForecasts(dir);
    expect(back).toEqual([a, b]);
  });

  it("latestPerMarket keeps only the last forecast per marketSlug", async () => {
    await appendForecast(forecast("m1", 0.4), dir);
    await appendForecast(forecast("m1", 0.55), dir);
    const latest = latestPerMarket(await readForecasts(dir));
    expect(latest.size).toBe(1);
    expect(latest.get("m1")?.p).toBe(0.55);
  });

  it("settlements round-trip keyed by marketSlug, last wins", async () => {
    await appendSettlement({ marketSlug: "m1", outcome: 0, settledAt: "t1", source: "gamma" }, dir);
    await appendSettlement({ marketSlug: "m1", outcome: 1, settledAt: "t2", source: "gamma" }, dir);
    const s = await readSettlements(dir);
    expect(s.get("m1")?.outcome).toBe(1);
  });

  it("computes Brier and calibration buckets from the join", async () => {
    await appendForecast(forecast("won", 0.8), dir);
    await appendForecast(forecast("lost", 0.3), dir);
    await appendForecast(forecast("open-market", 0.5), dir); // no settlement → unscored
    await appendSettlement({ marketSlug: "won", outcome: 1, settledAt: "t", source: "gamma" }, dir);
    await appendSettlement({ marketSlug: "lost", outcome: 0, settledAt: "t", source: "gamma" }, dir);

    const report = await calibrationReport(dir);
    expect(report.forecastsTotal).toBe(3);
    expect(report.marketsTotal).toBe(3);
    expect(report.scored).toBe(2);
    // Brier = ((0.8-1)^2 + (0.3-0)^2) / 2 = (0.04 + 0.09)/2 = 0.065
    expect(report.brier).toBeCloseTo(0.065, 10);
    const b8 = report.buckets[8]!; // 0.8–0.9
    expect(b8.n).toBe(1);
    expect(b8.realized).toBe(1);
    const b3 = report.buckets[3]!; // 0.3–0.4
    expect(b3.n).toBe(1);
    expect(b3.realized).toBe(0);
  });

  it("tracks submitted work ids in local state", async () => {
    expect((await readState(dir)).submittedWork).toEqual({});
    await markSubmitted("w_1", dir);
    await markSubmitted("w_2", dir);
    const state = await readState(dir);
    expect(Object.keys(state.submittedWork).sort()).toEqual(["w_1", "w_2"]);
  });

  it("survives a torn final line without losing earlier entries", async () => {
    await appendForecast(forecast("m1", 0.5), dir);
    const { appendFile } = await import("node:fs/promises");
    await appendFile(join(dir, "forecasts.jsonl"), '{"schema":"openthomas/fore', "utf8");
    const back = await readForecasts(dir);
    expect(back).toHaveLength(1);
  });

  it("expands ~ in LEDGER_DIR", () => {
    const d = ledgerDir({ LEDGER_DIR: "~/.openthomas-test" });
    expect(d.startsWith("/")).toBe(true);
    expect(d.endsWith("/.openthomas-test")).toBe(true);
  });
});
