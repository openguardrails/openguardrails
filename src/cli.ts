#!/usr/bin/env node
/**
 * openthomas — open-source Bayesian trading worker (v0, World Cup 2026).
 *
 * Commands:
 *   scan                    upcoming WC matches with market-implied probs
 *   forecast <eventSlug>    full pipeline for one match → 3 Forecast JSONs + ledger
 *   register --name X       register with WorkPnP, print apiKey
 *   work [--loop]           poll WorkPnP open work, forecast, submit, ledger
 *   edge                    DRY-RUN table of TradeIntents (no orders, ever)
 *   calib [settle-sync]     calibration report / backfill settlements from Gamma
 *
 * v0 hard limits: no LLM calls, no private keys, no real orders.
 */

import { Command } from "commander";
import { getEloTable, type EloTable } from "./core/elo.js";
import {
  getEventBySlug,
  getMarketBySlug,
  listWcMatchEvents,
  midPrice,
  MONEYLINE_SLUG_RE,
  parseWcMatch,
  resolvedOutcome,
  type WcMatch,
} from "./core/gamma.js";
import { buildMatchForecasts, fmtProbs } from "./core/pipeline.js";
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
} from "./core/ledger.js";
import { decide, decisionConfig } from "./core/decision.js";
import { WorkPnpClient, WorkPnpError } from "./workpnp/client.js";
import type { Forecast, WorkItem } from "./core/types.js";

const program = new Command();

program
  .name("openthomas")
  .description("Open-source Bayesian trading worker for prediction markets (v0: WC 2026, dry-run only)")
  .version("0.1.0");

// ── helpers ──────────────────────────────────────────────────────────────────

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i] ?? c.length)).join("  ");
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

function fmtUsd(v: number | string | undefined): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "-";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
}

function pct(p: number | undefined): string {
  return p === undefined ? "-" : `${(p * 100).toFixed(1)}%`;
}

let eloTablePromise: Promise<EloTable> | undefined;
function eloTable(): Promise<EloTable> {
  eloTablePromise ??= getEloTable().then((t) => {
    console.error(`[elo] ${t.teams.size} teams from ${t.source} (sourced ${t.sourcedAt})`);
    return t;
  });
  return eloTablePromise;
}

function eventSlugOfMarket(marketSlug: string): string | undefined {
  const m = /^(fifwc-[a-z]+-[a-z]+-\d{4}-\d{2}-\d{2})-[a-z-]+$/.exec(marketSlug);
  return m?.[1];
}

async function loadMatch(eventSlug: string): Promise<WcMatch> {
  if (!MONEYLINE_SLUG_RE.test(eventSlug)) {
    throw new Error(`"${eventSlug}" is not a moneyline event slug (expected fifwc-<home>-<away>-<yyyy-mm-dd>)`);
  }
  const event = await getEventBySlug(eventSlug);
  if (!event) throw new Error(`event not found on Gamma: ${eventSlug}`);
  const match = parseWcMatch(event);
  if (!match) throw new Error(`event ${eventSlug} is missing its home/away/draw sub-markets`);
  return match;
}

function fail(err: unknown): never {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

// ── scan ─────────────────────────────────────────────────────────────────────

program
  .command("scan")
  .description("List upcoming World Cup matches with market-implied probabilities")
  .action(async () => {
    try {
      const events = await listWcMatchEvents({ closed: false });
      const matches = events
        .map(parseWcMatch)
        .filter((m): m is WcMatch => m !== undefined)
        .sort((a, b) => (a.gameStartTime ?? a.date).localeCompare(b.gameStartTime ?? b.date));
      const rows = matches.map((m) => [
        m.gameStartTime ? m.gameStartTime.slice(0, 16).replace("T", " ") : m.date,
        m.event.title,
        m.eventSlug,
        pct(midPrice(m.homeMarket)),
        pct(midPrice(m.drawMarket)),
        pct(midPrice(m.awayMarket)),
        fmtUsd(m.event.volume24hr),
        fmtUsd(m.event.liquidity),
      ]);
      console.log(table(["kickoff (UTC)", "match", "event slug", "home", "draw", "away", "vol 24h", "liquidity"], rows));
      console.log(`\n${matches.length} upcoming matches`);
    } catch (err) {
      fail(err);
    }
  });

// ── forecast ─────────────────────────────────────────────────────────────────

program
  .command("forecast")
  .argument("<eventSlug>", "Gamma event slug, e.g. fifwc-usa-par-2026-06-12")
  .description("Run the full pipeline for one match, print 3 Forecast JSONs, write the ledger")
  .action(async (eventSlug: string) => {
    try {
      const [match, elo] = await Promise.all([loadMatch(eventSlug), eloTable()]);
      const result = buildMatchForecasts(match, elo);
      console.error(`[model]  ${result.modelProbs ? fmtProbs(result.modelProbs) : "unavailable (no Elo) — market-only prior"}`);
      console.error(`[market] ${fmtProbs(result.marketProbs)}`);
      console.error(`[blend]  ${fmtProbs(result.blended)} (λ=${result.lambda}, ${result.method})`);
      for (const f of result.forecasts) {
        console.log(JSON.stringify(f, null, 2));
        await appendForecast(f);
      }
      console.error(`[ledger] 3 forecasts appended to ${ledgerDir()}/forecasts.jsonl`);
    } catch (err) {
      fail(err);
    }
  });

// ── register ─────────────────────────────────────────────────────────────────

program
  .command("register")
  .description("Register this worker with WorkPnP and print the apiKey (shown only once)")
  .requiredOption("--name <name>", "worker display name")
  .option("--wallet <address>", "payout wallet address")
  .option("--agent-kind <kind>", "agent kind label", "openthomas")
  .action(async (opts: { name: string; wallet?: string; agentKind: string }) => {
    try {
      const client = new WorkPnpClient();
      const res = await client.register({
        name: opts.name,
        agentKind: opts.agentKind,
        ...(opts.wallet ? { walletAddress: opts.wallet } : {}),
      });
      console.log(`workerId: ${res.workerId}`);
      console.log(`apiKey:   ${res.apiKey}`);
      console.log("\nThe apiKey is shown ONLY ONCE (the server stores a hash). Save it now:");
      console.log(`\n  export WORKPNP_API_KEY=${res.apiKey}\n`);
    } catch (err) {
      fail(err);
    }
  });

// ── work ─────────────────────────────────────────────────────────────────────

async function workOnce(client: WorkPnpClient): Promise<void> {
  const dir = ledgerDir();
  const state = await readState(dir);
  const items = await client.listOpenWork();
  const open = items.filter((w) => w.status === "open" && w.kind === "forecast");
  console.log(`[work] ${open.length} open forecast work items`);

  // Group sub-market work items by their parent event so we model each match once.
  const byEvent = new Map<string, WorkItem[]>();
  for (const w of open) {
    if (state.submittedWork[w.id]) continue; // already submitted (overwrite not needed in v0)
    if (Date.parse(w.closesAt) <= Date.now()) continue; // kickoff passed
    const ev = eventSlugOfMarket(w.marketSlug);
    if (!ev) {
      console.log(`[work] skip ${w.id}: cannot derive event slug from ${w.marketSlug}`);
      continue;
    }
    const list = byEvent.get(ev) ?? [];
    list.push(w);
    byEvent.set(ev, list);
  }
  if (byEvent.size === 0) {
    console.log("[work] nothing new to do");
    return;
  }

  const elo = await eloTable();
  for (const [eventSlug, workItems] of byEvent) {
    try {
      const match = await loadMatch(eventSlug);
      const workIds: Record<string, string> = {};
      for (const w of workItems) workIds[w.marketSlug] = w.id;
      const result = buildMatchForecasts(match, elo, { workIds });
      for (const w of workItems) {
        const forecast = result.forecasts.find((f) => f.marketSlug === w.marketSlug);
        if (!forecast) {
          console.log(`[work] skip ${w.id}: no sub-market ${w.marketSlug} in event ${eventSlug}`);
          continue;
        }
        try {
          const res = await client.submitForecast(w.id, forecast);
          await appendForecast(forecast, dir);
          await markSubmitted(w.id, dir);
          console.log(`[work] ${w.id} ${w.marketSlug} p=${forecast.p} → ${res.status} (${res.submissionId})`);
        } catch (err) {
          if (err instanceof WorkPnpError) {
            console.log(`[work] ${w.id} rejected: ${err.message}${err.reason ? ` (${err.reason})` : ""}`);
          } else {
            throw err;
          }
        }
      }
    } catch (err) {
      console.log(`[work] event ${eventSlug} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

program
  .command("work")
  .description("Poll WorkPnP for open forecast work, submit forecasts, write the ledger")
  .option("--loop", "keep polling forever", false)
  .option("--interval <seconds>", "seconds between polls in --loop mode", "600")
  .action(async (opts: { loop: boolean; interval: string }) => {
    const client = new WorkPnpClient();
    const intervalMs = Math.max(10, Number(opts.interval) || 600) * 1000;
    try {
      for (;;) {
        await workOnce(client);
        if (!opts.loop) break;
        console.log(`[work] sleeping ${intervalMs / 1000}s…`);
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    } catch (err) {
      fail(err);
    }
  });

// ── edge ─────────────────────────────────────────────────────────────────────

program
  .command("edge")
  .description("DRY-RUN edge/Kelly table for ledgered forecasts vs current market prices")
  .action(async () => {
    try {
      const cfg = decisionConfig();
      const latest = latestPerMarket(await readForecasts());
      if (latest.size === 0) {
        console.log("ledger is empty — run `openthomas forecast <eventSlug>` first");
        return;
      }
      const byEvent = new Map<string, Forecast[]>();
      for (const f of latest.values()) {
        const ev = eventSlugOfMarket(f.marketSlug);
        if (!ev) continue;
        const list = byEvent.get(ev) ?? [];
        list.push(f);
        byEvent.set(ev, list);
      }
      const rows: string[][] = [];
      for (const [eventSlug, forecasts] of byEvent) {
        const event = await getEventBySlug(eventSlug);
        if (!event || event.closed) continue;
        for (const f of forecasts) {
          const market = event.markets.find((m) => m.slug === f.marketSlug);
          if (!market || market.closed) continue;
          const mid = midPrice(market);
          if (mid === undefined) continue;
          const intent = decide(
            { marketSlug: f.marketSlug, p: f.p, marketMid: mid, spread: market.spread ?? 0.02 },
            cfg,
          );
          rows.push([
            f.marketSlug,
            f.tokenLabel,
            f.p.toFixed(4),
            mid.toFixed(3),
            intent ? intent.edge.toFixed(4) : "<thr",
            intent ? intent.side : "-",
            intent ? `$${intent.stakeUsd.toFixed(2)}` : "-",
          ]);
        }
      }
      console.log("DRY RUN — no orders placed. v0 has no execution path and no keys.\n");
      console.log(table(["market", "token", "our p", "mid", "edge", "side", "stake"], rows));
      console.log(
        `\nbankroll $${cfg.bankrollUsd}, kelly×${cfg.kellyFraction}, edge threshold ${cfg.edgeThreshold}, per-market cap 15%`,
      );
    } catch (err) {
      fail(err);
    }
  });

// ── calib (+ settle-sync) ────────────────────────────────────────────────────

const calib = program
  .command("calib")
  .description("Calibration report from the belief ledger (joined with settlements)")
  .action(async () => {
    try {
      const report = await calibrationReport();
      console.log(`forecasts:        ${report.forecastsTotal} (${report.marketsTotal} distinct markets)`);
      console.log(`scored:           ${report.scored}`);
      console.log(`overall Brier:    ${report.brier === undefined ? "n/a (no settlements — run `openthomas calib settle-sync`)" : report.brier.toFixed(4)}`);
      const rows = report.buckets.map((b) => [
        `${b.range[0].toFixed(1)}–${b.range[1].toFixed(1)}`,
        String(b.n),
        b.n ? b.meanPredicted.toFixed(3) : "-",
        b.n ? b.realized.toFixed(3) : "-",
      ]);
      console.log(`\n${table(["bucket", "n", "mean predicted", "realized"], rows)}`);
    } catch (err) {
      fail(err);
    }
  });

calib
  .command("settle-sync")
  .description("Pull resolutions from Gamma for ledgered markets and backfill settlements.jsonl")
  .action(async () => {
    try {
      const dir = ledgerDir();
      const latest = latestPerMarket(await readForecasts(dir));
      const settled = await readSettlements(dir);
      let added = 0;
      let pending = 0;
      let voided = 0;
      for (const slug of latest.keys()) {
        if (settled.has(slug)) continue;
        const market = await getMarketBySlug(slug);
        if (!market) {
          console.log(`[settle] ${slug}: not found on Gamma`);
          continue;
        }
        if (!market.closed) {
          pending++;
          continue;
        }
        const outcome = resolvedOutcome(market);
        if (outcome === undefined) {
          // Closed but not ~[1,0]/[0,1]: canceled / 50-50 → void, never scored.
          voided++;
          console.log(`[settle] ${slug}: closed but not decisively resolved (void)`);
          continue;
        }
        await appendSettlement(
          { marketSlug: slug, outcome, settledAt: new Date().toISOString(), source: "gamma" },
          dir,
        );
        added++;
        console.log(`[settle] ${slug}: outcome=${outcome}`);
      }
      console.log(`\nsettle-sync: ${added} added, ${pending} still open, ${voided} void, ${settled.size} already settled`);
    } catch (err) {
      fail(err);
    }
  });

program.parseAsync(process.argv);
