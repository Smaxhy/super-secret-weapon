import { describe, expect, it } from 'vitest';
import { emptyPath, labelFromPath, learningSince, resolveLabel, tradeOutcome, updatePath, type PathState } from '../src/learner/labels';

const o = { winMultiple: 1.8, drawdownLossMultiple: 0.7, maxPlausibleMultiple: 25 };
const walk = (peeks: Array<[number, number, number]>): PathState => peeks.reduce((p, [mx, mn, min]) => updatePath(p, mx, mn, min, o), emptyPath());

describe('risk-aware price labels', () => {
  it('win when 1.8x came before any drop to 0.7x', () => {
    const l = labelFromPath(walk([[1.2, 0.95, 1], [1.9, 0.95, 3], [2.4, 0.6, 10]]), o);
    expect(l.win).toBe(true);
    expect(l.winAtMin).toBe(3);
    expect(l.lossAtMin).toBe(10);
    expect(l.timeToPeakMin).toBe(10);
    expect(l.maxDrawdownPct).toBe(40);
  });
  it('loss when it dumped to 0.7x first, even if it pumped later', () => {
    const l = labelFromPath(walk([[1.1, 0.65, 1], [3, 0.65, 6]]), o);
    expect(l.win).toBe(false);
  });
  it('both thresholds crossed between the same two peeks → conservative loss', () => {
    expect(labelFromPath(walk([[1.1, 0.9, 1], [2, 0.6, 3]]), o).win).toBe(false);
  });
  it('never reaching 1.8x is a loss', () => {
    expect(labelFromPath(walk([[1.5, 0.9, 1], [1.7, 0.8, 60]]), o).win).toBe(false);
  });
  it('excludes implausible >25x pumps', () => {
    expect(labelFromPath(walk([[30, 0.9, 1]]), o).excluded).toBe('implausible_multiple');
  });
});

describe('trade outcomes', () => {
  const at = new Date('2026-10-01T00:00:00Z');
  it('win = realised P&L after fees > 0', () => {
    const t = tradeOutcome({ realizedPnlSol: 0.05, sizeSol: 0.1, peakMultiple: 2, closedAt: at, suspicious: false }, o);
    expect(t).toMatchObject({ win: true, pnlPct: 50, excluded: null });
    expect(tradeOutcome({ realizedPnlSol: -0.001, sizeSol: 0.1, peakMultiple: 1.9, closedAt: at, suspicious: false }, o).win).toBe(false);
  });
  it('suspicious fills and implausible results are excluded', () => {
    expect(tradeOutcome({ realizedPnlSol: 0.05, sizeSol: 0.1, peakMultiple: 2, closedAt: at, suspicious: true }, o).excluded).toBe('suspicious_fill');
    expect(tradeOutcome({ realizedPnlSol: 3, sizeSol: 0.1, peakMultiple: 31, closedAt: at, suspicious: false }, o).excluded).toBe('implausible_multiple');
  });
});

describe('resolveLabel', () => {
  const ctx = { ...o, since: new Date('2026-10-05T00:00:00Z'), suspiciousMints: new Set(['BAD']) };
  const row = { mint: 'M', createdAt: new Date('2026-10-06T00:00:00Z'), outcomeMax: 2, outcomeMin: 0.9 };
  it('prefers the realised trade result over the price label', () => {
    expect(resolveLabel({ ...row, outcome: { win: true }, tradeResult: { win: false, excluded: null } }, ctx)).toEqual({ win: false, source: 'trade' });
  });
  it('uses the price label when no trade', () => {
    expect(resolveLabel({ ...row, outcome: { win: true, excluded: null } }, ctx)).toEqual({ win: true, source: 'price' });
  });
  it('excludes data from before the paper reset, suspicious mints and bad outcomes', () => {
    expect(resolveLabel({ ...row, createdAt: new Date('2026-10-04T00:00:00Z') }, ctx)).toEqual({ excluded: 'before_reset' });
    expect(resolveLabel({ ...row, mint: 'BAD' }, ctx)).toEqual({ excluded: 'suspicious_fill' });
    expect(resolveLabel({ ...row, outcome: { win: true, excluded: 'implausible_multiple' } }, ctx)).toEqual({ excluded: 'implausible_multiple' });
    expect(resolveLabel({ ...row, outcomeMax: 40 }, ctx)).toEqual({ excluded: 'implausible_multiple' });
  });
  it('legacy rows: win only if the drawdown floor was never hit', () => {
    expect(resolveLabel({ ...row }, ctx)).toEqual({ win: true, source: 'price' });
    expect(resolveLabel({ ...row, outcomeMin: 0.5 }, ctx)).toEqual({ win: false, source: 'price' });
  });
});

describe('learningSince', () => {
  it('reads the paper reset marker', async () => {
    expect(await learningSince({ get: async () => '2026-10-05T00:00:00.000Z' } as never)).toEqual(new Date('2026-10-05T00:00:00Z'));
    expect(await learningSince({ get: async () => null } as never)).toBeNull();
    expect(await learningSince({ get: async () => 'garbage' } as never)).toBeNull();
    expect(await learningSince({ get: async () => { throw new Error('down'); } } as never)).toBeNull();
  });
});
