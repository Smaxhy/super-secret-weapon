import { describe, expect, it } from 'vitest';
import { dexPoints } from '../src/scanner/dexscreener';
import { breakerAfter, parseDexMetas, parseGeckoTrending, parsePumpFeed, type TrendCoin, type TrendingFeeds, type TrendSource } from '../src/scanner/trending-feeds';
import { trendScore, TrendingHub } from '../src/scanner/trending-hub';

// Shapes as pump.fun / GeckoTerminal / DexScreener return them (field names from 2026 captures).
const pumpLive = [
  { mint: 'LIVE1pump', symbol: 'CAT', name: 'Cat', usd_market_cap: 41_000, is_currently_live: true, num_participants: 86, complete: false, created_timestamp: 1_760_000_000_000, reply_count: 120 },
  { mint: 'BAN1pump', symbol: 'BAD', name: 'Bad', is_currently_live: true, num_participants: 300, is_banned: true },
  { mint: 'MAY1pump', symbol: 'AGT', name: 'Agent', mayhem_state: 'active' },
  { symbol: 'NOMINT' },
];
const koth = { mint: 'KOTH1pump', symbol: 'KING', name: 'King', usd_market_cap: 28_000, king_of_the_hill_timestamp: 1_760_000_000, complete: false };
const runners = [{ coin: { mint: 'RUN1pump', symbol: 'RUN', name: 'Runner', usd_market_cap: 900_000, complete: true } }];
const gecko = {
  data: [
    { id: 'solana_POOL1', attributes: { name: 'OLDWEB / SOL', market_cap_usd: null, fdv_usd: '61000', pool_created_at: '2026-08-31T23:13:05Z', price_change_percentage: { m5: '4.2', h1: '35', h24: '-97.8' }, volume_usd: { h1: '120000' } }, relationships: { base_token: { data: { id: 'solana_GECKO1pump' } }, dex: { data: { id: 'pumpswap' } } } },
    { id: 'eth_x', attributes: {}, relationships: { base_token: { data: { id: 'eth_0xabc' } } } },
  ],
};

describe('trending feeds: parsing', () => {
  it('pump.fun lists (array, single object, [{coin}]) → coins with viewers, KOTH, flags', () => {
    const live = parsePumpFeed(pumpLive);
    expect(live.map((c) => c.mint)).toEqual(['LIVE1pump', 'BAN1pump', 'MAY1pump']);
    expect(live[0]).toMatchObject({ symbol: 'CAT', viewers: 86, live: true, usdMarketCap: 41_000, banned: false, mayhem: false, rank: 1 });
    expect(live[1]!.banned).toBe(true);
    expect(live[2]!.mayhem).toBe(true);
    const k = parsePumpFeed(koth);
    expect(k[0]!.kothSinceMs).toBe(1_760_000_000_000); // seconds → ms
    expect(parsePumpFeed(runners)[0]).toMatchObject({ mint: 'RUN1pump', complete: true });
    expect(parsePumpFeed(null)).toEqual([]);
    expect(parsePumpFeed({ coins: pumpLive })).toHaveLength(3);
  });
  it('GeckoTerminal trending pools → Solana coins only, numbers parsed', () => {
    const g = parseGeckoTrending(gecko);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ mint: 'GECKO1pump', symbol: 'OLDWEB', usdMarketCap: 61_000, priceChange1hPct: 35, volume1hUsd: 120_000 });
    expect(parseGeckoTrending({ nope: 1 })).toEqual([]);
  });
  it('DexScreener trending narratives → hot keywords', () => {
    expect(parseDexMetas([{ name: 'Cat', slug: 'cat' }, { name: 'AI' }, { slug: 'dog' }, { name: 'x' }])).toEqual(['cat', 'ai', 'dog']);
  });
  it('circuit breaker: Cloudflare page pauses 5 min, 429 waits for the reset, JSON 200 is fine', () => {
    const now = 1_000_000;
    expect(breakerAfter(403, 'text/html', now, null).pauseUntil).toBe(now + 300_000);
    expect(breakerAfter(429, 'application/json', now, '30').pauseUntil).toBe(now + 30_000);
    expect(breakerAfter(200, 'application/json', now, null)).toEqual({ pauseUntil: null, error: null });
    expect(breakerAfter(500, 'application/json', now, null).error).toBe('HTTP 500');
  });
});

/** A feeds stand-in with fixed lists. */
function fakeFeeds(lists: Partial<Record<TrendSource, TrendCoin[]>>): TrendingFeeds {
  return { list: (s: TrendSource) => lists[s] ?? [], narratives: () => ['cat'], health: () => [] } as unknown as TrendingFeeds;
}

describe('trending signals', () => {
  const coin = (mint: string, extra: Partial<TrendCoin> = {}): TrendCoin => ({ mint, symbol: 'X', name: 'X', rank: 1, usdMarketCap: 20_000, viewers: null, live: false, complete: false, createdMs: null, kothSinceMs: null, replyCount: null, banned: false, mayhem: false, ...extra });
  const cfg = { pointsPerSource: 2, maxSourcePoints: 6, liveViewers: 50 };
  const base = { ageSec: 7200, curveVelocity: 2, dexPaid: false, boosts: 0, bundlePct: 5, insiderFlags: false, devSoldFraction: 0 };
  it('counts independent lists (max +6), live viewers rising (+2), and flags banned / Mayhem coins', () => {
    const now = 5_000_000;
    const hub = new TrendingHub(fakeFeeds({ pump_live: [coin('A', { viewers: 40, live: true })], pump_for_you: [coin('A')], gecko_5m: [coin('A')], gecko_1h: [coin('A')] }));
    hub.sample(now - 5 * 60_000);
    // Viewers rise from 40 to 90 over 5 minutes.
    (hub as unknown as { feeds: TrendingFeeds }).feeds = fakeFeeds({ pump_live: [coin('A', { viewers: 90, live: true })], pump_for_you: [coin('A')], gecko_5m: [coin('A')], gecko_1h: [coin('A')] });
    hub.sample(now);
    const info = hub.info('A', now)!;
    expect(info.sources).toHaveLength(4);
    expect(info.viewersRising).toBe(true);
    const s = trendScore({ ...base, info }, cfg);
    expect(s.points).toBe(8); // 6 (capped lists) + 2 (live, rising)
    expect(s.fails).toEqual([]);
    const bad = trendScore({ ...base, info: { ...info, banned: true, mayhem: true } }, cfg);
    expect(bad.fails.join()).toMatch(/banned/);
    expect(bad.fails.join()).toMatch(/Mayhem/);
    expect(hub.snapshot()[0]!.sources).toHaveLength(4);
  });
  it('fresh + paid + bundled = −8 and half size; with the dev selling = no buy; KOTH stall −3', () => {
    const fresh = { ...base, info: null, ageSec: 1200, dexPaid: true, bundlePct: 15 };
    expect(trendScore(fresh, cfg)).toMatchObject({ points: -8, sizeFactor: 0.5 });
    expect(trendScore({ ...fresh, devSoldFraction: 0.3 }, cfg).fails).toHaveLength(1);
    expect(trendScore({ ...fresh, ageSec: 7200 }, cfg).points).toBe(0); // an older coin paying for a profile is fine
    const kothInfo = { sources: ['pump_koth' as TrendSource], recentSources: ['pump_koth' as TrendSource], viewers: null, viewersRising: null, kothMinutes: 7, banned: false, mayhem: false, bestRank: 1 };
    expect(trendScore({ ...base, info: kothInfo, curveVelocity: 0.2 }, cfg).points).toBe(2 - 3);
    expect(trendScore({ ...base, info: kothInfo, curveVelocity: 4 }, cfg).points).toBe(2 + 3);
  });
  it('DEX paid only earns its bonus on coins older than an hour', () => {
    const paid = { paid: true, cto: false, pending: false, checkedAt: 0 };
    const c = { paidPoints: 4, ctoPoints: 2, trendingPoints: 5 };
    expect(dexPoints(paid, null, c, 7200).points).toBe(4);
    expect(dexPoints(paid, null, c, 600).points).toBe(0);
    expect(dexPoints(paid, null, c).points).toBe(4); // unknown age → as before
  });
});
