import { describe, expect, it } from 'vitest';
import { marketTags, mergeWorld, worldAlarms, worldBlock, worldTag, WORLD, type WorldItem } from '../src/forex/world';
import { headlineBlock, parseRss, type Headline } from '../src/forex/headlines';
import { flowDrawings } from '../src/forex/drawings';
import { buildCtx } from '../src/forex/ta';

const NOW = Date.parse('2026-10-26T12:00:00Z');
const M = 60_000;
const item = (title: string, minAgo: number, source: string): WorldItem => ({ t: NOW - minAgo * M, title, link: '', source, ...worldTag(title) });

describe('v27.39 world events', () => {
  it('tags kinds, the markets they move and critical headlines', () => {
    const t = worldTag('Oil tanker hit by missile in the Strait of Hormuz, Iran blamed');
    expect(t.kinds).toEqual(expect.arrayContaining(['conflict', 'shipping']));
    expect(t.critical).toBe(true);
    expect(t.markets).toEqual(expect.arrayContaining(['CAD', 'XAU', 'JPY', 'NDX']));
    expect(worldTag('Premier League results: Arsenal win again').kinds).toEqual([]);
    expect(worldTag('Earthquake of magnitude 7.4 strikes off Japan').markets).toContain('JPY');
  });

  it('raises an alarm on a burst (3+ headlines, 2+ sources, double the usual) and pauses the markets it moves', () => {
    const items = [item('Missiles fired at Israeli city', 40, 'aljazeera.com'), item('Israel vows retaliation after missile barrage', 20, 'bbc.co.uk'), item('Airstrikes hit Lebanon as escalation fears grow', 5, 'theguardian.com')];
    const a = worldAlarms(items, NOW);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ kind: 'conflict', count: 3, sources: 3, critical: false });
    expect(a[0]!.until).toBe(NOW - 5 * M + WORLD.holdMin * M);
    expect(worldBlock('USDJPY', NOW, a)).toMatch(/^world event \(war/);
    expect(worldBlock('XAUUSD', NOW, a)).not.toBeNull();
    expect(worldBlock('USDCAD', NOW, a)).not.toBeNull(); // Middle East → oil → CAD
    expect(worldBlock('EURGBP', NOW, a)).toBeNull();
    expect(worldBlock('USDJPY', NOW + 50 * M, a)).toBeNull(); // 45 min after the last headline it ends
  });

  it('no alarm when the same news flow is just usual; one critical headline is enough', () => {
    // a steady war-news day: 3 an hour for the last 20 hours
    const usual = Array.from({ length: 60 }, (_, k) => item(`War update number ${k}`, 40 + k * 20, k % 2 ? 'bbc.co.uk' : 'dw.com'));
    const now3 = [item('War update A', 30, 'bbc.co.uk'), item('War update B', 20, 'dw.com'), item('War update C', 10, 'aljazeera.com')];
    // the stream's first hours (20 h ago) were a burst — long over; now 3 more an hour is just the usual
    expect(worldAlarms([...usual, ...now3], NOW, 24).filter((a) => a.until >= NOW)).toHaveLength(0);
    const crit = worldAlarms([item('Houthis seize tanker in the Red Sea', 3, 'oilprice.com')], NOW);
    expect(crit[0]).toMatchObject({ kind: 'shipping', critical: true, count: 1 });
    expect(worldBlock('USDCAD', NOW, crit)).toMatch(/critical/);
  });

  it('market tags fix: 4-letter coins match their own headlines', () => {
    expect(marketTags('DOGEUSD')).toEqual(['DOGE', 'USD']);
    expect(marketTags('LINKUSD')).toEqual(['LINK', 'USD']);
    expect(marketTags('XAGUSD')).toEqual(['XAU', 'USD']);
    expect(marketTags('NDXUSD')).toEqual(['NDX', 'USD']);
    expect(marketTags('EURJPY')).toEqual(['EUR', 'JPY']);
    const h: Headline = { t: NOW - M, title: 'Dogecoin crash', link: '', source: 'x', ccys: ['DOGE'], severity: 'high', why: 'crash' };
    expect(headlineBlock('DOGEUSD', NOW, [h])).toMatch(/Dogecoin/);
  });

  it('reads RSS 1.0 dates, merges world items once, and draws the profile + channel', () => {
    const xml = '<rdf:RDF><item><title>Oil pipeline attacked in Libya</title><link>x</link><dc:date>2026-10-26T11:30:00Z</dc:date></item></rdf:RDF>';
    const got = parseRss(xml, 'dw.com');
    expect(got[0]!.t).toBe(Date.parse('2026-10-26T11:30:00Z'));
    const a = item('Refinery hit by drone strike', 5, 'oilprice.com');
    expect(mergeWorld([a], [a, item('Old war news', 5 * 24 * 60, 'bbc.co.uk')], NOW)).toHaveLength(1);
    const bars = Array.from({ length: 120 }, (_, k) => ({ t: k * 3_600_000, o: 100 + k * 0.1, h: 100.5 + k * 0.1, l: 99.5 + k * 0.1, c: 100.2 + k * 0.1, v: 100 }));
    const d = flowDrawings(buildCtx(bars, 60, 'NDXUSD'));
    expect(d.profile!.byVolume).toBe(true);
    expect(d.profile!.val).toBeLessThan(d.profile!.vah);
    expect(d.channel!.p2).toBeGreaterThan(d.channel!.p1); // rising line
    expect(d.read!.r2!).toBeGreaterThan(0.9);
  });
});
