import { describe, expect, it } from 'vitest';
import { DEFAULT_PUSH_SETTINGS, isSubscription, messageFor } from '../src/lib/push';

const sell = (o: Record<string, unknown>) => ({ mint: 'm', symbol: 'PEPE', side: 'SELL', mode: 'PAPER', amountSol: 0.3, reason: 'TRAILING_STOP: trail broke', ...o });

describe('phone notifications', () => {
  it('a trade closing in profit says how much it made', () => {
    const m = messageFor(sell({ closed: true, totalPnlSol: 0.1234, peakMultiple: 1.8 }), DEFAULT_PUSH_SETTINGS)!;
    expect(m.title).toBe('💰 $PEPE closed +0.123 SOL (paper)');
    expect(m.body).toMatch(/trailing stop · peak 1.80x/);
    expect(m.url).toBe('/history');
  });
  it('losses and partial take-profits only when switched on; small profits filtered by the minimum', () => {
    expect(messageFor(sell({ closed: true, totalPnlSol: -0.05 }), DEFAULT_PUSH_SETTINGS)).toBeNull();
    expect(messageFor(sell({ closed: true, totalPnlSol: -0.05 }), { ...DEFAULT_PUSH_SETTINGS, lossClose: true })!.title).toMatch(/−0.050 SOL/);
    expect(messageFor(sell({ closed: false, pnlSol: 0.02 }), DEFAULT_PUSH_SETTINGS)).toBeNull();
    expect(messageFor(sell({ closed: false, pnlSol: 0.02 }), { ...DEFAULT_PUSH_SETTINGS, takeProfit: true })!.title).toMatch(/took profit/);
    expect(messageFor(sell({ closed: true, totalPnlSol: 0.01 }), { ...DEFAULT_PUSH_SETTINGS, minProfitSol: 0.05 })).toBeNull();
    expect(messageFor({ ...sell({}), side: 'BUY' }, DEFAULT_PUSH_SETTINGS)).toBeNull();
  });
  it('only accepts real browser push subscriptions', () => {
    expect(isSubscription({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'a', auth: 'b' } })).toBe(true);
    expect(isSubscription({ endpoint: 'http://evil', keys: { p256dh: 'a', auth: 'b' } })).toBe(false);
    expect(isSubscription({ endpoint: 'https://x' })).toBe(false);
  });
});
