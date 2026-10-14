import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config/default';
import { reentryVerdict } from '../src/executor/trader';

const sw = DEFAULT_CONFIG.focus.swing;
const NOW = 1_800_000_000_000;
const min = 60_000;
const closed = (agoMin: number, pnlSol: number, exitReason = 'TRAILING_STOP') => ({ status: 'CLOSED', closedAtMs: NOW - agoMin * min, exitReason, pnlSol });

describe('re-buying a coin it traded before', () => {
  it('scanner re-signal on a coin it made money on: once more after 30 min', () => {
    expect(reentryVerdict([closed(10, 0.05)], NOW, { strategy: 'MIGRATION_MOMENTUM', swingSignal: false }, sw).refuse).toMatch(/re-buy after 30 min/);
    expect(reentryVerdict([closed(45, 0.05)], NOW, { strategy: 'MIGRATION_MOMENTUM', swingSignal: false }, sw)).toEqual({ refuse: null, learning: false });
    expect(reentryVerdict([closed(90, 0.05), closed(45, 0.02)], NOW, { strategy: 'SOON', swingSignal: false }, sw).refuse).toMatch(/used up/);
  });
  it('after a loss: only a rebound setup, after 60 min, as a learning trade', () => {
    expect(reentryVerdict([closed(90, -0.03, 'STOP_LOSS')], NOW, { strategy: 'MIGRATION_MOMENTUM', swingSignal: false }, sw).refuse).toMatch(/only a rebound/);
    expect(reentryVerdict([closed(30, -0.03, 'STOP_LOSS')], NOW, { strategy: 'MIGRATION_MOMENTUM', swingSignal: true }, sw).refuse).toMatch(/rebound re-buy after 60 min/);
    expect(reentryVerdict([closed(70, -0.03, 'STOP_LOSS')], NOW, { strategy: 'MIGRATION_MOMENTUM', swingSignal: true }, sw)).toEqual({ refuse: null, learning: true });
    expect(reentryVerdict([closed(70, -0.03, 'STOP_LOSS')], NOW, { strategy: 'MIGRATION_MOMENTUM', swingSignal: true }, { ...sw, reboundAfterLoss: { enabled: false, cooldownMin: 60 } }).refuse).toMatch(/only a rebound/);
  });
  it('never after a rug, never while holding, never for other strategies', () => {
    expect(reentryVerdict([closed(500, -0.05, 'RUG_DETECTED')], NOW, { strategy: 'SOON', swingSignal: true }, sw).refuse).toMatch(/rugged/);
    expect(reentryVerdict([{ status: 'OPEN', closedAtMs: null, exitReason: null, pnlSol: 0 }], NOW, { strategy: 'SOON', swingSignal: true }, sw).refuse).toMatch(/still holding/);
    expect(reentryVerdict([closed(500, 0.05)], NOW, { strategy: 'SMART_MONEY_COPY', swingSignal: false }, sw).refuse).toBe('already traded this token');
  });
});
