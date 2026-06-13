/**
 * Gamma API client (read-only) for Polymarket 2026 World Cup match markets.
 *
 * ── Discovery method (verified live with curl on 2026-06-12) ─────────────────
 * Base: https://gamma-api.polymarket.com
 *
 * 1. `GET /public-search?q=fifwc` → 0 results, and `GET /events?slug_contains=fifwc`
 *    is NOT supported (returns unrelated events). Dead ends.
 * 2. `GET /tags/slug/fifa-world-cup` → tag id 102232 ("FIFA World Cup").
 *    (`/tags/slug/world-cup` → id 519 also exists but is broader/older.)
 * 3. `GET /events?tag_id=102232&closed=false&limit=100&offset=N&order=startDate&ascending=true`
 *    → all WC events. Match moneyline events have slug `fifwc-<home>-<away>-<yyyy-mm-dd>`
 *    (e.g. fifwc-usa-par-2026-06-12). Sibling events to EXCLUDE share the prefix:
 *    `…-exact-score`, `…-halftime-result`, `…-more-markets`.
 * 4. Each moneyline event is negRisk with exactly 3 binary markets whose slugs are
 *    `<eventSlug>-<homeCode>`, `<eventSlug>-<awayCode>`, `<eventSlug>-draw`.
 *    Useful market fields: question, slug, conditionId, outcomePrices (JSON string!),
 *    clobTokenIds (JSON string), closed, negRisk, gameStartTime, endDate, volume24hr,
 *    liquidity, spread, bestBid, bestAsk, groupItemTitle (= YES token label).
 * 5. `GET /events?slug=<eventSlug>` → single event lookup (works for closed events too).
 * 6. `GET /markets?slug=<marketSlug>` → single market lookup, BUT it silently filters
 *    out closed markets by default; pass `closed=true` to find resolved ones
 *    (verified: fifwc-kr-cze-2026-06-11-kr returns [] without the flag, and the
 *    resolved market with outcomePrices ["1","0"] with it).
 *
 * Settlement rule (CONTRACT_v0.md §3): a market is decisively resolved when
 * closed === true and parsed outcomePrices are ~[1,0] or ~[0,1] (>=0.99 / <=0.01).
 * YES outcome = outcomePrices[0] >= 0.99 ? 1 : 0. Anything else (e.g. a 50/50
 * cancellation settlement) is treated as void / not scoreable.
 *
 * Rate limiting per contract §3: >=500ms between requests, exponential-backoff
 * retry, max 3 attempts.
 */

export const GAMMA_BASE = "https://gamma-api.polymarket.com";
/** Verified live on 2026-06-12 via GET /tags/slug/fifa-world-cup. */
export const WC_TAG_ID = "102232";

const MIN_INTERVAL_MS = 500;
const MAX_ATTEMPTS = 3;

export interface GammaMarket {
  id: string;
  question: string;
  slug: string;
  conditionId: string;
  /** JSON-encoded string, e.g. '["0.475", "0.525"]' — [P(YES), P(NO)]. */
  outcomePrices?: string;
  /** JSON-encoded string of the two CLOB token ids. */
  clobTokenIds?: string;
  closed: boolean;
  negRisk?: boolean;
  gameStartTime?: string;
  endDate?: string;
  volume24hr?: number;
  liquidity?: string | number;
  spread?: number;
  bestBid?: number;
  bestAsk?: number;
  groupItemTitle?: string;
  umaResolutionStatus?: string;
}

export interface GammaEvent {
  id: string;
  slug: string;
  title: string;
  closed: boolean;
  negRisk?: boolean;
  liquidity?: number;
  volume24hr?: number;
  endDate?: string;
  markets: GammaMarket[];
}

/** A parsed World Cup moneyline match: the event plus its three named sub-markets. */
export interface WcMatch {
  event: GammaEvent;
  eventSlug: string;
  homeCode: string;
  awayCode: string;
  /** Match date from the slug (yyyy-mm-dd). */
  date: string;
  /** Kickoff (Gamma gameStartTime of the sub-markets) if present. */
  gameStartTime: string | undefined;
  homeMarket: GammaMarket;
  awayMarket: GammaMarket;
  drawMarket: GammaMarket;
}

export const MONEYLINE_SLUG_RE = /^fifwc-([a-z]+)-([a-z]+)-(\d{4}-\d{2}-\d{2})$/;

type FetchLike = typeof fetch;

let lastRequestAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** GET JSON with >=500ms spacing and exponential backoff (3 attempts). */
export async function gammaGet<T>(path: string, fetchImpl: FetchLike = fetch): Promise<T> {
  const url = path.startsWith("http") ? path : `${GAMMA_BASE}${path}`;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    try {
      const res = await fetchImpl(url, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`Gamma ${res.status} for ${url}`);
      return (await res.json()) as T;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) await sleep(MIN_INTERVAL_MS * 2 ** attempt);
    }
  }
  throw new Error(`Gamma request failed after ${MAX_ATTEMPTS} attempts: ${String(lastErr)}`);
}

/**
 * List World Cup match moneyline events (slug fifwc-<home>-<away>-<date>),
 * excluding exact-score / halftime-result / more-markets siblings.
 */
export async function listWcMatchEvents(
  opts: { closed?: boolean; maxPages?: number } = {},
  fetchImpl: FetchLike = fetch,
): Promise<GammaEvent[]> {
  const { closed = false, maxPages = 5 } = opts;
  const out: GammaEvent[] = [];
  for (let page = 0; page < maxPages; page++) {
    const offset = page * 100;
    const batch = await gammaGet<GammaEvent[]>(
      `/events?tag_id=${WC_TAG_ID}&closed=${closed}&limit=100&offset=${offset}&order=startDate&ascending=true`,
      fetchImpl,
    );
    out.push(...batch.filter((e) => MONEYLINE_SLUG_RE.test(e.slug)));
    if (batch.length < 100) break;
  }
  return out;
}

/** Fetch a single event by slug (works for closed events too). */
export async function getEventBySlug(
  slug: string,
  fetchImpl: FetchLike = fetch,
): Promise<GammaEvent | undefined> {
  const events = await gammaGet<GammaEvent[]>(`/events?slug=${encodeURIComponent(slug)}`, fetchImpl);
  return events[0];
}

/**
 * Fetch a single market by slug. Gamma's /markets?slug= hides closed markets by
 * default, so we query open first and then retry with closed=true.
 */
export async function getMarketBySlug(
  slug: string,
  fetchImpl: FetchLike = fetch,
): Promise<GammaMarket | undefined> {
  const open = await gammaGet<GammaMarket[]>(`/markets?slug=${encodeURIComponent(slug)}`, fetchImpl);
  if (open[0]) return open[0];
  const done = await gammaGet<GammaMarket[]>(
    `/markets?slug=${encodeURIComponent(slug)}&closed=true`,
    fetchImpl,
  );
  return done[0];
}

/** Parse a moneyline event into home/away/draw sub-markets. Returns undefined if malformed. */
export function parseWcMatch(event: GammaEvent): WcMatch | undefined {
  const m = MONEYLINE_SLUG_RE.exec(event.slug);
  if (!m) return undefined;
  const [, homeCode, awayCode, date] = m;
  if (!homeCode || !awayCode || !date) return undefined;
  const bySuffix = (suffix: string): GammaMarket | undefined =>
    event.markets?.find((mk) => mk.slug === `${event.slug}-${suffix}`);
  const homeMarket = bySuffix(homeCode);
  const awayMarket = bySuffix(awayCode);
  const drawMarket = bySuffix("draw");
  if (!homeMarket || !awayMarket || !drawMarket) return undefined;
  return {
    event,
    eventSlug: event.slug,
    homeCode,
    awayCode,
    date,
    gameStartTime: normalizeGameStart(homeMarket.gameStartTime),
    homeMarket,
    awayMarket,
    drawMarket,
  };
}

/** Gamma serves gameStartTime as "2026-06-13 01:00:00+00"; normalize to ISO 8601. */
export function normalizeGameStart(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const iso = raw.includes("T") ? raw : raw.replace(" ", "T").replace(/\+00$/, "Z");
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/**
 * Mid price for YES. Prefer (bestBid+bestAsk)/2; fall back to outcomePrices[0]
 * (Gamma's last/mark price) when the book fields are absent.
 */
export function midPrice(market: GammaMarket): number | undefined {
  if (typeof market.bestBid === "number" && typeof market.bestAsk === "number") {
    return (market.bestBid + market.bestAsk) / 2;
  }
  const prices = parseOutcomePrices(market);
  return prices?.[0];
}

/** outcomePrices is a JSON string like '["0.475", "0.525"]'. */
export function parseOutcomePrices(market: GammaMarket): [number, number] | undefined {
  if (!market.outcomePrices) return undefined;
  try {
    const arr = JSON.parse(market.outcomePrices) as unknown;
    if (!Array.isArray(arr) || arr.length < 2) return undefined;
    const yes = Number(arr[0]);
    const no = Number(arr[1]);
    if (Number.isNaN(yes) || Number.isNaN(no)) return undefined;
    return [yes, no];
  } catch {
    return undefined;
  }
}

/**
 * Contract §3 settlement rule. Returns 1 (YES), 0 (NO), or undefined when the
 * market is not closed or not decisively resolved (e.g. canceled → ~50/50).
 */
export function resolvedOutcome(market: GammaMarket): 0 | 1 | undefined {
  if (!market.closed) return undefined;
  const prices = parseOutcomePrices(market);
  if (!prices) return undefined;
  const [yes, no] = prices;
  if (yes >= 0.99 && no <= 0.01) return 1;
  if (yes <= 0.01 && no >= 0.99) return 0;
  return undefined;
}
