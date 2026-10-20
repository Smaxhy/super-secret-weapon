/** v22: crypto majors inside the forex engine — always open, USD-priced, forex-only rules excluded. */
import { describe, expect, it } from 'vitest';
import { CRYPTO, INSTRUMENTS, instrument, isCrypto } from '../src/forex/types';
import { CRYPTO_CLOCK, clockFor, marketClock, newsBlock, type CalEvent } from '../src/forex/calendar';
import { spreadMultAt } from '../src/forex/spreads';
import { dataAgeOf, lagBars } from '../src/forex/freshness';
import { NOT_FOR_CRYPTO, STRATEGIES, roundStep, runsOn } from '../src/forex/strategies';
import { pnlUsd, unitsFor } from '../src/forex/practice';
import { riskOfLong } from '../src/forex/mood';
import { classify, headlineBlock } from '../src/forex/headlines';

const SAT = Date.UTC(2026, 9, 17, 12, 0); // Saturday noon UTC: forex closed

describe('v22 crypto markets', () => {
  it('lists BTC / ETH / SOL as crypto instruments priced in USD', () => {
    for (const id of ['BTCUSD', 'ETHUSD', 'SOLUSD']) {
      expect(isCrypto(id)).toBe(true);
      expect(instrument(id)?.kind).toBe('crypto');
      expect(instrument(id)?.yahoo).toMatch(/-USD$/);
    }
    expect(isCrypto('EURUSD')).toBe(false);
    expect(isCrypto('XAUUSD')).toBe(false);
    expect(INSTRUMENTS.filter((i) => i.kind === 'crypto')).toHaveLength(8);
    expect(CRYPTO.maxLeverage).toBeLessThanOrEqual(30);
  });

  it('a coin market is open on the weekend while forex is closed', () => {
    expect(marketClock(SAT).open).toBe(false);
    const c = clockFor('BTCUSD', SAT);
    expect(c.open).toBe(true);
    expect(c.noNewTrades).toBe(false);
    expect(c.flattenNow).toBe(false);
    expect(c.rollover).toBe(false);
    expect(c).toBe(CRYPTO_CLOCK);
    expect(clockFor('EURUSD', SAT).open).toBe(false);
    expect(clockFor(null, SAT).open).toBe(false);
  });

  it('coin candles are expected every hour, incl. the weekend; forex ones are not', () => {
    const H = 3_600_000;
    const now = SAT + 6 * H;
    // last bar 6 hours ago: a coin is 6 bars behind, EUR/USD is 0 (the market was closed all along)
    expect(lagBars('BTCUSD', SAT, now, H)).toBeGreaterThanOrEqual(5);
    expect(lagBars('EURUSD', SAT, now, H)).toBe(0);
    expect(dataAgeOf('EURUSD', '1h', [{ t: SAT - H, o: 1, h: 1, l: 1, c: 1 }], now, H).status).toBe('closed');
    expect(dataAgeOf('BTCUSD', '1h', [{ t: now - 2 * H, o: 1, h: 1, l: 1, c: 1 }], now, H).status).toBe('fresh');
  });

  it('no rollover / weekend spread widening on a coin', () => {
    const t = Date.UTC(2026, 9, 19, 21, 30); // 21:30 UTC = the rollover hour
    expect(spreadMultAt('EURUSD', t, t - 3_600_000)).toBeGreaterThan(1);
    expect(spreadMultAt('BTCUSD', t, t - 3_600_000)).toBe(1);
    expect(spreadMultAt('BTCUSD', t, t - 60 * 3_600_000)).toBe(1); // a 60-hour gap would be ×4 on forex
  });

  it('forex-only rules never run on a coin; the rest do', () => {
    const byId = new Map(STRATEGIES.map((s) => [s.id, s]));
    for (const id of NOT_FOR_CRYPTO) {
      const s = byId.get(id);
      if (!s) continue; // a rule that no longer exists is simply not listed
      expect(runsOn(s, '1h', 'BTCUSD')).toBe(false);
      expect(runsOn(s, '1h', 'EURUSD')).toBe(runsOn(s, '1h'));
    }
    const ema = byId.get('ema_cross')!;
    expect(runsOn(ema, '1h', 'BTCUSD')).toBe(true);
    expect(runsOn(ema, '4h', 'ETHUSD')).toBe(true);
    // enough rules are left for the lab to grade on a coin
    const left = STRATEGIES.filter((s) => s.id !== 'random' && runsOn(s, '1h', 'BTCUSD')).length;
    expect(left).toBeGreaterThanOrEqual(20);
  });

  it('round numbers per coin', () => {
    expect(roundStep('BTCUSD')).toBe(1000);
    expect(roundStep('ETHUSD')).toBe(100);
    expect(roundStep('SOLUSD')).toBe(10);
    expect(roundStep('EURUSD')).toBe(0.01);
  });

  it('units and P&L of a coin position are in USD, 1 unit = 1 coin', () => {
    const btc = instrument('BTCUSD')!;
    const mids = { BTCUSD: 50_000, EURUSD: 1.1 };
    expect(unitsFor(btc, 10_000, mids)).toBeCloseTo(0.2, 6);
    expect(pnlUsd({ pair: 'BTCUSD', side: 1, units: 0.2, entry: 50_000 }, 51_000, mids)).toBeCloseTo(200, 6);
    expect(pnlUsd({ pair: 'BTCUSD', side: -1, units: 0.2, entry: 50_000 }, 51_000, mids)).toBeCloseTo(-200, 6);
  });

  it('coins are risk-on for the mood check and tagged by the news reader', () => {
    expect(riskOfLong('BTCUSD')).toBeGreaterThan(1);
    expect(classify('Bitcoin jumps as the SEC approves a spot ETF').ccys).toContain('BTC');
    expect(classify('Solana outage: validators restart the network').ccys).toContain('SOL');
    expect(classify('ECB holds rates').ccys).not.toContain('BTC');
    const now = Date.now();
    const h = { t: now - 5 * 60_000, title: 'Breaking: Bitcoin plunges 8% in minutes', link: '', source: 'x', ccys: ['BTC'], severity: 'high' as const, why: 'breaking' };
    expect(headlineBlock('BTCUSD', now, [h])).toContain('headline');
    expect(headlineBlock('EURUSD', now, [h])).toBeNull();
  });

  it('a USD bank holiday does not pause a coin, USD news still does', () => {
    const now = Date.UTC(2026, 9, 12, 14, 0);
    const holiday: CalEvent = { t: Date.UTC(2026, 9, 12, 0, 0), ccy: 'USD', title: 'Columbus Day', impact: 'Holiday' } as CalEvent;
    const cpi: CalEvent = { t: now + 10 * 60_000, ccy: 'USD', title: 'CPI m/m', impact: 'High' } as CalEvent;
    expect(newsBlock('EURUSD', now, [holiday])).toContain('holiday');
    expect(newsBlock('BTCUSD', now, [holiday])).toBeNull();
    expect(newsBlock('BTCUSD', now, [cpi])).toContain('USD news');
  });
});

describe('v24.2 the coin account through the close / reset routes', () => {
  it('no route maps the coin account (cbot) onto the owner account', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/api/server.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/=== 'bot' \? 'bot' : 'me'/);
    expect(src.split("acctParam(req.body?.acct, 'me')").length - 1).toBeGreaterThanOrEqual(2); // close + reset
  });
});
