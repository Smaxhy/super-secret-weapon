/**
 * "After big moves" study (v13). Every shock candle (see `shockDir`) on every traded market's hourly chart: how far the
 * price went in the shock's direction 1, 4, 12 and 24 hours later, in units of the normal hourly range (ATR). Positive
 * = the move kept going (drift), negative = it reversed (fade). Split by market, by the hour it happened and — once the
 * calendar history has built up — by the kind of news released in that hour (CPI, jobs, rate decisions, ...).
 * Pure; the lab runs it hourly.
 */
import type { CalEvent } from './calendar';
import { shockDir } from './strategies';
import type { Ctx } from './ta';

export const HORIZONS = [1, 4, 12, 24];

export interface StudyCell {
  n: number;
  /** average move in the shock's direction after each horizon, in ATRs */
  avgAtr: number[];
  /** % of shocks still beyond their close after each horizon */
  contPct: number[];
}

export interface NewsStudy {
  horizons: number[];
  shocks: number;
  overall: StudyCell;
  byHour: Array<{ key: string; label: string } & StudyCell>;
  byPair: Array<{ pair: string } & StudyCell>;
  byEvent: Array<{ key: string; label: string } & StudyCell>;
  recent: Array<{ pair: string; t: number; dir: 1 | -1; sizeAtr: number; moves: Array<number | null>; event: string | null }>;
  /** calendar events kept so far (the event split grows with it) */
  eventsKnown: number;
}

const HOUR_BUCKETS: Array<{ key: string; label: string; test: (h: number) => boolean }> = [
  { key: 'asia', label: 'Asia (23–05 UTC)', test: (h) => h >= 23 || h <= 5 },
  { key: 'london', label: 'London morning (06–11 UTC)', test: (h) => h >= 6 && h <= 11 },
  { key: 'usdata', label: 'US data hour (12–14 UTC)', test: (h) => h >= 12 && h <= 14 },
  { key: 'us', label: 'US afternoon (15–20 UTC)', test: (h) => h >= 15 && h <= 20 },
  { key: 'late', label: 'Late (21–22 UTC)', test: (h) => h >= 21 && h <= 22 },
];

const EVENT_KINDS: Array<{ key: string; label: string; re: RegExp }> = [
  { key: 'rates', label: 'Rate decisions', re: /rate decision|monetary policy|fomc statement|cash rate|official bank rate|main refinancing|policy rate|federal funds/i },
  { key: 'cpi', label: 'Inflation (CPI / PCE / PPI)', re: /\bcpi\b|inflation|\bpce\b|\bppi\b|price index/i },
  { key: 'jobs', label: 'Jobs (payrolls, employment)', re: /non-farm|nonfarm|payroll|employment change|unemployment|jobless|claimant|adp/i },
  { key: 'gdp', label: 'GDP', re: /\bgdp\b/i },
  { key: 'pmi', label: 'PMI / business surveys', re: /\bpmi\b|ism |business confidence|ifo|zew|sentiment/i },
  { key: 'retail', label: 'Retail sales', re: /retail sales/i },
  { key: 'speech', label: 'Speeches / press conferences', re: /speaks|testif|press conference|remarks/i },
];

const eventKind = (title: string) => EVENT_KINDS.find((k) => k.re.test(title)) ?? null;

function cell(rows: ReadonlyArray<{ moves: Array<number | null> }>): StudyCell {
  const avgAtr: number[] = [];
  const contPct: number[] = [];
  HORIZONS.forEach((_, h) => {
    const xs = rows.map((r) => r.moves[h]).filter((x): x is number => x !== null && x !== undefined);
    avgAtr.push(xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : 0);
    contPct.push(xs.length ? Math.round((xs.filter((x) => x > 0).length / xs.length) * 100) : 0);
  });
  return { n: rows.length, avgAtr, contPct };
}

/** Run the study over hourly contexts per pair + the calendar events seen so far. Pure. */
export function newsStudy(series: ReadonlyArray<{ pair: string; ctx: Ctx }>, events: readonly CalEvent[] = []): NewsStudy {
  type Hit = { pair: string; t: number; hour: number; dir: 1 | -1; sizeAtr: number; moves: Array<number | null>; event: string | null; eventKey: string | null };
  const hits: Hit[] = [];
  const big = events.filter((e) => e.impact === 'High' || (e.impact === 'Medium' && eventKind(e.title)?.key === 'speech'));
  for (const { pair, ctx: c } of series) {
    const ccys = pair.startsWith('XA') ? ['USD'] : [pair.slice(0, 3), pair.slice(3, 6)];
    const n = c.bars.length;
    for (let i = 20; i < n; i++) {
      const d = shockDir(c, i);
      if (!d) continue;
      const a = c.atr14[i - 1]!;
      const b = c.bars[i]!;
      const moves = HORIZONS.map((h) => (i + h < n ? Math.round(((d * (c.close[i + h]! - b.c)) / a) * 100) / 100 : null));
      // an event released inside this candle's hour (or up to 15 min before it opened)
      const ev = big.find((e) => ccys.includes(e.ccy) && e.t >= b.t - 15 * 60_000 && e.t < b.t + 3_600_000) ?? null;
      const kind = ev ? eventKind(ev.title) : null;
      hits.push({ pair, t: b.t, hour: new Date(b.t).getUTCHours(), dir: d, sizeAtr: Math.round(((b.h - b.l) / a) * 10) / 10, moves, event: ev ? `${ev.ccy} ${ev.title}` : null, eventKey: kind?.key ?? (ev ? 'other' : null) });
    }
  }
  const pairs = [...new Set(hits.map((h) => h.pair))];
  const byEvent = [...EVENT_KINDS, { key: 'other', label: 'Other news', re: /$^/ }]
    .map((k) => ({ key: k.key, label: k.label, ...cell(hits.filter((h) => h.eventKey === k.key)) }))
    .filter((x) => x.n > 0);
  return {
    horizons: HORIZONS,
    shocks: hits.length,
    overall: cell(hits),
    byHour: HOUR_BUCKETS.map((b) => ({ key: b.key, label: b.label, ...cell(hits.filter((h) => b.test(h.hour))) })).filter((x) => x.n > 0),
    byPair: pairs.map((p) => ({ pair: p, ...cell(hits.filter((h) => h.pair === p)) })).sort((x, y) => y.n - x.n),
    byEvent,
    recent: hits
      .sort((x, y) => y.t - x.t)
      .slice(0, 12)
      .map(({ pair, t, dir, sizeAtr, moves, event }) => ({ pair, t, dir, sizeAtr, moves, event })),
    eventsKnown: big.length,
  };
}
