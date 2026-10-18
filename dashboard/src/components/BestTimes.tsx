/** Performance page: "Best times to trade" — market motion per hour / weekday + how our trades did then. */
import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { ago } from '../lib/format';
import { Card, Empty, ErrorBox, HeatRow, Row, Rows, SectionHeader } from './ui';

interface Slot { tradesPerMin: number | null; launchesPerMin: number | null; migrationsPerHour: number | null; activity: number | null; days: number; trades: number; avgPct: number | null; winRatePct: number | null; edgePct: number }
interface Timing {
  at: string;
  hours: Slot[];
  days: Slot[];
  overall: { tradesPerMin: number | null; trades: number; avgPct: number | null; winRatePct: number | null; daysRecorded: number };
  busiestHours: number[];
  bestHours: number[];
  worstHours: number[];
  bestDays: number[];
  now: { sizeFactor: number; barDelta: number; why: string };
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// Hours are stored in UTC; shown in the viewer's own time.
const offsetH = -new Date().getTimezoneOffset() / 60;
const local = (utcH: number) => (((utcH + offsetH) % 24) + 24) % 24;
const hh = (utcH: number) => `${String(Math.floor(local(utcH))).padStart(2, '0')}:${local(utcH) % 1 ? '30' : '00'}`;
const pct = (n: number | null) => (n === null ? '—' : `${n > 0 ? '+' : ''}${n}%`);

export function BestTimes() {
  const { data, error } = useApi<Timing | null>('/api/timing', 120_000);
  const [hover, setHover] = useState<number | null>(null);
  const nowUtc = new Date().getUTCHours();
  if (error) return <ErrorBox message={error} />;
  if (!data) return <Empty>Learning from the live market. The first picture shows after a few hours, a reliable one after about 3 days.</Empty>;
  const order = Array.from({ length: 24 }, (_, i) => ((Math.round(i - offsetH) % 24) + 24) % 24);
  const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return (
    <div className="flex flex-col gap-6">
      <SectionHeader title="Best times to trade" description={`${data.overall.daysRecorded} day${data.overall.daysRecorded === 1 ? '' : 's'} of market activity · ${data.overall.trades} of our trades · your time zone · ${ago(data.at)}`} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl border border-line bg-surface-2/60 px-4 py-3 text-sm">
        <span className="font-semibold text-ink">Right now</span>
        <span className="tabular text-ink">size ×{data.now.sizeFactor.toFixed(2)} · buy bar {data.now.barDelta > 0 ? `+${data.now.barDelta}` : data.now.barDelta}</span>
        <span className="text-ink-2">{data.now.why}</span>
      </div>
      <div className="grid gap-6 xl:grid-cols-12">
        <div className="flex min-w-0 flex-col gap-6 xl:col-span-8">
          <Card title="Market activity per hour" subtitle="How busy pump.fun is, hour by hour (dot = now). Hover a bar for the numbers.">
            <HourStrip data={data} nowUtc={nowUtc} hover={hover} setHover={setHover} />
          </Card>
          <Card title="Hour × day heat" subtitle="Top rows: market activity and our average result per hour. Bottom: the same per weekday.">
            <div className="flex flex-col gap-4">
              <div>
                <div className="mb-1 text-xs font-medium text-muted">Activity per hour</div>
                <HeatRow ariaLabel="Market activity per hour" cells={order.map((h) => ({ key: `a${h}`, value: data.hours[h]!.activity, title: `${hh(h)}: ${data.hours[h]!.activity === null ? 'no data' : `${data.hours[h]!.activity!.toFixed(2)}× normal`}` }))} />
              </div>
              <div>
                <div className="mb-1 text-xs font-medium text-muted">Our average result per hour</div>
                <HeatRow signed ariaLabel="Our average result per hour" labels={['00', '06', '12', '18', '24']} cells={order.map((h) => { const r = data.hours[h]!; const ok = r.trades >= 3 && r.avgPct !== null; return { key: `r${h}`, value: ok ? r.avgPct : null, title: `${hh(h)}: ${ok ? `${pct(r.avgPct)} avg on ${r.trades} trades` : 'not enough trades'}` }; })} />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="mb-1 text-xs font-medium text-muted">Activity per weekday (UTC)</div>
                  <HeatRow ariaLabel="Market activity per weekday" labels={DAY_SHORT} cells={data.days.map((d, i) => ({ key: `da${i}`, value: d.activity, title: `${DAYS[i]}: ${d.activity === null ? 'no data' : `${d.activity.toFixed(2)}× normal`}` }))} />
                </div>
                <div>
                  <div className="mb-1 text-xs font-medium text-muted">Our result per weekday</div>
                  <HeatRow signed ariaLabel="Our result per weekday" labels={DAY_SHORT} cells={data.days.map((d, i) => ({ key: `dr${i}`, value: d.trades >= 3 ? d.avgPct : null, title: `${DAYS[i]}: ${d.avgPct === null ? 'no trades' : `${pct(d.avgPct)} on ${d.trades} trades`}` }))} />
                </div>
              </div>
            </div>
          </Card>
        </div>
        <div className="flex min-w-0 flex-col gap-6 xl:col-span-4">
          <Card title="Stand-out hours">
            <Rows>
              <Row label="Busiest" value={<Hours hours={data.busiestHours} empty="needs ~3 days" />} />
              <Row label="Our best" value={<Hours hours={data.bestHours} empty="needs more trades" />} />
              <Row label="Our worst" value={<Hours hours={data.worstHours} empty="none stand out" />} />
            </Rows>
          </Card>
          <Card title="By weekday" padded={false}>
            <table className="tabular w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th className="px-4 py-2 font-medium">Day</th>
                  <th className="py-2 text-right font-medium">Activity</th>
                  <th className="py-2 text-right font-medium">Trades</th>
                  <th className="px-4 py-2 text-right font-medium">Avg</th>
                </tr>
              </thead>
              <tbody>
                {data.days.map((d, i) => (
                  <tr key={i} className={`border-t border-line ${i === new Date().getUTCDay() ? 'bg-surface-2/60 font-medium' : ''}`}>
                    <td className="px-4 py-2 text-ink">{DAY_SHORT[i]}{data.bestDays.includes(i) ? ' ★' : ''}</td>
                    <td className="py-2 text-right text-ink-2">{d.activity === null ? '—' : `${d.activity.toFixed(2)}×`}</td>
                    <td className="py-2 text-right text-ink-2">{d.trades}</td>
                    <td className={`px-4 py-2 text-right ${d.avgPct === null ? 'text-muted' : d.avgPct >= 0 ? 'text-up' : 'text-down'}`}>{pct(d.avgPct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <p className="text-xs text-muted">Busy, well-paying hours trade a bit bigger with an easier buy bar; quiet, losing ones smaller and stricter. It never stops trading by itself.</p>
        </div>
      </div>
    </div>
  );
}

function Hours({ hours, empty }: { hours: number[]; empty: string }) {
  return <span className="tabular">{hours.length ? hours.map(hh).join(', ') : <span className="font-normal text-muted">{empty}</span>}</span>;
}

/** 24 bars (market activity per hour, one hue) + a row of cells for our average result that hour. */
function HourStrip({ data, nowUtc, hover, setHover }: { data: Timing; nowUtc: number; hover: number | null; setHover: (h: number | null) => void }) {
  // Columns in the viewer's local order starting at local midnight.
  const order = Array.from({ length: 24 }, (_, i) => ((Math.round(i - offsetH) % 24) + 24) % 24);
  const maxAct = Math.max(1.5, ...data.hours.map((h) => h.activity ?? 0));
  const shown = hover ?? nowUtc;
  const s = data.hours[shown]!;
  return (
    <div>
      <div className="mb-2 text-xs">
        <div className="text-ink-2 tabular-nums">
          {hh(shown)}{shown === nowUtc && hover === null ? ' (now)' : ''}: {s.activity === null ? 'not enough days yet' : `${s.activity.toFixed(2)}× normal · ${s.tradesPerMin} trades/min · ${s.migrationsPerHour} migrations/h`} · our trades {s.trades}{s.trades ? `, avg ${pct(s.avgPct)}` : ''}
        </div>
      </div>
      <div className="flex h-20 items-end gap-[2px]" onMouseLeave={() => setHover(null)} role="img" aria-label="Market activity per hour of the day">
        {order.map((h) => {
          const a = data.hours[h]!.activity;
          return (
            <button
              key={h}
              type="button"
              onMouseEnter={() => setHover(h)}
              onFocus={() => setHover(h)}
              onClick={() => setHover(hover === h ? null : h)}
              aria-label={`${hh(h)}: ${a === null ? 'no data' : `${a.toFixed(2)}× normal activity`}`}
              className="relative flex h-full min-w-0 flex-1 items-end"
            >
              <span
                className={`block w-full rounded-t ${a === null ? 'bg-line' : 'bg-accent'} ${h === shown ? 'opacity-100' : 'opacity-70'}`}
                style={{ height: `${a === null ? 6 : Math.max(6, (a / maxAct) * 100)}%` }}
              />
              {h === nowUtc && <span className="absolute -top-1 left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-ink" aria-hidden />}
            </button>
          );
        })}
      </div>
      <div className="mt-[2px] flex gap-[2px]" aria-hidden>
        {order.map((h) => {
          const r = data.hours[h]!;
          const tone = r.trades < 3 || r.avgPct === null ? 'bg-line opacity-60' : r.avgPct >= 0 ? 'bg-up' : 'bg-down';
          const strength = r.trades < 3 || r.avgPct === null ? 1 : Math.min(1, 0.35 + Math.abs(r.avgPct) / 20);
          return <span key={h} className={`h-2 min-w-0 flex-1 rounded-sm ${tone}`} style={{ opacity: strength }} />;
        })}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted tabular-nums">
        {['00', '06', '12', '18', '24'].map((t) => (
          <span key={t}>{t}:00</span>
        ))}
      </div>
      <p className="mt-1 text-xs text-muted">Strip under the bars = our average result in that hour: green made money, red lost, grey not enough trades.</p>
    </div>
  );
}
