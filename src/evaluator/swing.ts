/**
 * Swing trading bigger coins — the decision maths (v7). All pure.
 *
 * Owner: "swing trade more, especially bigger coins like $clude that show the power of bouncing
 * back". Established memecoins (migrated, $40k–$25M) dip 20–40% many times a day; the ones with
 * a strong holder base get bought back up every time, the dying ones keep falling. So:
 *
 *  1. bounceBack(): BOUNCE-BACK POWER from history (24 h of 5-min candles): every dip of ≥ dipPct
 *     from a running high, and whether it won back ≥ recoverPct of the drop (recovered) or kept
 *     falling (≥ 60% down / no recovery within 6 h = failed). Many recoveries, few failures,
 *     higher lows = a coin people defend.
 *  2. swingSetup(): THE ENTRY on live 15 s candles: pulled back minPullbackPct–maxPullbackPct from
 *     its recent high (or the higher-timeframe high), a low that HELD (higher low), bounced
 *     minBouncePct–maxBouncePct off it (not chasing the bounce) with buyers in control
 *     (buy/sell ≥ minBuyRatio over 2 min) and room back to the high.
 *  3. swingDecision(): hard rules (safety, size, liquidity, activity, manipulation, KOLs dumping,
 *     holder concentration, falling knife) + a 0–100 score: bounce-back power 25, setup 15
 *     (+ confirming dip-type chart strategies), trend 10, order flow 10, + trending / KOL /
 *     proven-strategy bonuses → BUY at ≥ minScore (watchlist coins a little easier).
 */
import type { Candle } from './chart-reader';

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);
const r1 = (x: number) => Math.round(x * 10) / 10;

/** Minimal bar (history candles from GeckoTerminal, or resampled live candles). */
export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface BounceStats {
  bars: number;
  spanHours: number;
  /** Dips of ≥ dipPct from a running high. */
  dips: number;
  /** …that won back ≥ recoverPct of the drop. */
  recovered: number;
  /** …that fell ≥ failPct from the high or didn't recover within failAfterHours. */
  failed: number;
  /** recovered ÷ (recovered + failed); null = no finished dips. */
  recoveryRate: number | null;
  avgDipPct: number | null;
  avgRecoverMin: number | null;
  /** In an unfinished dip right now: how deep it went and how long ago it started. */
  inDip: { depthPct: number; fromHighPct: number; sinceMin: number } | null;
  high: number;
  low: number;
  last: number;
  /** Last close vs the highest high, % below it. */
  fromHighPct: number;
  /** Last close vs the first open, %. */
  changePct: number;
  /** The last three swing lows are rising (structure); null = not enough swings. */
  higherLows: boolean | null;
  /** 0–1 bounce-back power (see swingResilience). */
  score: number;
}

/** Swing lows (pivots: lower than `k` bars each side), oldest → newest. */
function pivotLows(bars: readonly Bar[], k = 3): Array<{ i: number; p: number }> {
  const out: Array<{ i: number; p: number }> = [];
  for (let i = k; i < bars.length - k; i++) {
    let low = true;
    for (let j = i - k; j <= i + k && low; j++) if (j !== i && bars[j]!.l < bars[i]!.l) low = false;
    if (low && (!out.length || i - out[out.length - 1]!.i > k)) out.push({ i, p: bars[i]!.l });
  }
  return out;
}

/** 0–1 bounce-back power from dip statistics. Pure. */
export function swingResilience(s: Pick<BounceStats, 'recovered' | 'failed' | 'recoveryRate' | 'fromHighPct' | 'changePct' | 'higherLows'>): number {
  let score = 0.15 + Math.min(s.recovered, 4) * 0.15 + (s.recoveryRate ?? 0.5) * 0.25 - s.failed * 0.1;
  if (s.higherLows === true) score += 0.05;
  if (s.higherLows === false) score -= 0.05;
  // A coin far under its high or down hard on the day is losing its holders, whatever it did before.
  if (s.fromHighPct > 70) score *= 0.5;
  if (s.changePct < -50) score *= 0.7;
  return Math.round(clamp01(score) * 1000) / 1000;
}

/** Bounce-back power from bars (oldest → newest). null = not enough data. Pure. */
export function bounceBack(
  bars: readonly Bar[],
  c: { dipPct: number; recoverPct: number; failPct?: number; failAfterHours?: number },
  now = bars.length ? bars[bars.length - 1]!.t : 0,
): BounceStats | null {
  const b = bars.filter((x) => x.h > 0 && x.l > 0 && x.c > 0);
  if (b.length < 12) return null;
  const dip = c.dipPct / 100;
  const rec = c.recoverPct / 100;
  const fail = (c.failPct ?? 60) / 100;
  const failMs = (c.failAfterHours ?? 6) * 3600_000;
  let state: 'up' | 'dip' = 'up';
  let H = b[0]!.h;
  let dipH = 0;
  let L = 0;
  let lowAt = 0;
  let dipAt = 0;
  let dips = 0;
  let recovered = 0;
  let failed = 0;
  const depths: number[] = [];
  const recoverMin: number[] = [];
  for (const x of b) {
    if (state === 'up') {
      if (x.h > H) H = x.h;
      if (x.l <= H * (1 - dip)) {
        state = 'dip';
        dips++;
        dipH = H;
        L = x.l;
        lowAt = x.t;
        dipAt = x.t;
      }
      continue;
    }
    if (x.l < L) {
      L = x.l;
      lowAt = x.t;
    }
    if (x.h >= L + rec * (dipH - L)) {
      recovered++;
      depths.push(1 - L / dipH);
      recoverMin.push((x.t - lowAt) / 60_000);
      state = 'up';
      H = x.h;
    } else if (L <= dipH * (1 - fail) || x.t - dipAt > failMs) {
      // Kept falling / never came back: a failed defence. Start over from here.
      failed++;
      depths.push(1 - L / dipH);
      state = 'up';
      H = x.h;
    }
  }
  const high = Math.max(...b.map((x) => x.h));
  const low = Math.min(...b.map((x) => x.l));
  const last = b[b.length - 1]!.c;
  const finished = recovered + failed;
  const piv = pivotLows(b);
  const lastLows = piv.slice(-3);
  const stats: Omit<BounceStats, 'score'> = {
    bars: b.length,
    spanHours: r1((b[b.length - 1]!.t - b[0]!.t) / 3600_000),
    dips,
    recovered,
    failed,
    recoveryRate: finished ? Math.round((recovered / finished) * 100) / 100 : null,
    avgDipPct: depths.length ? r1((depths.reduce((s, x) => s + x, 0) / depths.length) * 100) : null,
    avgRecoverMin: recoverMin.length ? Math.round(recoverMin.reduce((s, x) => s + x, 0) / recoverMin.length) : null,
    inDip: state === 'dip' ? { depthPct: r1((1 - L / dipH) * 100), fromHighPct: r1((1 - last / dipH) * 100), sinceMin: Math.round((now - dipAt) / 60_000) } : null,
    high,
    low,
    last,
    fromHighPct: r1((1 - last / high) * 100),
    changePct: r1((last / b[0]!.o - 1) * 100),
    higherLows: lastLows.length >= 3 ? lastLows[2]!.p > lastLows[1]!.p && lastLows[1]!.p > lastLows[0]!.p : lastLows.length === 2 ? (lastLows[1]!.p > lastLows[0]!.p ? true : null) : null,
  };
  return { ...stats, score: swingResilience(stats) };
}

/** One-line summary of the bounce-back stats (explanations, dashboard). Pure. */
export function bounceSummary(s: BounceStats | null): string {
  if (!s) return 'no history yet';
  const bits = [`${s.recovered}/${s.recovered + s.failed} dips of 20%+ bought back in ${s.spanHours}h`];
  if (s.avgDipPct !== null) bits.push(`avg dip ${s.avgDipPct}%`);
  if (s.avgRecoverMin !== null) bits.push(`back in ~${s.avgRecoverMin} min`);
  if (s.higherLows) bits.push('higher lows');
  bits.push(`${s.fromHighPct}% under the high`);
  return bits.join(', ');
}

export interface SwingSetup {
  ok: boolean;
  why: string;
  /** The high the pullback started from (live or higher-timeframe) and the low after it. */
  high: number;
  low: number;
  price: number;
  pullbackPct: number;
  bouncePct: number;
  buyRatio2m: number | null;
  higherLow: boolean;
  /** 0–1: room back to the high + buyer strength. */
  strength: number;
  /** Structure stop (under the low's wick) and target (the high). */
  stop: number | null;
  target: number | null;
}

export interface SwingSetupConfig {
  minPullbackPct: number;
  maxPullbackPct: number;
  minBouncePct: number;
  maxBouncePct: number;
  minBuyRatio: number;
}

/**
 * Live dip-and-bounce entry on completed 15 s candles (oldest → newest; ≤ 1 h). `htfHigh` = the
 * higher-timeframe high (e.g. last 6 h from history) when the pullback started before the live
 * window. Measured on closes (single spike prints don't move it). Pure.
 */
export function swingSetup(c15: readonly Candle[], price: number, c: SwingSetupConfig, htfHigh: number | null = null): SwingSetup {
  const none = (why: string, extra: Partial<SwingSetup> = {}): SwingSetup => ({ ok: false, why, high: 0, low: 0, price, pullbackPct: 0, bouncePct: 0, buyRatio2m: null, higherLow: false, strength: 0, stop: null, target: null, ...extra });
  const bars = c15.filter((x) => x.c > 0);
  if (bars.length < 20 || !(price > 0)) return none('not enough live candles');
  // The high: the highest close at least 3 candles (45 s) ago, or the higher-timeframe high if it's above.
  let hiIdx = 0;
  for (let i = 0; i < bars.length - 3; i++) if (bars[i]!.c > bars[hiIdx]!.c) hiIdx = i;
  let high = bars[hiIdx]!.c;
  let from = hiIdx + 1;
  if (htfHigh !== null && htfHigh > high * 1.02) {
    high = htfHigh;
    from = 0;
  }
  const after = bars.slice(from);
  if (after.length < 4) return none('pullback just started');
  let loIdx = 0;
  for (let i = 1; i < after.length; i++) if (after[i]!.c < after[loIdx]!.c) loIdx = i;
  const low = after[loIdx]!.c;
  const lowWick = Math.min(...after.slice(Math.max(0, loIdx - 1), loIdx + 2).map((x) => x.l));
  const pullbackPct = r1((1 - low / high) * 100);
  const bouncePct = r1((price / low - 1) * 100);
  // A low that held: set ≥ 2 candles (30 s) ago and nothing closed under it since.
  const since = after.slice(loIdx + 1);
  const higherLow = since.length >= 2 && since.every((x) => x.c >= low * 0.998);
  const last8 = bars.slice(-8);
  const bv = last8.reduce((s, x) => s + x.bv, 0);
  const sv = last8.reduce((s, x) => s + x.sv, 0);
  const buyRatio2m = bv + sv > 0 ? Math.round((sv > 0 ? bv / sv : 5) * 100) / 100 : null;
  const base = { high, low, price, pullbackPct, bouncePct, buyRatio2m, higherLow, stop: lowWick * 0.99, target: high };
  if (pullbackPct < c.minPullbackPct) return none(`only ${pullbackPct}% off the high (need ${c.minPullbackPct}%)`, base);
  if (pullbackPct > c.maxPullbackPct) return none(`dumped ${pullbackPct}% (> ${c.maxPullbackPct}%) — trend broken`, base);
  if (!higherLow) return none('no higher low yet (still making new lows)', base);
  if (bouncePct < c.minBouncePct) return none(`bounce ${bouncePct}% (need ${c.minBouncePct}%)`, base);
  if (bouncePct > c.maxBouncePct) return none(`already bounced ${bouncePct}% — not chasing, wait for the next dip`, base);
  if (price >= high * 0.95) return none('back near the high — no room left', base);
  if (buyRatio2m === null || buyRatio2m < c.minBuyRatio) return none(`buyers not in control (buy/sell ${buyRatio2m ?? 0})`, base);
  const room = high / price - 1;
  const strength = Math.round(clamp01(0.35 + 0.35 * clamp01(room / 0.3) + 0.3 * clamp01((buyRatio2m - c.minBuyRatio) / 1.5)) * 100) / 100;
  return { ok: true, why: `pulled back ${pullbackPct}% from the high, held a higher low, bounced ${bouncePct}% with buy/sell ${buyRatio2m}`, strength, ...base };
}

export interface SwingInput {
  watchlist: boolean;
  /** Organic trending lists it's on right now. */
  trendingLists: number;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  /** Minutes since it migrated to PumpSwap. */
  ageMin: number | null;
  priceChange1hPct: number | null;
  priceChange24hPct: number | null;
  trades10m: number;
  activeWallets5m: number;
  safety: { checked: boolean; hardFail: boolean; detail?: string | null };
  banned: boolean;
  mayhem: boolean;
  /** 24 h history stats (null = not fetched yet) and the live-hour fallback. */
  bounce: BounceStats | null;
  liveBounce: BounceStats | null;
  setup: SwingSetup;
  /** Dip-type chart strategies firing now (proven = beat random entries in the live lab). */
  ta: ReadonlyArray<{ id: string; strength: number; why: string; proven: boolean }>;
  crowd: { fakeVolumePct: number; top3VolumePct: number; whaleSellPct: number } | null;
  /** Top-10 holders' share (RPC, pool vault excluded); null = unknown. */
  top10Pct: number | null;
  kolDumping: boolean;
  kolBuyers: number;
  /** Trade-coach and market-mood bar changes. */
  barDelta: number;
}

export interface SwingConfig extends SwingSetupConfig {
  minMarketCapUsd: number;
  maxMarketCapUsd: number;
  minLiquidityUsd: number;
  minVolume24hUsd: number;
  minAgeMin: number;
  minTrades10m: number;
  minScore: number;
  watchlistScoreDelta: number;
  minResilience: number;
  maxTop10Pct: number;
  halfSizeTop10Pct: number;
}

export interface SwingVerdict {
  decision: 'BUY' | 'SKIP';
  score: number;
  threshold: number;
  fails: string[];
  notes: string[];
  sizeFactor: number;
  resilience: number;
  parts: Record<string, number>;
}

/** The swing decision for one coin right now. Pure. */
export function swingDecision(i: SwingInput, c: SwingConfig): SwingVerdict {
  const fails: string[] = [];
  const notes: string[] = [];
  const usd = (x: number) => `$${Math.round(x).toLocaleString('en-US')}`;
  if (!i.safety.checked) fails.push('safety check pending');
  else if (i.safety.hardFail) fails.push(`safety check failed${i.safety.detail ? ` (${i.safety.detail})` : ''}`);
  if (i.banned) fails.push('banned / downranked on pump.fun');
  if (i.mayhem) fails.push('Mayhem-mode coin');
  if (i.marketCapUsd === null) fails.push('market cap unknown');
  else if (i.marketCapUsd < c.minMarketCapUsd) fails.push(`MC ${usd(i.marketCapUsd)} < ${usd(c.minMarketCapUsd)}`);
  else if (i.marketCapUsd > c.maxMarketCapUsd) fails.push(`MC ${usd(i.marketCapUsd)} > ${usd(c.maxMarketCapUsd)}`);
  if (i.liquidityUsd !== null && i.liquidityUsd < c.minLiquidityUsd) fails.push(`liquidity ${usd(i.liquidityUsd)} < ${usd(c.minLiquidityUsd)}`);
  if (i.volume24hUsd !== null && i.volume24hUsd < c.minVolume24hUsd) fails.push(`24h volume ${usd(i.volume24hUsd)} < ${usd(c.minVolume24hUsd)}`);
  if (i.ageMin !== null && i.ageMin < c.minAgeMin) fails.push(`migrated ${Math.round(i.ageMin)} min ago (< ${c.minAgeMin})`);
  if (i.trades10m < c.minTrades10m) fails.push(`only ${i.trades10m} trades in 10 min (< ${c.minTrades10m})`);
  if (i.priceChange1hPct !== null && i.priceChange1hPct < -40) fails.push(`falling knife (${i.priceChange1hPct.toFixed(0)}% in 1 h)`);
  if (i.priceChange24hPct !== null && i.priceChange24hPct < -75) fails.push(`down ${Math.abs(i.priceChange24hPct).toFixed(0)}% on the day`);
  if (i.crowd && i.crowd.fakeVolumePct > 50) fails.push(`fake volume ~${i.crowd.fakeVolumePct.toFixed(0)}%`);
  if (i.crowd && i.crowd.top3VolumePct > 65) fails.push(`3 wallets make ${i.crowd.top3VolumePct.toFixed(0)}% of the volume`);
  if (i.kolDumping) fails.push('KOLs dumping');
  if (i.top10Pct !== null && i.top10Pct > c.maxTop10Pct) fails.push(`top 10 holders own ${i.top10Pct.toFixed(0)}% (> ${c.maxTop10Pct}%)`);
  // Bounce-back power: the 24 h history; without it, the last live hour counts a little less.
  const resilience = i.bounce ? i.bounce.score : i.liveBounce ? Math.round(i.liveBounce.score * 0.8 * 1000) / 1000 : 0.4;
  if (!i.watchlist && resilience < c.minResilience) fails.push(`weak bounce-back power (${resilience.toFixed(2)} < ${c.minResilience})`);
  const confirming = i.ta.filter((t) => t.strength >= 0.4);
  const strongTa = confirming.filter((t) => t.strength >= 0.6);
  // The entry: the dip-and-bounce setup, or a strong dip-type chart strategy while it's off the high and not chasing.
  const taEntry = !i.setup.ok && strongTa.length > 0 && i.setup.pullbackPct >= c.minPullbackPct * 0.5 && i.setup.pullbackPct <= c.maxPullbackPct && i.setup.bouncePct <= c.maxBouncePct && i.setup.price < i.setup.high * 0.97;
  if (!i.setup.ok && !taEntry) fails.push(`no swing setup: ${i.setup.why}`);

  const parts: Record<string, number> = { base: 40 };
  parts.resilience = r1(25 * resilience);
  const setupStrength = i.setup.ok ? i.setup.strength : taEntry ? Math.max(...strongTa.map((t) => t.strength)) * 0.8 : 0;
  parts.setup = r1(15 * Math.min(1, setupStrength + 0.15 * confirming.length));
  const h = i.bounce ?? i.liveBounce;
  const trend = (h?.higherLows === true ? 0.5 : h?.higherLows === null || h === null ? 0.25 : 0) + ((i.priceChange24hPct ?? 0) > 0 ? 0.25 : 0) + ((i.priceChange1hPct ?? 0) > -10 ? 0.25 : 0);
  parts.trend = r1(10 * trend);
  const flow = 0.6 * clamp01(((i.setup.buyRatio2m ?? 1) - 1) / 1) + 0.4 * clamp01(i.activeWallets5m / 40);
  parts.flow = r1(10 * flow);
  if (i.trendingLists) {
    parts.trending = Math.min(4, 2 * i.trendingLists);
    notes.push(`on ${i.trendingLists} trending list${i.trendingLists > 1 ? 's' : ''}`);
  }
  if (i.kolBuyers) {
    parts.kols = Math.min(4, 2 * i.kolBuyers);
    notes.push(`${i.kolBuyers} KOL${i.kolBuyers > 1 ? 's' : ''} bought`);
  }
  const proven = confirming.filter((t) => t.proven);
  if (proven.length) {
    parts.proven = Math.min(6, 3 * proven.length);
    notes.push(`proven chart setups: ${proven.map((t) => t.id).join(', ')}`);
  }
  for (const t of confirming.slice(0, 3)) notes.push(`chart: ${t.why}`);
  let sizeFactor = 1;
  if (i.crowd && i.crowd.fakeVolumePct > 25) {
    parts.fakeVolume = -r1((i.crowd.fakeVolumePct - 25) / 5);
    notes.push(`some fake volume (~${i.crowd.fakeVolumePct.toFixed(0)}%)`);
  }
  if (i.top10Pct !== null && i.top10Pct > c.halfSizeTop10Pct && i.top10Pct <= c.maxTop10Pct) {
    parts.holders = -5;
    sizeFactor = 0.5;
    notes.push(`top 10 hold ${i.top10Pct.toFixed(0)}% (half size)`);
  }
  if (i.crowd && i.crowd.whaleSellPct > 60) {
    parts.whale = -4;
    notes.push('a whale is selling into the bounce');
  }
  const score = Math.round(Math.max(0, Math.min(100, Object.values(parts).reduce((s, x) => s + x, 0))) * 10) / 10;
  const threshold = c.minScore + i.barDelta + (i.watchlist ? c.watchlistScoreDelta : 0);
  if (i.watchlist) notes.push('on your swing watchlist');
  return { decision: !fails.length && score >= threshold ? 'BUY' : 'SKIP', score, threshold, fails, notes, sizeFactor, resilience, parts };
}

/** Resample 15 s candles into bigger bars (e.g. 1-min bars for the live-hour bounce stats). Pure. */
export function toBars(c: readonly Candle[], stepMs: number): Bar[] {
  const out: Bar[] = [];
  for (const x of c) {
    const b = Math.floor(x.t / stepMs) * stepMs;
    const l = out[out.length - 1];
    if (l && l.t === b) {
      l.h = Math.max(l.h, x.h);
      l.l = Math.min(l.l, x.l);
      l.c = x.c;
      l.v += x.v;
    } else out.push({ t: b, o: x.o, h: x.h, l: x.l, c: x.c, v: x.v });
  }
  return out;
}

/**
 * GeckoTerminal OHLCV response → bars (oldest → newest). `ohlcv_list` rows are
 * [timestamp s, open, high, low, close, volume]. Bad rows are skipped. Pure.
 */
export function parseGeckoOhlcv(body: unknown): Bar[] {
  const list = (body as { data?: { attributes?: { ohlcv_list?: unknown } } } | null)?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list)) return [];
  const out: Bar[] = [];
  for (const row of list) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const [t, o, h, l, c, v] = row.map((x) => (typeof x === 'string' ? Number(x) : (x as number)));
    if (![t, o, h, l, c].every((x) => Number.isFinite(x) && (x as number) > 0)) continue;
    out.push({ t: (t as number) < 1e12 ? (t as number) * 1000 : (t as number), o: o!, h: Math.max(h!, o!, c!), l: Math.min(l!, o!, c!), c: c!, v: Number.isFinite(v) ? v! : 0 });
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * Pick a coin's PumpSwap pair from DexScreener pairs: the canonical pool (pump.fun's own) if
 * listed; otherwise the most liquid SOL pair on PumpSwap, but only when it clearly dominates
 * (≥ 3× the next) — `verified` says which. null = not on PumpSwap. Pure.
 */
export function pickPumpSwapPair<P extends { pairAddress?: string; dexId?: string; quoteToken?: { address: string }; liquidity?: { usd?: number } }>(pairs: readonly P[], canonical: string | null, wsol: string): { pair: P; verified: boolean } | null {
  const amm = pairs.filter((p) => p.dexId === 'pumpswap' && (!p.quoteToken || p.quoteToken.address === wsol) && p.pairAddress);
  if (!amm.length) return null;
  const exact = canonical ? amm.find((p) => p.pairAddress === canonical) : undefined;
  if (exact) return { pair: exact, verified: true };
  const sorted = [...amm].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  const [top, next] = sorted;
  if (top && (top.liquidity?.usd ?? 0) > 0 && (!next || (top.liquidity?.usd ?? 0) >= 3 * (next.liquidity?.usd ?? 0))) return { pair: top, verified: false };
  return null;
}
