/** Performance page: "Best times to trade" — market motion per hour / weekday + how our trades did then. */
import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { ago } from '../lib/format';
import { Card } from './ui';

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
  return (
    <Card title="Best times to trade" className="mb-4">
      {error && <p className="text-sm text-down">{error}</p>}
      {!data && !error && <p className="text-sm text-ink-2">Learning from the live market — the first picture shows up after a few hours, a reliable one after about 3 days.</p>}
      {data && (
        <div className="space-y-4 text-sm">
          <p className="text-xs text-muted">
            {data.overall.daysRecorded} day{data.overall.daysRecorded === 1 ? '' : 's'} of market activity · {data.overall.trades} of our trades · times in your time zone · {ago(data.at)}
          </p>
          <div className="rounded-lg border border-line bg-surface-2 px-3 py-2">
            <span className="text-muted">Right now: </span>
            <span className="font-medium text-ink tabular-nums">
              size ×{data.now.sizeFactor.toFixed(2)} · buy bar {data.now.barDelta > 0 ? `+${data.now.barDelta}` : data.now.barDelta}
            </span>
            <span className="text-ink-2"> — {data.now.why}</span>
          </div>
          <HourStrip data={data} nowUtc={nowUtc} hover={hover} setHover={setHover} />
          <div className="grid gap-2 sm:grid-cols-3">
            <Summary label="Busiest hours" hours={data.busiestHours} empty="needs ~3 days" />
            <Summary label="Our best hours" hours={data.bestHours} empty="needs more trades" />
            <Summary label="Our worst hours" hours={data.worstHours} empty="none stand out" />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[22rem] text-left text-sm">
              <thead className="text-xs text-muted">
                <tr>
                  <th className="py-1 font-normal">Day (UTC)</th>
                  <th className="py-1 font-normal">Market activity</th>
                  <th className="py-1 text-right font-normal">Our trades</th>
                  <th className="py-1 text-right font-normal">Avg result</th>
                  <th className="py-1 text-right font-normal">Win rate</th>
                </tr>
              </thead>
              <tbody>
                {data.days.map((d, i) => (
                  <tr key={i} className={`border-t border-line ${i === new Date().getUTCDay() ? 'font-medium' : ''}`}>
                    <td className="py-1 text-ink">{DAYS[i]}{data.bestDays.includes(i) ? ' ★' : ''}</td>
                    <td className="py-1 text-ink-2 tabular-nums">{d.activity === null ? '—' : `${d.activity.toFixed(2)}× normal`}</td>
                    <td className="py-1 text-right text-ink-2 tabular-nums">{d.trades}</td>
                    <td className={`py-1 text-right tabular-nums ${d.avgPct === null ? 'text-muted' : d.avgPct >= 0 ? 'text-up' : 'text-down'}`}>{pct(d.avgPct)}</td>
                    <td className="py-1 text-right text-ink-2 tabular-nums">{d.winRatePct === null ? '—' : `${d.winRatePct}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted">Busy, well-paying hours trade a bit bigger with an easier buy bar; quiet, losing ones smaller and stricter. It never stops trading by itself.</p>
        </div>
      )}
    </Card>
  );
}

function Summary({ label, hours, empty }: { label: string; hours: number[]; empty: string }) {
  return (
    <div className="min-w-0">
      <div className="text-muted">{label}</div>
      <div className="truncate font-medium text-ink tabular-nums">{hours.length ? hours.map(hh).join(', ') : <span className="font-normal text-muted">{empty}</span>}</div>
    </div>
  );
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
        <div className="text-muted">Market activity per hour</div>
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
      <p className="mt-1 text-xs text-muted">Bars = how busy pump.fun is (dot = now). Strip below = our average result in that hour: green made money, red lost, grey not enough trades.</p>
    </div>
  );
}
