import { describe, expect, it } from 'vitest';
import { classify, headlineBlock, parseRss, priceShock } from '../src/forex/headlines';
import { newsBlock, parseCalendar } from '../src/forex/calendar';

describe('forex headlines + shocks', () => {
  it('tags currencies and severity', () => {
    expect(classify('Trump says new tariffs on EU goods start Monday')).toMatchObject({ severity: 'high' });
    expect(classify('Trump says new tariffs on EU goods start Monday').ccys).toEqual(expect.arrayContaining(['USD', 'EUR']));
    expect(classify('BOJ Ueda: will keep policy loose').ccys).toContain('JPY');
    expect(classify('Japan finance minister warns on yen moves').ccys).toContain('JPY');
    expect(classify('Australian retail sales in line with estimates').severity).toBe('normal');
  });

  it('parses RSS and blocks a pair for 30 min after a big headline', () => {
    const now = Date.parse('2026-10-20T14:00:00Z');
    const xml = `<rss><channel><item><title><![CDATA[BREAKING: Fed's Powell signals surprise rate cut]]></title><link>https://x/1</link><pubDate>Tue, 20 Oct 2026 13:50:00 GMT</pubDate></item><item><title>Copper edges higher</title><link>https://x/2</link><pubDate>Tue, 20 Oct 2026 13:55:00 GMT</pubDate></item></channel></rss>`;
    const items = parseRss(xml, 'test');
    expect(items).toHaveLength(2);
    expect(headlineBlock('EURUSD', now, items)).toMatch(/headline/);
    expect(headlineBlock('XAUUSD', now, items)).toMatch(/headline/);
    expect(headlineBlock('EURGBP', now, items)).toBeNull();
    expect(headlineBlock('EURUSD', now + 45 * 60_000, items)).toBeNull();
  });

  it('calendar speeches count, price shocks are detected', () => {
    const ev = parseCalendar([{ title: 'President Trump Speaks', country: 'USD', date: '2026-10-20T10:00:00-04:00', impact: 'Medium' }]);
    expect(newsBlock('USDJPY', Date.parse('2026-10-20T14:10:00Z'), ev)).toMatch(/speech/);
    const calm = Array.from({ length: 15 }, (_, i) => [i, 1.1002, 1.0998, 1.1] as const);
    const wild = [...calm.slice(0, 10), [11, 1.106, 1.1, 1.105] as const];
    expect(priceShock(calm, 0.002)).toBe(false);
    expect(priceShock(wild, 0.002)).toBe(true);
  });
});
