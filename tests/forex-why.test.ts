import { describe, expect, it } from 'vitest';
import { classify, whyNoTrades, type WhyInput } from '../src/forex/why';

const H = 3_600_000;
const now = Date.UTC(2026, 9, 20, 8, 0);
const base = (): WhyInput => ({
  now,
  runs: [],
  log: [],
  lastSync: {},
  chosen: ['ema_cross:1h', 'tsmom:4h'],
  lastOpenedAt: now - 7 * H,
  openNow: 0,
  ordersNow: 0,
  clock: { open: true, noNewTrades: false, rollover: false, sinceOpenMin: 900 },
  dataAge: {},
  labError: null,
});
const run = (t: number, signals: number, chosen: number, opened = 0, skipped = 0, waits = 0) => ({ t, tf: '1h', signals, chosen, opened, skipped, waits, holding: 0, note: '' });

describe('why no trades (v19.4)', () => {
  it('classifies the bot log wording into reason buckets', () => {
    expect(classify('waiting on EURUSD (ema_cross): it just closed a trade here — cooling off 120 min')).toBe('cooldown');
    expect(classify('skipped GBPUSD (tsmom): the signal judge gives it a 31% chance (needs 45%)')).toBe('judge_no');
    expect(classify('waiting on GBPUSD (tsmom): the signal judge is missing cot, carry')).toBe('judge_missing');
    expect(classify('waited on USDJPY (macd): JPY news: BoJ rate decision')).toBe('news');
    expect(classify('EURUSD 1h prices are 3 h old (3 candles behind — the price feed is lagging): no new trades on it')).toBe('stale_feed');
    expect(classify('skipped AUDUSD (ema_cross): already 2.3% of the account riding on USD')).toBe('ccy_cap');
    expect(classify('price moved 0.45R its way since the signal (chasing; ≤ 0.3R)')).toBe('late');
    expect(classify('its mood check has no data right now (feed missing): waiting rather than trading it untested')).toBe('check_data');
  });

  it('says the hourly check is stuck when no run landed in 2.5 h', () => {
    const r = whyNoTrades({ ...base(), runs: [run(now - 5 * H, 3, 1)] });
    expect(r.quiet).toBe(true);
    expect(r.verdict).toMatch(/has not run for 5\.0 h/);
    expect(r.hint).toMatch(/restart/i);
  });

  it('blames the chooser when signals fire but none belong to the traded strategies', () => {
    const r = whyNoTrades({ ...base(), runs: [run(now - 1 * H, 12, 0), run(now - 2 * H, 9, 0)] });
    expect(r.window.signals).toBe(21);
    expect(r.verdict).toMatch(/21 signals fired in 24 h, but none came from the 2 strategies the bot trades/);
    expect(r.reasons.map((x) => x.kind)).toEqual(['not_chosen']);
  });

  it('names the top hold-back reason from the log + sync reports', () => {
    const r = whyNoTrades({
      ...base(),
      runs: [run(now - 1 * H, 6, 4, 0, 1, 3), run(now - 2 * H, 5, 2, 0, 0, 2)],
      log: [
        { t: now - 1 * H, e: 'waiting on EURUSD (ema_cross): the signal judge is missing cot' },
        { t: now - 1 * H, e: 'waiting on GBPUSD (tsmom): the signal judge is missing cot' },
        { t: now - 2 * H, e: 'waiting on USDJPY (ema_cross): the signal judge is missing cot' },
        { t: now - 2 * H, e: 'skipped AUDUSD (tsmom): already 2.3% of the account riding on USD' },
        { t: now - 30 * H, e: 'waiting on EURUSD (ema_cross): the signal judge is missing cot' }, // outside the window
      ],
      lastSync: { '1h': { at: now - 1 * H, candidates: 4, opened: 0, heldOpen: 0, skipped: [], waits: [{ pair: 'NZDUSD', strategy: 'tsmom', tf: '4h', side: 1, why: "the signal judge can't score it: missing cot" }] } },
    });
    expect(r.reasons[0]).toMatchObject({ kind: 'judge_missing', n: 4 });
    expect(r.verdict).toMatch(/6 tradeable signals in 24 h, 0 opened\. Main reason it held back: the signal judge had a reading missing/);
    expect(r.hint).toMatch(/Data feeds/);
  });

  it('is not "quiet" with the market closed or a trade opened recently', () => {
    expect(whyNoTrades({ ...base(), clock: { open: false, noNewTrades: true, minutesToChange: 600 } }).quiet).toBe(false);
    const r = whyNoTrades({ ...base(), lastOpenedAt: now - 20 * 60_000, openNow: 1, runs: [run(now - H, 2, 1, 1)] });
    expect(r.quiet).toBe(false);
    expect(r.verdict).toMatch(/Last trade opened: 20 min ago · 1 open now/);
  });

  it('puts a failing lab first and lists lagging feeds', () => {
    const r = whyNoTrades({
      ...base(),
      runs: [run(now - H, 0, 0)],
      labError: { t: now - 10 * 60_000, msg: 'out of memory' },
      dataAge: { EURUSD: { id: 'EURUSD', tf: '1h', lastT: now - 4 * H, lagBars: 3, status: 'stale' } as never },
    });
    expect(r.verdict).toMatch(/FAILING: out of memory/);
    expect(r.staleMarkets).toEqual(['EURUSD']);
    expect(r.verdict).toMatch(/lagging on 1 market \(EURUSD\)/);
  });
});
