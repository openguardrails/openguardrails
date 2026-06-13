/**
 * National-team Elo ratings from eloratings.net, with a bundled offline snapshot.
 *
 * Live endpoints (community-known TSV exports, verified reachable with curl on
 * 2026-06-12):
 *   - https://www.eloratings.net/World.tsv     → tab-separated ranking table;
 *     column 2 (0-based 1) = rank, column 3 (0-based 2) = team code,
 *     column 4 (0-based 3) = current rating.
 *   - https://www.eloratings.net/en.teams.tsv  → code → display name(s)
 *     (first name is canonical; `_loc`-suffixed codes are locative variants).
 *
 * Fallback: data/elo-snapshot.json — frozen from the SAME live endpoints on the
 * date in its `sourcedAt` field (244 rated teams). If both the live fetch and
 * the snapshot fail, getEloTable() returns an empty table and callers degrade
 * to a market-only prior (never invented numbers).
 */

import { readFile } from "node:fs/promises";

export interface EloTeam {
  /** eloratings.net team code, e.g. "ES", "KR", "CW". */
  code: string;
  name: string;
  elo: number;
  rank: number;
}

export interface EloTable {
  /** Where the ratings came from: live URL or the bundled snapshot path. */
  source: string;
  /** When the ratings were produced (live: now; snapshot: its sourcedAt). */
  sourcedAt: string;
  /** Keyed by eloratings.net team code. */
  teams: Map<string, EloTeam>;
}

export const ELO_WORLD_TSV = "https://www.eloratings.net/World.tsv";
export const ELO_TEAMS_TSV = "https://www.eloratings.net/en.teams.tsv";
const SNAPSHOT_URL = new URL("../../data/elo-snapshot.json", import.meta.url);

/**
 * Slug-code ↔ Elo mapping for the 48 World Cup 2026 teams.
 *
 * Derived from REAL Gamma event data on 2026-06-12: all `fifwc-<home>-<away>-<date>`
 * event slugs were fetched (tag id 102232) and each code was joined positionally
 * with the event title ("Home vs. Away"); zero conflicts across 104 match events.
 * The Elo code comes from joining that name against en.teams.tsv (with aliases:
 * "Korea Republic"→"South Korea", "Türkiye"→"Turkey", "Côte d'Ivoire"→"Ivory Coast",
 * "Cabo Verde"→"Cape Verde", "IR Iran"→"Iran", "Bosnia-Herzegovina"→"Bosnia and
 * Herzegovina").
 *
 * ⚠ Polymarket's slug codes are NOT FIFA codes. Verified surprises:
 *   - `kor` = Curaçao (e.g. fifwc-ecu-kor-2026-06-20 "Ecuador vs. Curaçao")
 *   - `kr`  = Korea Republic (e.g. fifwc-mex-kr-2026-06-18 "Mexico vs. Korea Republic")
 * Teams not in this table simply skip the Elo prior (market-only fallback).
 */
export const TEAMS: Record<string, { name: string; eloCode: string }> = {
  alg: { name: "Algeria", eloCode: "DZ" },
  arg: { name: "Argentina", eloCode: "AR" },
  aus: { name: "Australia", eloCode: "AU" },
  aut: { name: "Austria", eloCode: "AT" },
  bel: { name: "Belgium", eloCode: "BE" },
  bih: { name: "Bosnia-Herzegovina", eloCode: "BA" },
  bra: { name: "Brazil", eloCode: "BR" },
  can: { name: "Canada", eloCode: "CA" },
  cdr: { name: "DR Congo", eloCode: "CD" },
  che: { name: "Switzerland", eloCode: "CH" },
  civ: { name: "Côte d'Ivoire", eloCode: "CI" },
  col: { name: "Colombia", eloCode: "CO" },
  cvi: { name: "Cabo Verde", eloCode: "CV" },
  cze: { name: "Czechia", eloCode: "CZ" },
  ecu: { name: "Ecuador", eloCode: "EC" },
  egy: { name: "Egypt", eloCode: "EG" },
  eng: { name: "England", eloCode: "EN" },
  esp: { name: "Spain", eloCode: "ES" },
  fra: { name: "France", eloCode: "FR" },
  ger: { name: "Germany", eloCode: "DE" },
  gha: { name: "Ghana", eloCode: "GH" },
  hai: { name: "Haiti", eloCode: "HT" },
  hrv: { name: "Croatia", eloCode: "HR" },
  irn: { name: "IR Iran", eloCode: "IR" },
  irq: { name: "Iraq", eloCode: "IQ" },
  jor: { name: "Jordan", eloCode: "JO" },
  jpn: { name: "Japan", eloCode: "JP" },
  kor: { name: "Curaçao", eloCode: "CW" },
  kr: { name: "Korea Republic", eloCode: "KR" },
  ksa: { name: "Saudi Arabia", eloCode: "SA" },
  mar: { name: "Morocco", eloCode: "MA" },
  mex: { name: "Mexico", eloCode: "MX" },
  nld: { name: "Netherlands", eloCode: "NL" },
  nor: { name: "Norway", eloCode: "NO" },
  nzl: { name: "New Zealand", eloCode: "NZ" },
  pan: { name: "Panama", eloCode: "PA" },
  par: { name: "Paraguay", eloCode: "PY" },
  prt: { name: "Portugal", eloCode: "PT" },
  qat: { name: "Qatar", eloCode: "QA" },
  rsa: { name: "South Africa", eloCode: "ZA" },
  sco: { name: "Scotland", eloCode: "SQ" },
  sen: { name: "Senegal", eloCode: "SN" },
  swe: { name: "Sweden", eloCode: "SE" },
  tun: { name: "Tunisia", eloCode: "TN" },
  tur: { name: "Türkiye", eloCode: "TR" },
  ury: { name: "Uruguay", eloCode: "UY" },
  usa: { name: "United States", eloCode: "US" },
  uzb: { name: "Uzbekistan", eloCode: "UZ" },
};

/** WC 2026 host nations (slug codes) — the only non-neutral venues. */
export const WC_HOSTS: ReadonlySet<string> = new Set(["usa", "can", "mex"]);

/** Display name for a Polymarket slug code (falls back to the code itself). */
export function teamName(slugCode: string): string {
  return TEAMS[slugCode]?.name ?? slugCode.toUpperCase();
}

function parseWorldTsv(worldTsv: string, namesTsv: string): Map<string, EloTeam> {
  const names = new Map<string, string>();
  for (const line of namesTsv.split("\n")) {
    const parts = line.split("\t");
    const code = parts[0];
    const name = parts[1];
    if (!code || !name || code.endsWith("_loc")) continue;
    names.set(code, name);
  }
  const teams = new Map<string, EloTeam>();
  for (const line of worldTsv.split("\n")) {
    const parts = line.split("\t");
    const rank = Number(parts[1]);
    const code = parts[2];
    const elo = Number(parts[3]);
    if (!code || !Number.isFinite(rank) || !Number.isFinite(elo)) continue;
    teams.set(code, { code, name: names.get(code) ?? code, elo, rank });
  }
  return teams;
}

async function loadSnapshot(): Promise<EloTable> {
  const raw = JSON.parse(await readFile(SNAPSHOT_URL, "utf8")) as {
    source: string;
    sourcedAt: string;
    teams: EloTeam[];
  };
  const teams = new Map<string, EloTeam>();
  for (const t of raw.teams ?? []) teams.set(t.code, t);
  return { source: `snapshot (${raw.source})`, sourcedAt: raw.sourcedAt, teams };
}

/**
 * Load Elo ratings: live first (5s timeout), bundled snapshot on failure,
 * empty table as last resort (callers must degrade to market-only priors).
 */
export async function getEloTable(fetchImpl: typeof fetch = fetch): Promise<EloTable> {
  try {
    const opts = { signal: AbortSignal.timeout(5000) };
    const [worldRes, namesRes] = await Promise.all([
      fetchImpl(ELO_WORLD_TSV, opts),
      fetchImpl(ELO_TEAMS_TSV, opts),
    ]);
    if (!worldRes.ok || !namesRes.ok) {
      throw new Error(`HTTP ${worldRes.status}/${namesRes.status}`);
    }
    const teams = parseWorldTsv(await worldRes.text(), await namesRes.text());
    if (teams.size === 0) throw new Error("live TSV parsed to zero teams");
    return { source: ELO_WORLD_TSV, sourcedAt: new Date().toISOString(), teams };
  } catch {
    try {
      return await loadSnapshot();
    } catch {
      return { source: "none", sourcedAt: new Date().toISOString(), teams: new Map() };
    }
  }
}

/** Elo rating for a Polymarket slug code, or undefined if unmapped/unrated. */
export function eloForSlugCode(table: EloTable, slugCode: string): number | undefined {
  const mapping = TEAMS[slugCode];
  if (!mapping) return undefined;
  return table.teams.get(mapping.eloCode)?.elo;
}
