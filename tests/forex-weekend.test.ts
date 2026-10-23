import { describe, expect, it } from 'vitest';
import { buildRecap, chosenAt, isWeekendFor, missingFor, readyText, WeekendReview, type RecapInput, type RecapRow } from '../src/forex/weekend';
import { CRYPTO_CLOCK, marketClock } from '../src/forex/calendar';
import { DEFAULT_PUSH_SETTINGS, fxMessageFor } from '../src/lib/push';

const SAT = Date.parse('2026-10-24T12:00:00Z'); // a Saturday; the week started Monday 2026-10-19
const MON = Date.parse('2026-10-19T00:00:00Z');

const row = (id: string, tf: string, o: Partial<RecapRow> = {}): RecapRow => ({
  id,
  name: id,
  tf,
  verdict: 'maybe',
  why: '',
  inSample: { n: 80, avgR: 0.1 },
  outSample: { n: 40, avgR: 0.2, pf: 1.5 },
  stats: { dsr: 0.8 },
  ...o,
});

const base = (o: Partial<RecapInput> = {}): RecapInput => ({
  universe: 'fx',
  now: SAT,
  week: { week: '2026-10-19', pnlUsd: -42.5, trades: 6, wins: 2, bestUsd: 30, worstUsd: -25, byStrategy: [], byPair: [] },
  prevWeek: { week: '2026-10-12', pnlUsd: 12, trades: 3, wins: 2, bestUsd: 10, worstUsd: -3, byStrategy: [], byPair: [] },
  ledger: [
    ...[-1, -1, -1, -0.8].map((r, i) => ({ key: 'pivot_bounce:4h', ref: `pivot_bounce:4h:NDXUSD:${i}`, keyT: i, closedAt: MON + (i + 1) * 3_600_000, usd: r * 20, r, why: 0 })),
    { key: 'old:1h', ref: 'old:1h:EURUSD:1', keyT: 1, closedAt: MON - 86_400_000, usd: 5, r: 1, why: 1 },
  ],
  rows: [row('pivot_bounce', '4h', { verdict: 'edge', outSample: { n: 106, avgR: 0.19, pf: 2.4 } }), row('pin_bar', '4h', { outSample: { n: 26, avgR: 0.42, pf: 2.6 } }), row('loser', '1h', { outSample: { n: 200, avgR: -0.2, pf: 0.7 } }), row('random', '1h')],
  chosen: ['pivot_bounce:4h'],
  chosenAtStart: ['pivot_bounce:4h', 'carry_trend:4h'],
  proven: { NDXUSD: ['pivot_bounce:4h'] },
  dropped: [],
  losses: [],
  shadow: [
    ...[1, 2, 1.5, 0.5].map((r, i) => ({ key: `x:1h:EURUSD:${i}`, strategy: 'x', tf: '1h', pair: 'EURUSD', side: 1 as const, entry: 1, stop: 0.99, target: 1.02, t: MON + i, at: MON + 3_600_000 * (i + 2), why: 'only 0 of 3 market checks agree', kind: 'agree' as const, mode: 'skip' as const, r })),
  ],
  events: [
    { t: SAT + 2 * 86_400_000, ccy: 'USD', title: 'CPI', impact: 'High', forecast: '', previous: '' },
    { t: SAT + 3 * 86_400_000, ccy: 'EUR', title: 'ECB rate', impact: 'High', forecast: '', previous: '' },
    { t: SAT + 86_400_000, ccy: 'USD', title: 'Low thing', impact: 'Low', forecast: '', previous: '' },
  ],
  ready: { labRanAt: SAT - 20 * 60_000, labError: null, staleMarkets: [], openPositions: 0, riskMode: 'turbo', equityUsd: 980, opensInMin: null },
  ...o,
});

describe('v27.32 weekend review', () => {
  it('builds the recap: money, live vs tested, list changes, held-back cost, near misses, news', () => {
    const r = buildRecap(base());
    expect(r.week).toBe('2026-10-19');
    expect(r.money).toMatchObject({ pnlUsd: -42.5, trades: 6, winPct: 33, prevPnlUsd: 12 });
    const pv = r.live.find((l) => l.key === 'pivot_bounce:4h')!;
    expect(pv).toMatchObject({ liveN: 4, liveR: -3.8, testAvgR: 0.19, vs: 'worse' });
    expect(r.live.some((l) => l.key === 'old:1h')).toBe(false); // last week's ledger row isn't this week's
    expect(r.list.removed).toEqual(['carry_trend:4h']);
    expect(r.heldBack[0]).toMatchObject({ kind: 'agree', done: 4, totalR: 5 });
    expect(r.nearMisses[0]).toMatchObject({ key: 'pin_bar:4h', pair: null });
    expect(r.nearMisses[0]!.missing[0]).toMatch(/4 more unseen trades/);
    expect(r.nearMisses.some((m) => m.key === 'loser:1h' || m.key === 'random:1h')).toBe(false);
    expect(r.monday.events.map((e) => e.title)).toEqual(['CPI', 'ECB rate']);
    expect(r.ready.ok).toBe(true);
    expect(r.lessons.join('\n')).toMatch(/pivot_bounce 4h made -0.95R a trade live/);
    expect(r.lessons.join('\n')).toMatch(/"market checks against it" held back 4 finished trades that would have made \+5R/);
    expect(r.lessons.join('\n')).toMatch(/Lost its live place this week: carry_trend 4h/);
    expect(r.headline).toMatch(/Week −\$42.50 on 6 trades/);
  });

  it('readiness fails on a lab error, stale prices or a trade left open over the weekend; nothing proven only waits', () => {
    const bad = buildRecap(base({ ready: { ...base().ready, labError: 'out of memory', openPositions: 1 } }));
    expect(bad.ready.ok).toBe(false);
    expect(bad.headline).toMatch(/^Not ready for Monday: the lab's last run failed: out of memory/);
    expect(readyText(bad)).toMatch(/^⚠️ Forex bot NOT ready/);
    const none = buildRecap(base({ chosen: [], proven: {} }));
    expect(none.ready.ok).toBe(true);
    expect(none.lessons.join(' ')).toMatch(/Nothing on the forex desk passes the strict test/);
    // coin desk: only USD news, no "left open" check
    const coin = buildRecap(base({ universe: 'crypto', ready: { ...base().ready, openPositions: 2 } }));
    expect(coin.ready.ok).toBe(true);
    expect(coin.monday.events.map((e) => e.ccy)).toEqual(['USD']);
    expect(readyText(coin)).toMatch(/^✅ Coin bot ready for Monday/);
  });

  it('helpers: weekend per desk, chosen list at a time, what a row / market still misses', () => {
    expect(isWeekendFor('fx', marketClock(SAT), SAT)).toBe(true);
    expect(isWeekendFor('fx', marketClock(Date.parse('2026-10-21T12:00:00Z')), Date.parse('2026-10-21T12:00:00Z'))).toBe(false);
    expect(isWeekendFor('crypto', CRYPTO_CLOCK, SAT)).toBe(true);
    expect(chosenAt([{ t: 30, keys: ['c'] }, { t: 20, keys: ['b'] }, { t: 10, keys: ['a'] }], 25)).toEqual(['b']);
    expect(chosenAt([{ t: 30, keys: ['c'] }], 25)).toBeNull();
    expect(missingFor({ n: 40, avgR: 0.2, pf: 1.5, inAvgR: 0.1, dsr: 0.8 }, false)).toEqual([]);
    expect(missingFor({ n: 40, avgR: 0.2, pf: 1.5, inAvgR: 0.1, dsr: 0.3 }, false)).toEqual(['deflated Sharpe 30% (needs 50%)']);
    expect(missingFor({ n: 35, avgR: 0.12, pf: 1.4, inN: 25, inAvgR: 0.05, mcP: 0.9 }, true)).toEqual(['Monte Carlo 90% (needs 95%)']);
  });

  it('the push rides the weekly switch and reads plainly', () => {
    const m = fxMessageFor({ kind: 'ready', pair: '', side: 1, pnlUsd: 0, reason: '✅ Forex bot ready for Monday — Week +$5.00 on 2 trades', acct: 'bot', ok: true }, DEFAULT_PUSH_SETTINGS)!;
    expect(m.title).toBe('✅ Forex bot ready for Monday');
    expect(m.body).toBe('Week +$5.00 on 2 trades');
    expect(m.url).toBe('/forex/bot');
    expect(fxMessageFor({ kind: 'ready', pair: '', side: 1, pnlUsd: 0, reason: 'x', acct: 'cbot', ok: false }, { ...DEFAULT_PUSH_SETTINGS, fxWeek: false })).toBeNull();
  });

  it('the job builds a recap only on the weekend (or when asked), stores it, and pushes once before the open', async () => {
    const kv = new Map<string, string>();
    const lists = new Map<string, string[]>();
    const redis = {
      get: async (k: string) => kv.get(k) ?? null,
      set: async (k: string, v: string, ...a: unknown[]) => {
        if (a.includes('NX') && kv.has(k)) return null;
        kv.set(k, v);
        return 'OK';
      },
      multi() {
        const ops: Array<() => void> = [];
        const m = {
          lpush: (k: string, v: string) => (ops.push(() => lists.set(k, [v, ...(lists.get(k) ?? [])])), m),
          ltrim: () => m,
          incrbyfloat: () => m,
          expire: () => m,
          exec: async () => ops.forEach((f) => f()),
        };
        return m;
      },
    };
    const pushes: string[] = [];
    let gathered = 0;
    let warmed = 0;
    const desk = { universe: 'fx' as const, k: (x: string) => x, warmUp: async () => void warmed++, gather: async (now: number) => (gathered++, base({ now, ready: { ...base().ready, labRanAt: now - 20 * 60_000 } })) };
    const job = new WeekendReview(redis as never, [desk], marketClock, (_u, text) => pushes.push(text), null);
    await job.tick(Date.parse('2026-10-21T12:00:00Z')); // Wednesday: nothing
    expect(gathered).toBe(0);
    await job.tick(SAT);
    expect(gathered).toBe(1);
    expect((await job.get((x) => x))!.recap.headline).toMatch(/Week −\$42.50/);
    expect(lists.get('fx:weekend:hist')).toHaveLength(1);
    await job.tick(SAT + 30 * 60_000); // still fresh
    expect(gathered).toBe(1);
    const sunEve = Date.parse('2026-10-25T20:00:00Z'); // forex opens 21:00 UTC (17:00 New York, EST from Nov 1 — EDT here)
    expect(marketClock(sunEve).open).toBe(false);
    await job.tick(sunEve - 30 * 60_000); // 90 min before the open: warm-up, no push yet
    expect(warmed).toBe(1);
    expect(pushes).toHaveLength(0);
    await job.tick(sunEve);
    await job.tick(sunEve + 15 * 60_000);
    expect(warmed).toBe(1);
    expect(pushes).toHaveLength(1);
    const steps = (await job.get((x) => x))!.steps!.map((x) => x.what).join(' | ');
    expect(steps).toMatch(/warm-up before the open/);
    expect(steps).toMatch(/ready check sent: ready/);
    expect(pushes[0]).toMatch(/^✅ Forex bot ready for Monday/);
    await job.tick(Date.parse('2026-10-21T12:00:00Z'), true); // "Review now" works on a weekday
    expect(gathered).toBeGreaterThan(3);
  });
});
