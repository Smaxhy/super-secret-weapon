import { describe, expect, it } from 'vitest';
import { marketClock, newsBlock, parseCalendar } from '../src/forex/calendar';

describe('forex calendar + clock', () => {
  it('parses ForexFactory JSON and blocks around high-impact news and holidays', () => {
    const ev = parseCalendar([
      { title: 'Non-Farm Employment Change', country: 'USD', date: '2026-11-06T08:30:00-05:00', impact: 'High', forecast: '150K', previous: '120K' },
      { title: 'Bank Holiday', country: 'JPY', date: '2026-11-03T00:00:00-05:00', impact: 'Holiday', forecast: '', previous: '' },
      { title: 'junk', country: 'X', date: 'nope', impact: 'High' },
    ]);
    expect(ev).toHaveLength(2);
    const nfp = Date.parse('2026-11-06T13:30:00Z');
    expect(newsBlock('EURUSD', nfp - 20 * 60_000, ev)).toMatch(/USD news/);
    expect(newsBlock('XAUUSD', nfp + 10 * 60_000, ev)).toMatch(/USD news/);
    expect(newsBlock('EURGBP', nfp, ev)).toBeNull();
    expect(newsBlock('EURUSD', nfp - 90 * 60_000, ev)).toBeNull();
    expect(newsBlock('USDJPY', Date.parse('2026-11-03T12:00:00Z'), ev)).toMatch(/holiday/);
  });

  it('knows when forex is open, the last hours before the weekly close and the weekend', () => {
    // Sunday 18 Oct 2026 12:00 UTC: closed
    expect(marketClock(Date.parse('2026-10-18T12:00:00Z')).open).toBe(false);
    // Monday 10:00 UTC: open, London session
    const mon = marketClock(Date.parse('2026-10-19T10:00:00Z'));
    expect(mon.open).toBe(true);
    expect(mon.sessions).toContain('London');
    expect(mon.noNewTrades).toBe(false);
    // Friday 23 Oct 20:40 UTC = 16:40 New York (EDT): 20 min to the close → flatten
    const fri = marketClock(Date.parse('2026-10-23T20:40:00Z'));
    expect(fri.open).toBe(true);
    expect(fri.noNewTrades).toBe(true);
    expect(fri.flattenNow).toBe(true);
    // Friday 21:30 UTC: closed
    expect(marketClock(Date.parse('2026-10-23T21:30:00Z')).open).toBe(false);
    // Sunday 25 Oct 21:30 UTC = 17:30 NY: open again
    expect(marketClock(Date.parse('2026-10-25T21:30:00Z')).open).toBe(true);
  });
});
