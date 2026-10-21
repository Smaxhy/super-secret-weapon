/** v27.1 (owner: "remove the less profitable bots"): every live row must clear the profit floor. */
import { describe, expect, it } from 'vitest';
import { FX_CONFIG, profitFloor } from '../src/forex/lab';
import { chosenOf } from '../src/forex/fast';

const st = (n: number, avgR: number, pf: number | null) => ({ n, winPct: 50, avgR, medianR: 0, pf, totalR: n * avgR, maxDdR: 0 });
const row = (id: string, verdict: 'edge' | 'maybe' | 'no', out: ReturnType<typeof st>, inS = st(100, 0.1, 1.3)) => ({ id, tf: '15m', verdict, outSample: out, inSample: inS });

describe('v27.1 profit floor', () => {
  it('needs 30+ unseen trades, 0.05R+ a trade, PF 1.2+ and a positive first part', () => {
    expect(profitFloor({ outSample: st(45, 0.42, 2.69), inSample: st(60, 0.1, 1.3) }).ok).toBe(true); // rsi_dip:4h (coins)
    expect(profitFloor({ outSample: st(982, 0.04, 1.11), inSample: st(1800, 0.04, 1.1) }).why).toMatch(/0\.04R/); // trendline_break
    expect(profitFloor({ outSample: st(208, 0.06, 1.15), inSample: st(400, 0.1, 1.2) }).why).toMatch(/profit factor 1\.15/);
    expect(profitFloor({ outSample: st(29, 0.11, 1.37), inSample: st(60, 0.1, 1.3) }).why).toMatch(/only 29/);
    expect(profitFloor({ outSample: st(380, 0.06, 1.66), inSample: st(600, -0.02, 0.95) }).why).toMatch(/before the 70\/30 line/);
    expect(profitFloor({}).ok).toBe(true); // an old report without stats
  });

  it('owner picks and Maybe rows below the floor are not chosen; a row that clears it is', () => {
    const rows = [
      row('judas_swing', 'no', st(114, -0.45, 0.39)),
      row('keltner', 'maybe', st(2177, 0.04, 1.08)),
      row('news_fade', 'maybe', st(208, 0.24, 1.67)),
      row('amd_daily', 'no', st(340, 0.08, 1.25)),
    ];
    expect(chosenOf(rows, [], FX_CONFIG.ownerLive)).toEqual(['news_fade:15m', 'amd_daily:15m']);
  });

  it('can be switched off', () => {
    FX_CONFIG.profitFloor.on = false;
    try {
      expect(profitFloor({ outSample: st(5, -1, 0.1), inSample: st(5, -1, 0.1) }).ok).toBe(true);
    } finally {
      FX_CONFIG.profitFloor.on = true;
    }
  });
});

describe('v27.2 market plan: specific strategies for specific markets', () => {
  it('NAS100 trades only Judas swing, judged on its own NAS100 record', async () => {
    const { planChosen, plannedStrategies } = await import('../src/forex/lab');
    expect(FX_CONFIG.marketPlan.NDXUSD).toEqual(['judas_swing']);
    expect(plannedStrategies().has('judas_swing')).toBe(true);
    expect(planChosen('judas_swing', 'NDXUSD', false, undefined)).toBe(true); // pooled row not chosen: still trades here
    expect(planChosen('judas_swing', 'NDXUSD', false, { n: 40, pf: 1.3 })).toBe(true);
    expect(planChosen('judas_swing', 'NDXUSD', false, { n: 40, pf: 0.8 })).toBe(false); // losing on NAS100 → off
    expect(planChosen('judas_swing', 'NDXUSD', false, { n: 10, pf: 0.5 })).toBe(true); // too few to judge
    expect(planChosen('judas_swing', 'NDXUSD', true, undefined, true)).toBe(false); // the learner dropped it
    expect(planChosen('ema_cross', 'NDXUSD', true, { n: 100, pf: 2 })).toBe(false); // not on NAS100's list
    expect(planChosen('ema_cross', 'EURUSD', true, undefined)).toBe(true); // other markets: the normal chooser
    expect(planChosen('judas_swing', 'EURUSD', false, undefined)).toBe(false);
  });

  it('the plan view says why a signal on a listed market is not traded', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/forex/plan.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/not on this market's list/);
  });
});

describe('v27.3 focus markets', () => {
  it('only gold, Nasdaq 100, S&P 500, USD/JPY and EUR/USD get new trades; coins are untouched', async () => {
    const { focusOk, focusPrio, planChosen } = await import('../src/forex/lab');
    expect(FX_CONFIG.focus.markets).toEqual(['XAUUSD', 'NDXUSD', 'SPXUSD', 'USDJPY', 'EURUSD']);
    for (const p of ['XAUUSD', 'NDXUSD', 'SPXUSD', 'USDJPY', 'EURUSD', 'BTCUSD']) expect(focusOk(p)).toBe(true);
    expect(focusOk('GBPUSD')).toBe(false);
    expect(planChosen('ema_cross', 'GBPUSD', true, undefined)).toBe(false);
    expect(planChosen('ema_cross', 'EURUSD', true, undefined)).toBe(true);
    expect(focusPrio('USDJPY', 0.1)).toBeGreaterThan(focusPrio('GBPUSD', 5));
    FX_CONFIG.focus.mode = 'prefer';
    try {
      expect(focusOk('GBPUSD')).toBe(true);
    } finally {
      FX_CONFIG.focus.mode = 'only';
    }
  });
});
