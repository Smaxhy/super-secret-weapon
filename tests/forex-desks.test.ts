import { describe, expect, it } from 'vitest';
import { DESK, applyDesks, buildDesks, dayStart, desksSummary, type DeskInput } from '../src/forex/desks';
import type { LabOpenTrade } from '../src/forex/practice';

const H = 3_600_000;
const now = Date.UTC(2026, 9, 20, 9, 0); // Tue 09:00 UTC → trading day started Mon 22:00 UTC
const d0 = dayStart(now);
const rows: DeskInput['rows'] = [
  { id: 'ema_cross', tf: '1h', pairs: [{ pair: 'EURUSD', n: 40, pf: 1.3, totalR: 6 }, { pair: 'GBPUSD', n: 30, pf: 1.1, totalR: 1 }] },
  { id: 'tsmom', tf: '4h', pairs: [{ pair: 'EURUSD', n: 3, pf: 1.5, totalR: 1.2 }, { pair: 'GBPUSD', n: 50, pf: 0.6, totalR: -12 }] },
  { id: 'random', tf: '1h', pairs: [{ pair: 'EURUSD', n: 99, pf: 2, totalR: 50 }] },
];
const open = (ref: string, pair: string, strategy: string, tf: string, chosen = false, entryT = now - H): DeskInput['open'][number] => ({ ref, pair, strategy, tf, chosen, entryT });
const base = (): DeskInput => ({ now, markets: ['EURUSD', 'GBPUSD'], rows, ledger: [], positions: [], closed: [], open: [], chosen: new Set(['ema_cross:1h']) });

describe('market desks (v20)', () => {
  it('rolls the trading day at 22:00 UTC', () => {
    expect(new Date(d0).toISOString()).toBe('2026-10-19T22:00:00.000Z');
    expect(dayStart(Date.UTC(2026, 9, 20, 23, 0))).toBe(Date.UTC(2026, 9, 20, 22, 0));
  });

  it('ranks arms per market: shrunk mean + exploration bonus, the yardstick row left out', () => {
    const { desks } = buildDesks(base());
    const eu = desks.find((d) => d.id === 'EURUSD')!;
    expect(eu.arms.map((a) => a.key)).not.toContain('random:1h');
    const ema = eu.arms.find((a) => a.key === 'ema_cross:1h')!;
    expect(ema.mean).toBeCloseTo(6 / (40 + DESK.priorN), 3);
    expect(ema.chosen).toBe(true);
    const ts = eu.arms.find((a) => a.key === 'tsmom:4h')!;
    expect(ts.score - ts.mean).toBeGreaterThan(ema.score - ema.mean); // rarely tried here → bigger bonus
    const gb = desks.find((d) => d.id === 'GBPUSD')!;
    expect(gb.arms[0]!.key).toBe('ema_cross:1h'); // tsmom lost 12R on GBPUSD → bottom
  });

  it("the bot's own fills on the market count double", () => {
    const x = base();
    x.ledger = [
      { key: 'tsmom:4h', ref: `tsmom:4h:EURUSD:${now - 5 * H}`, keyT: 0, closedAt: now - 2 * H, usd: 10, r: 1.5, why: 1 },
      { key: 'tsmom:4h', ref: `tsmom:4h:GBPUSD:${now - 5 * H}`, keyT: 0, closedAt: now - 2 * H, usd: -10, r: -1, why: 0 },
      { key: 'tsmom:4h', ref: `tsmom:4h:EURUSD:${now - 9 * H}`, keyT: 0, closedAt: now - 2 * H, usd: 0, r: 0.5, why: 5 }, // manual: ignored
    ];
    const eu = buildDesks(x).desks.find((d) => d.id === 'EURUSD')!;
    const ts = eu.arms.find((a) => a.key === 'tsmom:4h')!;
    expect(ts.own).toEqual({ n: 1, totalR: 1.5 });
    expect(ts.mean).toBeCloseTo((1.2 + 2 * 1.5) / (3 + 2 + DESK.priorN), 3);
  });

  it('takes the best firing non-chosen arm as a learning trade when the market has no trade today', () => {
    const x = base();
    x.open = [open('a', 'EURUSD', 'ema_cross', '1h', true), open('b', 'EURUSD', 'tsmom', '4h'), open('c', 'GBPUSD', 'tsmom', '4h')];
    const { desks, picks } = buildDesks(x);
    const eu = desks.find((d) => d.id === 'EURUSD')!;
    expect(eu.status).toBe('picked');
    expect(picks.get('b')).toMatchObject({ key: 'tsmom:4h', rank: 1, of: 2 });
    expect(picks.has('a')).toBe(false); // already traded by the global chooser
    // GBPUSD: tsmom's blended mean is −12/(50+10) = −0.2 < minScore → never picked for learning
    expect(desks.find((d) => d.id === 'GBPUSD')!.status).toBe('waiting');
    expect(picks.has('c')).toBe(false);
  });

  it('a market that traded today keeps its quota closed; weekend / partial rows do not count', () => {
    const x = base();
    x.open = [open('b', 'EURUSD', 'tsmom', '4h')];
    x.closed = [{ pair: 'EURUSD', openedAt: d0 + H, reason: 'stop' }];
    expect(buildDesks(x).desks[0]!.status).toBe('traded');
    x.closed = [{ pair: 'EURUSD', openedAt: d0 + H, reason: 'partial' }];
    expect(buildDesks(x).desks[0]!.status).toBe('picked');
    x.closed = [{ pair: 'EURUSD', openedAt: d0 - H, reason: 'stop' }]; // yesterday
    expect(buildDesks(x).desks[0]!.status).toBe('picked');
  });

  it('applyDesks marks the pick chosen, half size, market entry, no judge gate', () => {
    const x = base();
    x.open = [open('b', 'EURUSD', 'tsmom', '4h')];
    const { picks, desks } = buildDesks(x);
    const t = { ref: 'b', pair: 'EURUSD', strategy: 'tsmom', tf: '4h', chosen: false, entryT: now - H, side: 1, stop: 1, target: 1.1, order: { kind: 'pullback', limit: 1.04, until: now + H }, judge: { p: 0.2, ok: false, need: 0.4 }, conviction: { tier: 'sure', conf: 3, of: 4, mult: 1.5, lev: 50 }, sizeF: 1 } as unknown as LabOpenTrade;
    expect(applyDesks([t], picks)).toBe(1);
    expect(t.chosen).toBe(true);
    expect(t.order).toBeNull();
    expect(t.sizeF).toBe(DESK.riskMult);
    expect(t.conviction).toBeNull();
    expect(t.desk?.rank).toBe(1);
    expect(desksSummary(desks)).toMatch(/0 of 2 markets traded today · 1 taking a learning trade now · 1 waiting for a setup/);
  });
});
