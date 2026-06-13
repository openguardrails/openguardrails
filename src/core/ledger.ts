/**
 * Append-only belief ledger.
 *
 * Files live in LEDGER_DIR (default ~/.openthomas):
 *   - forecasts.jsonl    one Forecast JSON per line, append-only, never rewritten.
 *   - settlements.jsonl  one Settlement per line, keyed by marketSlug (last wins).
 *   - state.json         small local state: workIds already submitted to WorkPnP.
 *
 * Philosophy: every probability OpenThomas ever emitted stays on the record,
 * with its prior and evidence chain. Outcomes are back-filled separately so
 * the original belief is never edited — that's what makes calibration honest.
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Forecast } from "./types.js";

export interface Settlement {
  marketSlug: string;
  /** 1 = YES resolved true, 0 = NO. Void/canceled markets are never written. */
  outcome: 0 | 1;
  settledAt: string;
  source: string;
}

export interface CalibrationBucket {
  /** Inclusive lower bound, exclusive upper bound (last bucket inclusive). */
  range: [number, number];
  n: number;
  meanPredicted: number;
  realized: number;
}

export interface CalibrationReport {
  forecastsTotal: number;
  /** Distinct ledgered markets (latest forecast per marketSlug). */
  marketsTotal: number;
  scored: number;
  brier: number | undefined;
  buckets: CalibrationBucket[];
}

export function ledgerDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env["LEDGER_DIR"] ?? "~/.openthomas";
  return raw.startsWith("~") ? join(homedir(), raw.slice(1)) : raw;
}

async function appendLine(dir: string, file: string, obj: unknown): Promise<void> {
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, file), `${JSON.stringify(obj)}\n`, "utf8");
}

async function readLines<T>(dir: string, file: string): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(join(dir, file), "utf8");
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // Tolerate a torn final line (crash mid-append); never throw away the rest.
    }
  }
  return out;
}

export async function appendForecast(forecast: Forecast, dir = ledgerDir()): Promise<void> {
  await appendLine(dir, "forecasts.jsonl", forecast);
}

export async function readForecasts(dir = ledgerDir()): Promise<Forecast[]> {
  return readLines<Forecast>(dir, "forecasts.jsonl");
}

export async function appendSettlement(s: Settlement, dir = ledgerDir()): Promise<void> {
  await appendLine(dir, "settlements.jsonl", s);
}

/** Settlements keyed by marketSlug; later lines override earlier ones. */
export async function readSettlements(dir = ledgerDir()): Promise<Map<string, Settlement>> {
  const map = new Map<string, Settlement>();
  for (const s of await readLines<Settlement>(dir, "settlements.jsonl")) {
    if (s.marketSlug) map.set(s.marketSlug, s);
  }
  return map;
}

/** Latest forecast per marketSlug (a later submission supersedes, per contract §1.2). */
export function latestPerMarket(forecasts: Forecast[]): Map<string, Forecast> {
  const map = new Map<string, Forecast>();
  for (const f of forecasts) map.set(f.marketSlug, f);
  return map;
}

interface LocalState {
  /** workId → ISO ts of last successful WorkPnP submission. */
  submittedWork: Record<string, string>;
}

export async function readState(dir = ledgerDir()): Promise<LocalState> {
  try {
    const raw = await readFile(join(dir, "state.json"), "utf8");
    const parsed = JSON.parse(raw) as Partial<LocalState>;
    return { submittedWork: parsed.submittedWork ?? {} };
  } catch {
    return { submittedWork: {} };
  }
}

export async function markSubmitted(workId: string, dir = ledgerDir()): Promise<void> {
  const state = await readState(dir);
  state.submittedWork[workId] = new Date().toISOString();
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "state.json"), JSON.stringify(state, null, 2), "utf8");
}

/**
 * Calibration report: joins the latest forecast per market against settlements.
 * Brier = mean (p − outcome)²; buckets are deciles of predicted p with the
 * realized YES frequency for comparison.
 */
export async function calibrationReport(dir = ledgerDir()): Promise<CalibrationReport> {
  const forecasts = await readForecasts(dir);
  const latest = latestPerMarket(forecasts);
  const settlements = await readSettlements(dir);

  const edges = Array.from({ length: 10 }, (_, i) => i / 10);
  const acc = edges.map(() => ({ n: 0, sumP: 0, sumOutcome: 0 }));
  let scored = 0;
  let brierSum = 0;

  for (const [slug, f] of latest) {
    const s = settlements.get(slug);
    if (!s) continue;
    scored++;
    brierSum += (f.p - s.outcome) ** 2;
    const idx = Math.min(9, Math.floor(f.p * 10));
    const bucket = acc[idx];
    if (bucket) {
      bucket.n++;
      bucket.sumP += f.p;
      bucket.sumOutcome += s.outcome;
    }
  }

  return {
    forecastsTotal: forecasts.length,
    marketsTotal: latest.size,
    scored,
    brier: scored > 0 ? brierSum / scored : undefined,
    buckets: acc.map((b, i) => ({
      range: [i / 10, (i + 1) / 10] as [number, number],
      n: b.n,
      meanPredicted: b.n > 0 ? b.sumP / b.n : 0,
      realized: b.n > 0 ? b.sumOutcome / b.n : 0,
    })),
  };
}
