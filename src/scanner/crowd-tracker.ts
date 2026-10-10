/**
 * Crowd tracker — how PEOPLE behave on a coin, not just its totals.
 *
 * Keeps a short, in-memory log of every trade (last 30 min, capped) for coins
 * that matter: bonding curve ≥ `focus.crowdLogFromCurvePct` or migrated. From
 * that log `computeCrowdMetrics` reads the crowd:
 *
 *   activeWallets5m  different wallets trading in the last 5 min — the closest
 *                    public measure of "eyes on the coin"
 *   newBuyers5m      wallets whose first trade we saw was a buy in the last 5 min
 *   dipBuyRatio      when the price is ≥8% under its recent high, how much of the
 *                    flow is buying (people buy dips = strong hands)
 *   paperHandsPct    buyers who dumped within 2 min of buying
 *   churnPct         volume from wallets flipping in and out (bots / wash trading)
 *   retailPct        buys of a normal human size (0.05–5 SOL)
 *   buyAccel         buys per minute now vs the minutes before (crowd growing?)
 *   buyRatio2m       buy SOL ÷ sell SOL over the last 2 minutes
 *   whaleSellPct     biggest single sell vs all buying in the last 5 min
 *
 * No Redis, no RPC: one array push per trade. Also tells the bot the moment a
 * coin enters the "Soon" zone (curve crosses `focus.soon.minCurvePct`).
 */
import { getConfig } from '../config/runtime-config';
import type { AmmTradeEvent, PumpTradeEvent } from '../config/types';
import { ammPostTradePrice, bondingCurvePct, PUMP_TOKEN_DECIMALS } from '../lib/pumpfun';
import { addToCandles, type Candle } from '../evaluator/chart-reader';

export interface CrowdTrade {
  /** ms */
  t: number;
  w: string;
  buy: boolean;
  sol: number;
  /** whole tokens */
  tok: number;
  /** SOL per whole token (from the trade's own amounts) */
  px: number;
  /** Pool price right after the trade (SOL per whole token) — what the next seller gets. Unknown = undefined. */
  pp?: number;
  /** Solana slot (0 = unknown) — same-slot buys reveal bundles. */
  s?: number;
}

export interface CrowdMetrics {
  trades5m: number;
  activeWallets5m: number;
  newBuyers5m: number;
  dipBuyRatio: number | null;
  paperHandsPct: number | null;
  churnPct: number;
  retailPct: number | null;
  buyAccel: number | null;
  buyRatio2m: number | null;
  whaleSellPct: number;
  /** Share of recent buyers the learner rates as proven winners (null = not looked up). */
  smartBuyerPct: number | null;
  /** Volume (10m) from wallets trading back and forth — wash trading / volume bots. */
  fakeVolumePct: number;
  /** Buy volume (10m) in same-slot groups of 3+ wallets with near-identical sizes — bundles. */
  bundledBuyPct: number;
  /** Volume (10m) made by the 3 biggest wallets. */
  top3VolumePct: number;
  /** Trades under 0.005 SOL (tx-count inflation bots). */
  dustTradePct: number;
  /** Price change over the last 3 minutes, % (null = no price 3 min ago). */
  priceChange3mPct: number | null;
  /** 0..1 summary of the above (0.5 = not enough data). */
  crowdScore: number;
  /** 0..1, full at `fullAttentionWallets` active wallets. */
  attentionScore: number;
  /** Short human summary for explanations. */
  summary: string;
}

const KEEP_MS = 25 * 60_000;
const MAX_TRADES = 400;
const clamp01 = (x: number) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);

/** Pure: read the crowd from a trade log (oldest → newest). */
export function computeCrowdMetrics(trades: readonly CrowdTrade[], now: number, opts: { fullAttentionWallets: number; smartBuyerPct?: number | null } = { fullAttentionWallets: 50 }): CrowdMetrics {
  const in5 = trades.filter((x) => now - x.t <= 5 * 60_000);
  const in2 = in5.filter((x) => now - x.t <= 2 * 60_000);
  const wallets5 = new Set(in5.map((x) => x.w));

  // First time we saw each wallet (whole log) → new buyers in the last 5 min.
  const firstSeen = new Map<string, CrowdTrade>();
  for (const x of trades) if (!firstSeen.has(x.w)) firstSeen.set(x.w, x);
  let newBuyers5m = 0;
  for (const [, x] of firstSeen) if (x.buy && now - x.t <= 5 * 60_000) newBuyers5m++;

  // Dip buying: flow while the price sits ≥8% under its 2-minute running high.
  let dipBuy = 0;
  let dipSell = 0;
  const window: CrowdTrade[] = [];
  for (const x of trades) {
    while (window.length && x.t - window[0]!.t > 2 * 60_000) window.shift();
    const high = window.reduce((m, y) => Math.max(m, y.px), 0);
    if (high > 0 && x.px > 0 && x.px <= high * 0.92 && now - x.t <= 10 * 60_000) {
      if (x.buy) dipBuy += x.sol;
      else dipSell += x.sol;
    }
    window.push(x);
  }
  const dipBuyRatio = dipBuy + dipSell >= 0.5 ? dipBuy / (dipBuy + dipSell) : null;

  // Paper hands + churn, per wallet over the last 10 minutes.
  const per = new Map<string, { buys: CrowdTrade[]; sells: CrowdTrade[]; vol: number }>();
  for (const x of trades) {
    if (now - x.t > 10 * 60_000) continue;
    const p = per.get(x.w) ?? { buys: [], sells: [], vol: 0 };
    (x.buy ? p.buys : p.sells).push(x);
    p.vol += x.sol;
    per.set(x.w, p);
  }
  let buyers = 0;
  let paper = 0;
  let churnVol = 0;
  let totVol = 0;
  for (const [, p] of per) {
    totVol += p.vol;
    if (p.buys.length && p.sells.length >= 1 && p.buys.length + p.sells.length >= 4) churnVol += p.vol;
    if (!p.buys.length) continue;
    buyers++;
    const first = p.buys[0]!;
    const bought = p.buys.reduce((s, b) => s + b.tok, 0);
    const soldFast = p.sells.filter((s) => s.t >= first.t && s.t - first.t <= 2 * 60_000).reduce((s, b) => s + b.tok, 0);
    if (bought > 0 && soldFast >= bought * 0.9) paper++;
  }
  const paperHandsPct = buyers >= 5 ? (paper / buyers) * 100 : null;
  const churnPct = totVol > 0 ? (churnVol / totVol) * 100 : 0;

  const buys5 = in5.filter((x) => x.buy);
  const retailPct = buys5.length >= 5 ? (buys5.filter((x) => x.sol >= 0.05 && x.sol <= 5).length / buys5.length) * 100 : null;
  const buysLast2 = in2.filter((x) => x.buy).length / 2;
  const buysPrev3 = in5.filter((x) => x.buy && now - x.t > 2 * 60_000).length / 3;
  const buyAccel = buysPrev3 > 0 ? buysLast2 / buysPrev3 : buysLast2 > 0 ? 2 : null;
  const b2 = in2.filter((x) => x.buy).reduce((s, x) => s + x.sol, 0);
  const s2 = in2.filter((x) => !x.buy).reduce((s, x) => s + x.sol, 0);
  const buyRatio2m = b2 + s2 >= 0.2 ? (s2 > 0 ? b2 / s2 : 5) : null;
  const buyVol5 = buys5.reduce((s, x) => s + x.sol, 0);
  const bigSell = in5.filter((x) => !x.buy).reduce((m, x) => Math.max(m, x.sol), 0);
  const whaleSellPct = buyVol5 > 0 ? (bigSell / buyVol5) * 100 : bigSell > 0 ? 100 : 0;
  const smartBuyerPct = opts.smartBuyerPct ?? null;

  // ---- Manipulation (last 10 minutes) ----
  const in10 = trades.filter((x) => now - x.t <= 10 * 60_000);
  const vol10 = in10.reduce((s, x) => s + x.sol, 0);
  // Fake volume: wallets with 2+ buys AND 2+ sells, or a fast round trip (sold ≥90% of what they bought within 60s).
  let fakeVol = 0;
  const volBy = new Map<string, number>();
  for (const [w, p] of per) {
    volBy.set(w, p.vol);
    const bought = p.buys.reduce((s2, b) => s2 + b.tok, 0);
    const firstBuy = p.buys[0];
    const fastSold = firstBuy ? p.sells.filter((x) => x.t >= firstBuy.t && x.t - firstBuy.t <= 60_000).reduce((s2, b) => s2 + b.tok, 0) : 0;
    if ((p.buys.length >= 2 && p.sells.length >= 2) || (bought > 0 && fastSold >= bought * 0.9)) fakeVol += p.vol;
  }
  const fakeVolumePct = vol10 > 0 ? (fakeVol / vol10) * 100 : 0;
  const top3VolumePct = vol10 > 0 ? ([...volBy.values()].sort((a, b) => b - a).slice(0, 3).reduce((s2, v) => s2 + v, 0) / vol10) * 100 : 0;
  const dustTradePct = in10.length ? (in10.filter((x) => x.sol < 0.005).length / in10.length) * 100 : 0;
  // Bundles: 3+ different wallets buying near-identical sizes in the same slot (or same second if no slot).
  const groups = new Map<string, CrowdTrade[]>();
  for (const x of in10) {
    if (!x.buy || x.sol < 0.01) continue;
    const k = x.s ? `s${x.s}` : `t${Math.floor(x.t / 1000)}`;
    const g = groups.get(k) ?? [];
    g.push(x);
    groups.set(k, g);
  }
  let bundled = 0;
  const buyVol10 = in10.filter((x) => x.buy).reduce((s2, x) => s2 + x.sol, 0);
  for (const g of groups.values()) {
    if (g.length < 3) continue;
    const sizes = g.map((x) => x.sol).sort((a, b) => a - b);
    const mid = sizes[Math.floor(sizes.length / 2)]!;
    const alike = g.filter((x) => Math.abs(x.sol - mid) / mid <= 0.03);
    if (new Set(alike.map((x) => x.w)).size >= 3) bundled += alike.reduce((s2, x) => s2 + x.sol, 0);
  }
  const bundledBuyPct = buyVol10 > 0 ? (bundled / buyVol10) * 100 : 0;
  // Chasing: price now vs ~3 minutes ago.
  const px3 = [...trades].reverse().find((x) => now - x.t >= 3 * 60_000 && x.px > 0)?.px;
  const pxNow = trades.length ? median(trades.slice(-3).map((x) => x.px).filter((v) => v > 0)) : 0;
  const priceChange3mPct = px3 && pxNow > 0 ? (pxNow / px3 - 1) * 100 : null;

  // Summary score: each part 0..1, missing parts don't count.
  const parts: Array<[number | null, number]> = [
    [dipBuyRatio, 0.25],
    [paperHandsPct === null ? null : 1 - clamp01(paperHandsPct / 50), 0.2],
    [in5.length >= 10 ? 1 - clamp01(churnPct / 60) : null, 0.2],
    [retailPct === null ? null : clamp01((retailPct - 30) / 50), 0.1],
    [buyAccel === null ? null : clamp01(buyAccel / 2), 0.1],
    [smartBuyerPct === null ? null : clamp01(smartBuyerPct / 20), 0.15],
  ];
  const used = parts.filter(([v]) => v !== null) as Array<[number, number]>;
  const wsum = used.reduce((s, [, w]) => s + w, 0);
  let crowdScore = wsum >= 0.3 ? used.reduce((s, [v, w]) => s + v * w, 0) / wsum : 0.5;
  // A whale dumping into the crowd, fake volume or bundles override the nice numbers.
  if (whaleSellPct > 60) crowdScore *= 0.6;
  if (in10.length >= 10) crowdScore *= 1 - Math.min(0.6, Math.max(fakeVolumePct - 15, 0) / 100 + Math.max(bundledBuyPct - 10, 0) / 100);
  const attentionScore = clamp01(wallets5.size / Math.max(1, opts.fullAttentionWallets));

  const bits = [`${wallets5.size} active wallets (5m)`];
  if (dipBuyRatio !== null) bits.push(`dip buying ${(dipBuyRatio * 100).toFixed(0)}%`);
  if (paperHandsPct !== null) bits.push(`paper hands ${paperHandsPct.toFixed(0)}%`);
  if (in5.length >= 10) bits.push(`bot churn ${churnPct.toFixed(0)}%`);
  if (smartBuyerPct !== null && smartBuyerPct > 0) bits.push(`smart wallets ${smartBuyerPct.toFixed(0)}%`);
  if (fakeVolumePct >= 25) bits.push(`fake volume ~${fakeVolumePct.toFixed(0)}%`);
  if (bundledBuyPct >= 15) bits.push(`bundled buys ${bundledBuyPct.toFixed(0)}%`);
  if (whaleSellPct > 60) bits.push('whale selling into buyers');

  return {
    trades5m: in5.length,
    activeWallets5m: wallets5.size,
    newBuyers5m,
    dipBuyRatio,
    paperHandsPct,
    churnPct,
    retailPct,
    buyAccel,
    buyRatio2m,
    whaleSellPct,
    smartBuyerPct,
    fakeVolumePct: Math.round(fakeVolumePct * 10) / 10,
    bundledBuyPct: Math.round(bundledBuyPct * 10) / 10,
    top3VolumePct: Math.round(top3VolumePct * 10) / 10,
    dustTradePct: Math.round(dustTradePct * 10) / 10,
    priceChange3mPct: priceChange3mPct === null ? null : Math.round(priceChange3mPct * 10) / 10,
    crowdScore: Math.round(crowdScore * 1000) / 1000,
    attentionScore: Math.round(attentionScore * 1000) / 1000,
    summary: bits.join(', '),
  };
}

/** Swing entry check on a price path (oldest → newest). Pure. */
export function swingSignal(
  trades: readonly CrowdTrade[],
  now: number,
  c: { minPullbackPct: number; maxPullbackPct: number; bounceConfirmPct: number; minBuyRatio: number },
  windowMs = 20 * 60_000,
): { ok: boolean; why: string; pullbackPct: number; bouncePct: number } {
  const recent = trades.filter((x) => now - x.t <= windowMs && x.px > 0);
  if (recent.length < 15) return { ok: false, why: 'not enough trades', pullbackPct: 0, bouncePct: 0 };
  // Robust high/low: ignore the single most extreme print each side.
  const pxs = recent.map((x) => x.px);
  const sorted = [...pxs].sort((a, b) => a - b);
  const high = sorted[sorted.length - 2] ?? sorted[sorted.length - 1]!;
  const highIdx = pxs.findIndex((p) => p >= high);
  const after = pxs.slice(highIdx);
  const afterSorted = [...after].sort((a, b) => a - b);
  const low = afterSorted[1] ?? afterSorted[0]!;
  const last = median(pxs.slice(-3));
  const pullbackPct = high > 0 ? (1 - low / high) * 100 : 0;
  const bouncePct = low > 0 ? (last / low - 1) * 100 : 0;
  const twoMin = recent.filter((x) => now - x.t <= 2 * 60_000);
  const b = twoMin.filter((x) => x.buy).reduce((s, x) => s + x.sol, 0);
  const s = twoMin.filter((x) => !x.buy).reduce((s2, x) => s2 + x.sol, 0);
  const ratio = s > 0 ? b / s : b > 0 ? 5 : 0;
  if (pullbackPct < c.minPullbackPct) return { ok: false, why: `pullback ${pullbackPct.toFixed(0)}% < ${c.minPullbackPct}%`, pullbackPct, bouncePct };
  if (pullbackPct > c.maxPullbackPct) return { ok: false, why: `dumped ${pullbackPct.toFixed(0)}% (> ${c.maxPullbackPct}%)`, pullbackPct, bouncePct };
  if (bouncePct < c.bounceConfirmPct) return { ok: false, why: `no bounce yet (${bouncePct.toFixed(1)}%)`, pullbackPct, bouncePct };
  if (last >= high * 0.97) return { ok: false, why: 'already back at the high', pullbackPct, bouncePct };
  if (ratio < c.minBuyRatio) return { ok: false, why: `buyers not in control (${ratio.toFixed(2)})`, pullbackPct, bouncePct };
  return { ok: true, why: `pulled back ${pullbackPct.toFixed(0)}%, bounced ${bouncePct.toFixed(0)}%, buy/sell ${ratio.toFixed(1)}`, pullbackPct, bouncePct };
}

function median(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export class CrowdTracker {
  private readonly logs = new Map<string, CrowdTrade[]>();
  /** 15-second candles per coin (last hour) — the chart the chart reader reads. */
  private readonly candleSeries = new Map<string, Candle[]>();
  /** Coins that already crossed into the Soon zone (fire once). */
  private readonly soonSeen = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  /** Called once when a curve coin first reaches `focus.soon.minCurvePct`. */
  onSoon: ((mint: string, curvePct: number) => void) | null = null;

  start(): void {
    this.timer = setInterval(() => this.prune(), 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  get size(): number {
    return this.logs.size;
  }

  onCurveTrade(ev: PumpTradeEvent, slot = 0, now = Date.now()): void {
    const f = getConfig().focus;
    const pct = ev.virtualTokenReserves > 0n ? bondingCurvePct(ev.virtualTokenReserves) : 0;
    if (pct >= f.soon.minCurvePct && pct <= f.soon.maxCurvePct && !this.soonSeen.has(ev.mint)) {
      this.soonSeen.add(ev.mint);
      this.onSoon?.(ev.mint, pct);
    }
    if (pct < f.crowdLogFromCurvePct && !this.logs.has(ev.mint)) return;
    const tok = Number(ev.tokenAmount) / 10 ** PUMP_TOKEN_DECIMALS;
    const sol = Number(ev.solAmount) / 1e9;
    const pp = ev.virtualTokenReserves > 0n ? Number(ev.virtualSolReserves) / 1e9 / (Number(ev.virtualTokenReserves) / 10 ** PUMP_TOKEN_DECIMALS) : undefined;
    this.push(ev.mint, { t: now, w: ev.user, buy: ev.isBuy, sol, tok, px: tok > 0 ? sol / tok : 0, ...(pp ? { pp } : {}), s: slot || undefined });
  }

  onAmmTrade(mint: string, ev: AmmTradeEvent, slot = 0, now = Date.now()): void {
    const tok = Number(ev.baseAmount) / 10 ** PUMP_TOKEN_DECIMALS;
    const sol = Number(ev.quoteAmount) / 1e9;
    // Price after the trade from its own amounts (BOOST pools' virtual reserves make the raw vault ratio wrong).
    const pp = ammPostTradePrice(ev) ?? undefined;
    this.push(mint, { t: now, w: ev.user, buy: ev.isBuy, sol, tok, px: tok > 0 ? sol / tok : 0, ...(pp ? { pp } : {}), s: slot || undefined });
  }

  trades(mint: string): readonly CrowdTrade[] {
    return this.logs.get(mint) ?? [];
  }

  /** Wallets that bought in the last `sinceMs` (newest first, max `limit`). */
  recentBuyers(mint: string, sinceMs = 10 * 60_000, limit = 60, now = Date.now()): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const log = this.logs.get(mint) ?? [];
    for (let i = log.length - 1; i >= 0 && out.length < limit; i--) {
      const x = log[i]!;
      if (now - x.t > sinceMs) break;
      if (x.buy && !seen.has(x.w)) {
        seen.add(x.w);
        out.push(x.w);
      }
    }
    return out;
  }

  metrics(mint: string, smartBuyerPct: number | null = null, now = Date.now()): CrowdMetrics {
    return computeCrowdMetrics(this.trades(mint), now, { fullAttentionWallets: getConfig().focus.fullAttentionWallets, smartBuyerPct });
  }

  /** 15s candles (oldest → newest), last hour. */
  candles(mint: string): readonly Candle[] {
    return this.candleSeries.get(mint) ?? [];
  }

  private push(mint: string, x: CrowdTrade): void {
    let series = this.candleSeries.get(mint);
    if (!series) {
      series = [];
      this.candleSeries.set(mint, series);
    }
    addToCandles(series, x.t, x.px, x.sol, x.buy);
    let log = this.logs.get(mint);
    if (!log) {
      log = [];
      this.logs.set(mint, log);
    }
    log.push(x);
    if (log.length > MAX_TRADES) log.splice(0, log.length - MAX_TRADES);
  }

  private prune(now = Date.now()): void {
    for (const [mint, log] of this.logs) {
      const i = log.findIndex((x) => now - x.t <= KEEP_MS);
      if (i === -1) this.logs.delete(mint);
      else if (i > 0) log.splice(0, i);
    }
    for (const [mint, series] of this.candleSeries) {
      const last = series[series.length - 1];
      if (!last || now - last.t > 60 * 60_000) this.candleSeries.delete(mint);
    }
    if (this.soonSeen.size > 50_000) this.soonSeen.clear();
  }
}
