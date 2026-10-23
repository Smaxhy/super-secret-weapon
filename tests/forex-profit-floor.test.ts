/** v27.1 (owner: "remove the less profitable bots"): every live row must clear the profit floor. */
import { describe, expect, it } from 'vitest';
import { FX_CONFIG, profitFloor } from '../src/forex/lab';

FX_CONFIG.provenOnly.on = false; // v27.27 default: only Edge rows trade; these tests pin the older choosers
import { chosenOf } from '../src/forex/fast';

// v27.19 default is 'prefer'; these tests pin the v27.3 focus-only mode
FX_CONFIG.focus.mode = 'only';

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
    const keep = FX_CONFIG.marketPlan;
    FX_CONFIG.marketPlan = { NDXUSD: ['judas_swing'] }; // v27.13: empty by default; the mechanism stays
    expect(plannedStrategies().has('judas_swing')).toBe(true);
    expect(planChosen('judas_swing', 'NDXUSD', false, undefined)).toBe(true); // pooled row not chosen: still trades here
    expect(planChosen('judas_swing', 'NDXUSD', false, { n: 40, pf: 1.3 })).toBe(true);
    expect(planChosen('judas_swing', 'NDXUSD', false, { n: 40, pf: 0.8 })).toBe(false); // losing on NAS100 → off
    expect(planChosen('judas_swing', 'NDXUSD', false, { n: 10, pf: 0.5 })).toBe(true); // too few to judge
    expect(planChosen('judas_swing', 'NDXUSD', true, undefined, true)).toBe(false); // the learner dropped it
    expect(planChosen('ema_cross', 'NDXUSD', true, { n: 100, pf: 2 })).toBe(false); // not on NAS100's list
    expect(planChosen('ema_cross', 'EURUSD', true, undefined)).toBe(true); // other markets: the normal chooser
    expect(planChosen('judas_swing', 'EURUSD', false, undefined)).toBe(false);
    FX_CONFIG.marketPlan = keep;
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

describe('v27.7 strongest vs weakest currencies join the focus list', () => {
  // the owner's screenshot, Oct 21: GBP +0.52, CAD +0.48, NZD +0.44, AUD +0.36, CHF +0.09, EUR −0.08, JPY −0.33, USD −0.67
  const now = { ccys: [['GBP', 0.52], ['CAD', 0.48], ['NZD', 0.44], ['AUD', 0.36], ['CHF', 0.09], ['EUR', -0.08], ['JPY', -0.33], ['USD', -0.67]].map(([ccy, score]) => ({ ccy: ccy as string, score: score as number, today: 0, week: 0 })) };
  it('adds the traded pairs of a top-2 currency against a bottom-2 one, and the bot may trade them', async () => {
    const { strongPairs, setStrongFocus, focusMarkets, focusOk } = await import('../src/forex/lab');
    expect(strongPairs(now).sort()).toEqual(['GBPJPY', 'GBPUSD', 'USDCAD']);
    setStrongFocus(now);
    try {
      expect(focusOk('GBPUSD')).toBe(true);
      expect(focusOk('AUDUSD')).toBe(false); // AUD is not top-2
      expect(focusMarkets()).toEqual(['XAUUSD', 'NDXUSD', 'SPXUSD', 'USDJPY', 'EURUSD', 'GBPUSD', 'USDCAD', 'GBPJPY']);
    } finally {
      setStrongFocus(null);
    }
    expect(focusOk('GBPUSD')).toBe(false);
  });
});

describe('v27.9 trial bar on the focus markets (gold)', () => {
  const cell = (o: Partial<import('../src/forex/montecarlo').MarketCell> = {}) => ({ pair: 'XAUUSD', inN: 15, inAvgR: 0.04, n: 26, avgR: 0.12, pf: 1.4, winPct: 45, mcP: 0.9, mcP5: -0.05, sess: [], ...o });
  it('a strategy that clears the looser bar on gold trades there (not on a coin), at half size', async () => {
    const { planChosen, focusTrial } = await import('../src/forex/lab');
    const { cellPass, cellTry } = await import('../src/forex/montecarlo');
    expect(cellPass(cell())).toBe(false); // 26 unseen trades: short of the full market bar
    expect(cellTry(cell())).toBe(true);
    expect(focusTrial('XAUUSD', cell())).toBe(true);
    expect(planChosen('cci_break', 'XAUUSD', false, undefined, false, cell())).toBe(true);
    expect(planChosen('cci_break', 'XAUUSD', false, undefined, true, cell())).toBe(false); // the learner dropped it
    expect(focusTrial('BTCUSD', cell({ pair: 'BTCUSD' }))).toBe(false); // coins keep the full bar
    expect(focusTrial('XAUUSD', cell({ inAvgR: -0.08 }))).toBe(false); // lost before the line (psar_adx on gold)
    expect(focusTrial('XAUUSD', cell({ mcP: 0.7 }))).toBe(false);
    expect(focusTrial('XAUUSD', cell({ n: 40, inN: 25, mcP: 0.97 }))).toBe(false); // clears the full bar → full size, not a trial
  });
});

describe('v27.10 a strategy proven on a market trades there past the focus list and the market plan', () => {
  const cell = (pair: string, o: Partial<import('../src/forex/montecarlo').MarketCell> = {}) => ({ pair, inN: 186, inAvgR: 0.05, n: 106, avgR: 0.19, pf: 2.47, winPct: 62, mcP: 1, mcP5: 0.1, sess: [], ...o });
  it('Russell 2000 (not a focus market) and Nasdaq 100 (Judas-only plan) open to pivot_bounce 4h; others stay shut', async () => {
    const { planChosen, provenCells, focusOk, FX_CONFIG } = await import('../src/forex/lab');
    const keep = FX_CONFIG.marketPlan;
    FX_CONFIG.marketPlan = { NDXUSD: ['judas_swing'] };
    expect(focusOk('RUTUSD')).toBe(false);
    expect(planChosen('pivot_bounce', 'RUTUSD', true, undefined, false, cell('RUTUSD'))).toBe(true);
    expect(planChosen('pivot_bounce', 'RUTUSD', true, undefined, false, cell('RUTUSD', { mcP: 0.5 }))).toBe(false); // unproven there: focus rule
    expect(planChosen('pivot_bounce', 'DJIUSD', false, undefined, false, cell('DJIUSD', { n: 84, avgR: 0.11, pf: 1.66, mcP: 0.9 }))).toBe(true); // trial
    expect(planChosen('pivot_bounce', 'NDXUSD', true, undefined, false, cell('NDXUSD'))).toBe(true);
    expect(planChosen('pivot_bounce', 'NDXUSD', true, undefined, true, cell('NDXUSD'))).toBe(false); // the learner dropped it
    expect(planChosen('ema_cross', 'NDXUSD', true, undefined, false, null)).toBe(false); // plan still rules unproven ones
    expect(planChosen('judas_swing', 'NDXUSD', false, undefined)).toBe(true);
    FX_CONFIG.marketPlan = keep;
    expect(provenCells([{ id: 'pivot_bounce', tf: '4h', markets: [cell('RUTUSD'), cell('EURUSD', { mcP: 0.5 })] }, { id: 'random', tf: '1h', markets: [cell('RUTUSD')] }])).toEqual({ RUTUSD: ['pivot_bounce:4h'] });
  });
});

describe('v27.11 owner trial: Judas swing on the Nasdaq hourly at a quarter size', () => {
  it('trades on NDX 1h despite a losing record; not on 15m, not elsewhere, not once the learner drops it', async () => {
    const { planChosen, ownerTrialOf } = await import('../src/forex/lab');
    expect(ownerTrialOf('judas_swing', '1h', 'NDXUSD')?.sizeF).toBe(0.25);
    expect(planChosen('judas_swing', 'NDXUSD', false, { n: 172, pf: 0.89 }, false, null, '1h')).toBe(true);
    expect(planChosen('judas_swing', 'NDXUSD', false, { n: 172, pf: 0.89 }, false, null, '15m')).toBe(false); // plan's losing rule
    expect(planChosen('judas_swing', 'EURUSD', false, undefined, false, null, '1h')).toBe(false);
    expect(planChosen('judas_swing', 'NDXUSD', false, { n: 172, pf: 0.89 }, true, null, '1h')).toBe(false);
  });
});

describe('v27.12 owner trials on every forex market: month-end flow 1h + pin bar 4h at a quarter size', () => {
  it('trade on any forex market, never on a coin, not on another chart', async () => {
    const { planChosen, ownerTrialOf } = await import('../src/forex/lab');
    expect(ownerTrialOf('month_end_flow', '1h', 'EURUSD')?.sizeF).toBe(0.25);
    expect(ownerTrialOf('pin_bar', '4h', 'GBPJPY')?.sizeF).toBe(0.25);
    expect(planChosen('pin_bar', 'RUTUSD', false, undefined, false, null, '4h')).toBe(true);
    expect(planChosen('pin_bar', 'BTCUSD', false, undefined, false, null, '4h')).toBe(false);
    expect(planChosen('pin_bar', 'EURUSD', false, undefined, false, null, '1h')).toBe(false);
    expect(planChosen('month_end_flow', 'USDJPY', false, undefined, true, null, '1h')).toBe(false); // learner dropped it
  });
});

describe('v27.13 a strategy that works on a market across all its tested trades trades there at half size', () => {
  const cell = (o: Partial<import('../src/forex/montecarlo').MarketCell> = {}) => ({ pair: 'RUTUSD', inN: 40, inAvgR: -0.05, n: 15, avgR: 0.04, pf: 1.1, winPct: 50, mcP: 0.6, mcP5: -0.2, sess: [], ...o });
  it('needs 30+ trades, PF 1.2+, +5R and an unseen part that is not losing; never a coin', async () => {
    const { planChosen, workTrial, FX_CONFIG } = await import('../src/forex/lab');
    const rec = { n: 120, pf: 1.6, totalR: 42 };
    expect(workTrial('RUTUSD', cell(), rec)).toBe(true);
    expect(planChosen('pin_bar', 'RUTUSD', false, rec, false, cell(), '1h')).toBe(true);
    expect(workTrial('RUTUSD', cell({ avgR: -0.02 }), rec)).toBe(false); // losing on unseen trades
    expect(workTrial('RUTUSD', cell(), { n: 120, pf: 1.1, totalR: 42 })).toBe(false);
    expect(workTrial('RUTUSD', cell(), { n: 120, pf: 1.6, totalR: 3 })).toBe(false);
    expect(workTrial('BTCUSD', cell({ pair: 'BTCUSD' }), rec)).toBe(false);
    expect(planChosen('pin_bar', 'RUTUSD', false, rec, true, cell(), '1h')).toBe(false); // learner dropped it
    expect(FX_CONFIG.marketPlan).toEqual({}); // the Nasdaq trades everything that works there
  });
});
