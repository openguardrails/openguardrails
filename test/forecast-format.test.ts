/** Contract §1.1 validation rules. */
import { describe, expect, it } from "vitest";
import { clampP, validateForecast, type Forecast } from "../src/core/types.js";

function valid(): Forecast {
  return {
    schema: "openthomas/forecast@0.1",
    workId: "w_abc123",
    marketSlug: "fifwc-nld-jpn-2026-06-14-nld",
    tokenLabel: "Netherlands",
    p: 0.58,
    ci: [0.52, 0.64],
    prior: { value: 0.54, method: "elo_poisson+market_devig" },
    evidence: [{ source: "elo", claim: "NED 1948 vs JPN 1906", effect: "+0.04", url: "", ts: "2026-06-12T00:00:00Z" }],
    ts: "2026-06-12T10:00:00Z",
  };
}

describe("validateForecast (contract §1.1)", () => {
  it("accepts the contract example shape", () => {
    expect(validateForecast(valid())).toEqual([]);
  });

  it("rejects a wrong schema string", () => {
    expect(validateForecast({ ...valid(), schema: "openthomas/forecast@0.2" as never })).not.toEqual([]);
  });

  it("enforces 0 < p < 1 (open interval)", () => {
    expect(validateForecast({ ...valid(), p: 0 })).not.toEqual([]);
    expect(validateForecast({ ...valid(), p: 1 })).not.toEqual([]);
    expect(validateForecast({ ...valid(), p: -0.1 })).not.toEqual([]);
  });

  it("enforces at most 4 decimal places on p", () => {
    expect(validateForecast({ ...valid(), p: 0.12345 })).not.toEqual([]);
    expect(validateForecast({ ...valid(), p: 0.1234 })).toEqual([]);
  });

  it("rejects malformed ci and ts", () => {
    expect(validateForecast({ ...valid(), ci: [0.7, 0.2] })).not.toEqual([]);
    expect(validateForecast({ ...valid(), ts: "not-a-date" })).not.toEqual([]);
  });
});

describe("clampP", () => {
  it("rounds to 4 decimals and stays inside the open interval", () => {
    expect(clampP(0.123456)).toBe(0.1235);
    expect(clampP(0)).toBe(0.0001);
    expect(clampP(1)).toBe(0.9999);
    expect(clampP(0.99999)).toBe(0.9999);
  });
});
