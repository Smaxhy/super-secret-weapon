/** v24 shadow book: every refused signal, graded by the lab's own finished paper trade. */
import { describe, expect, it } from 'vitest';
import { gradeShadows, recordShadows, shadowSummary, type ShadowTrade } from '../src/forex/shadow';
import { newSyncReport, type LabOpenTrade } from '../src/forex/practice';
import type { Trade } from '../src/forex/types';

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 14, 14);
const lab = (o: Partial<LabOpenTrade> = {}): LabOpenTrade => ({ ref: `ema_cross:1h:EURUSD:${T0 - H}`, strategy: 'ema_cross', tf: '1h', pair: 'EURUSD', side: 1, entryT: T0, entry: 1.1, stop: 1.095, target: 1.11, chosen: true, ...o });
const closedTrade = (o: Partial<Trade> = {}): Trade => ({ strategy: 'ema_cross', tf: '1h', pair: 'EURUSD', side: 1, entryT: T0, keyT: T0 - H, exitT: T0 + 5 * H, entry: 1.1, exit: 1.11, r: 1.9, stopPct: 0.45, reason: 'target', bars: 5, stop: 1.095, stop0: 1.095, target: 1.11, ...o } as Trade);

describe('recordShadows', () => {
  it('writes a refused signal once with the lab trade, the reason and its kind; a wait that is later taken is struck', () => {
    const rep = newSyncReport();
    rep.waits.push({ pair: 'EURUSD', strategy: 'ema_cross', tf: '1h', side: 1, why: 'only 1 of 4 market checks agree (needs 2: strength, bigger charts, mood)' });
    const book = recordShadows([], rep, [lab()], new Set(), T0 + 60_000);
    expect(book).toHaveLength(1);
    expect(book[0]).toMatchObject({ key: `ema_cross:1h:EURUSD:${T0 - H}`, pair: 'EURUSD', side: 1, entry: 1.1, stop: 1.095, target: 1.11, kind: 'agree', mode: 'wait' });
    // the same signal refused again an hour later → still one row, reason updated
    const rep2 = newSyncReport();
    rep2.skipped.push({ pair: 'EURUSD', strategy: 'ema_cross', tf: '1h', side: 1, why: 'no winning record on this market (9 tested trades here, profit factor 0.8)' });
    const book2 = recordShadows(book, rep2, [lab()], new Set(), T0 + 2 * H);
    expect(book2).toHaveLength(1);
    expect(book2[0]!.kind).toBe('market_rec');
    expect(book2[0]!.mode).toBe('skip');
    // the bot took it after all → gone
    expect(recordShadows(book2, newSyncReport(), [lab()], new Set([`ema_cross:1h:EURUSD:${T0 - H}`]), T0 + 3 * H)).toHaveLength(0);
  });
  it('ignores refusals of trades the lab no longer has open, and drops stale unresolved rows', () => {
    const rep = newSyncReport();
    rep.skipped.push({ pair: 'GBPUSD', strategy: 'x', tf: '1h', side: -1, why: 'slots are full' });
    expect(recordShadows([], rep, [lab()], new Set(), T0)).toHaveLength(0);
    const old: ShadowTrade = { key: 'k', strategy: 'x', tf: '1h', pair: 'GBPUSD', side: 1, entry: 1, stop: 0.99, target: null, t: T0 - 60 * 86_400_000, at: T0, why: 'w', kind: 'other', mode: 'skip' };
    expect(recordShadows([old], newSyncReport(), [], new Set(), T0)).toHaveLength(0);
    expect(recordShadows([{ ...old, r: 0.5 }], newSyncReport(), [], new Set(), T0)).toHaveLength(1);
  });
});

describe('gradeShadows + shadowSummary', () => {
  it('takes the R of the lab trade with the same identity and sums per reason / strategy in R and money', () => {
    const rep = newSyncReport();
    rep.waits.push({ pair: 'EURUSD', strategy: 'ema_cross', tf: '1h', side: 1, why: 'only 1 of 4 market checks agree (needs 2: strength, bigger charts, mood)' });
    rep.skipped.push({ pair: 'GBPUSD', strategy: 'rsi2', tf: '4h', side: -1, why: 'just closed a trade here — cooling off 40 min' });
    const labs = [lab(), lab({ ref: `rsi2:4h:GBPUSD:${T0 - 4 * H}`, strategy: 'rsi2', tf: '4h', pair: 'GBPUSD', side: -1, entry: 1.3, stop: 1.31, target: 1.28 })];
    let book = recordShadows([], rep, labs, new Set(), T0 + 60_000);
    book = gradeShadows(book, [closedTrade(), closedTrade({ strategy: 'rsi2', tf: '4h', pair: 'GBPUSD', side: -1, keyT: T0 - 4 * H, r: -1, reason: 'stop' })]);
    expect(book.map((s) => s.r).sort()).toEqual([-1, 1.9]);
    const sum = shadowSummary(book, { riskPct: 1, equityUsd: 1000, mids: {}, now: T0 + 6 * H });
    expect(sum.total).toMatchObject({ n: 2, done: 2, wins: 1 });
    expect(sum.total.totalR).toBeCloseTo(0.9, 6);
    expect(sum.total.usd).toBeCloseTo(9, 6);
    expect(sum.byKind.find((k) => k.kind === 'agree')).toMatchObject({ n: 1, totalR: 1.9, usd: 19 });
    expect(sum.byKind.find((k) => k.kind === 'cooldown')).toMatchObject({ n: 1, totalR: -1 });
    expect(sum.byStrategy[0]!.key).toBe('ema_cross:1h');
    expect(sum.recent).toHaveLength(2);
    expect(sum.open).toHaveLength(0);
  });
  it('a shadow still running shows its R so far at the live price', () => {
    const rep = newSyncReport();
    rep.waits.push({ pair: 'EURUSD', strategy: 'ema_cross', tf: '1h', side: 1, why: 'news' });
    const book = recordShadows([], rep, [lab()], new Set(), T0);
    const sum = shadowSummary(book, { riskPct: 2, equityUsd: 1000, mids: { EURUSD: 1.1025 }, now: T0 + H });
    expect(sum.open[0]!.rNow).toBeCloseTo(0.5, 2);
    expect(sum.total.done).toBe(0);
    expect(sum.total.usd).toBe(0);
  });
});
