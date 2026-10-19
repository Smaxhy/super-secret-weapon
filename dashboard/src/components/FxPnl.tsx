/**
 * v17.8 Auto-bot: profit and loss of a forex practice account (owner: "a PnL and calendar view"). Today / this week /
 * this month / all time, the balance after every close (+ now, open trades included) and a month calendar — tap a
 * day for its trades. Days in the viewer's clock. An older server without /api/forex/pnl → `fallback` instead.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Area, ComposedChart, Line, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid } from 'recharts';
import { useApi } from '../hooks/useApi';
import { useThemeColors } from '../hooks/useThemeColors';
import { ChartTable, TooltipBox } from './Charts';
import { fxDigits, fxTone, fxUsd } from './FxActiveTrade';
import { Icon } from './Icon';
import { Badge, Card, Empty, Skeleton } from './ui';

interface Period { pnlUsd: number; trades: number; wins: number }
interface Day { day: string; pnlUsd: number; trades: number; wins: number; bestUsd: number | null; worstUsd: number | null; byStrategy: Array<{ strategy: string; name: string; tf: string | null; trades: number; pnlUsd: number }> }
export interface PnlData { acct: 'bot' | 'me'; startUsd: number; equityUsd: number; openPnlUsd: number; since: number | null; periods: { today: Period; week: Period; month: Period; all: Period }; days: Day[]; curve: Array<[number, number]> }
interface DayTrade { id: string; pair: string; side: 1 | -1; strategy: string | null; name: string | null; tf: string | null; entry: number; exit: number; pnlUsd: number; reason: string; openedAt: number | null; closedAt: number; partial: boolean }

const WEEK = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const pad = (n: number) => String(n).padStart(2, '0');
const keyOf = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;
const REASON: Record<string, string> = { partial: 'part taken', weekend: 'paused for the weekend', signal: 'strategy exit', 'stop-out': 'margin call', stop: 'stop', target: 'target', manual: 'closed by hand', breakeven: 'break-even stop' };
/** Calendar cell: "+12", "−3.45", "+1.2k" (fits a phone-width cell). */
const cell = (v: number) => {
  const a = Math.abs(v);
  const s = v > 0 ? '+' : v < 0 ? '−' : '';
  return `${s}${a >= 1000 ? `${(a / 1000).toFixed(1)}k` : a >= 100 ? a.toFixed(0) : a >= 10 ? a.toFixed(1) : a.toFixed(2)}`;
};
const winPct = (p: { trades: number; wins: number }) => (p.trades ? `${Math.round((p.wins / p.trades) * 100)}% won` : '');
const sideTxt = (s: 1 | -1) => (s === 1 ? 'Long' : 'Short');

export function FxPnl({ acct = 'bot', fallback = null }: { acct?: 'bot' | 'me'; fallback?: ReactNode }) {
  const tz = new Date().getTimezoneOffset();
  const { data, error } = useApi<PnlData>(`/api/forex/pnl?acct=${acct}&tz=${tz}`, 60_000);
  // an older server (404) or a broken answer → the page's old tiles
  if (!data || !data.periods) {
    if (error) return <>{fallback}</>;
    return (
      <Card title="Profit and loss">
        <Skeleton className="h-10 w-40" />
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[0, 1, 2, 3].map((k) => <Skeleton key={k} className="h-16" />)}
        </div>
        <Skeleton className="mt-4 h-44" />
      </Card>
    );
  }
  const d = data;
  const profit = d.equityUsd - d.startUsd;
  const any = d.days.length > 0 || d.curve.length > 0;
  return (
    <Card title="Profit and loss" subtitle="The bot's practice account. A trade counts on the day it closed, in your time zone.">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div>
          <div className="text-xs font-medium text-muted">Account now</div>
          <div className="text-[32px] font-semibold leading-none tracking-tight text-ink">{fxUsd(d.equityUsd)}</div>
        </div>
        <div className="text-sm text-ink-2">
          <span className={`font-semibold ${fxTone(profit)}`}>{fxUsd(profit, true)}</span>
          {d.startUsd > 0 && <span className={fxTone(profit)}> ({profit >= 0 ? '+' : '−'}{Math.abs((profit / d.startUsd) * 100).toFixed(1)}%)</span>}
          <span className="text-muted"> since the {fxUsd(d.startUsd)} start</span>
          {d.openPnlUsd !== 0 && <div className="text-xs text-muted">incl. <span className={fxTone(d.openPnlUsd)}>{fxUsd(d.openPnlUsd, true)}</span> in open trades</div>}
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <PeriodTile label="Today" p={d.periods.today} />
        <PeriodTile label="This week" p={d.periods.week} />
        <PeriodTile label="This month" p={d.periods.month} />
        <PeriodTile label="All time" p={d.periods.all} />
      </div>
      {!any ? (
        <div className="mt-4">
          <Empty icon={<Icon name="chart" size={18} />}>No closed trades yet. The balance line and the calendar fill in after the first one.</Empty>
        </div>
      ) : (
        // wide screens: the balance line and the calendar side by side
        <div className="mt-5 grid gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
          <div className="min-w-0">
            <div className="mb-1 text-xs font-semibold text-muted">Balance after every close</div>
            <EquityCurve d={d} />
          </div>
          <div className="min-w-0">
            <MonthCalendar d={d} acct={acct} tz={tz} />
          </div>
        </div>
      )}
    </Card>
  );
}

function PeriodTile({ label, p }: { label: string; p: Period }) {
  return (
    <div className="min-w-0 rounded-xl border border-line bg-surface-2/40 px-3 py-2.5">
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className={`mt-0.5 truncate text-lg font-semibold leading-tight ${fxTone(p.pnlUsd)}`}>
        {p.pnlUsd !== 0 && <span aria-hidden="true" className="mr-1 text-[0.65em]">{p.pnlUsd > 0 ? '▲' : '▼'}</span>}
        {fxUsd(p.pnlUsd, true)}
      </div>
      <div className="tabular mt-0.5 truncate text-xs text-muted">{p.trades ? `${p.trades} trade${p.trades === 1 ? '' : 's'} · ${winPct(p)}` : 'no trades'}</div>
    </div>
  );
}

interface Pt { ts: number; eq?: number; live?: number }

function EquityCurve({ d }: { d: PnlData }) {
  const c = useThemeColors();
  // "now" moves with each refresh of the report (not every render)
  const now = useMemo(() => Date.now(), [d]);
  const rows = useMemo<Pt[]>(() => {
    const out: Pt[] = d.curve.map(([ts, eq]) => ({ ts, eq }));
    const last = out[out.length - 1];
    if (last) {
      last.live = last.eq;
      // the account right now (open trades included), joined to the last close by a dashed line
      out.push({ ts: Math.max(now, last.ts + 1), live: d.equityUsd });
    }
    return out;
  }, [d, now]);
  if (rows.length < 2) return null;
  const vals = [...rows.flatMap((r) => [r.eq, r.live]).filter((v): v is number => v !== undefined), d.startUsd];
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  // round-number ticks ($900 / $1,000 / $1,100 …) and a domain that ends on them
  const raw = Math.max(1, (hi - lo) * 1.2) / 3;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const stepV = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
  const y0 = Math.floor((lo - stepV * 0.15) / stepV) * stepV;
  const y1 = Math.ceil((hi + stepV * 0.15) / stepV) * stepV;
  const yTicks = Array.from({ length: Math.round((y1 - y0) / stepV) + 1 }, (_, k) => y0 + k * stepV);
  const t0 = rows[0]!.ts;
  const t1 = rows[rows.length - 1]!.ts;
  const longSpan = t1 - t0 > 2 * 86_400_000;
  const fmtT = (v: number) => (longSpan ? new Date(v).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  const ticks = Array.from({ length: 4 }, (_, i) => t0 + ((t1 - t0) * i) / 3);
  const up = d.equityUsd >= d.startUsd;
  const stroke = up ? c.pos : c.neg;
  const yFmt = (v: number) => `$${v.toLocaleString(undefined, { maximumFractionDigits: stepV < 1 ? 2 : stepV < 10 && stepV % 1 ? 1 : 0 })}`;
  const gid = `fx-eq-${up ? 'up' : 'down'}`;
  return (
    <>
      <div style={{ height: 200 }} role="img" aria-label={`Account balance after every close, now ${fxUsd(d.equityUsd)} with open trades`}>
        <ResponsiveContainer>
          <ComposedChart data={rows} margin={{ top: 10, right: 12, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={stroke} stopOpacity={0.22} />
                <stop offset="100%" stopColor={stroke} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={c.grid} vertical={false} />
            <XAxis dataKey="ts" type="number" scale="time" domain={[t0, t1]} ticks={ticks} tickFormatter={fmtT} stroke={c.axis} tick={{ fill: c.muted, fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={20} />
            <YAxis domain={[y0, y1]} ticks={yTicks} tickFormatter={yFmt} width={58} stroke={c.axis} tick={{ fill: c.muted, fontSize: 11 }} tickLine={false} axisLine={false} allowDecimals />
            <ReferenceLine y={d.startUsd} stroke={c['ink-2']} strokeOpacity={0.45} strokeWidth={1} />
            <Tooltip
              cursor={{ stroke: c['ink-2'], strokeWidth: 1, opacity: 0.5 }}
              content={({ active, payload }) => {
                const p = payload?.[0]?.payload as Pt | undefined;
                if (!active || !p) return null;
                const isNow = p.eq === undefined;
                const v = (isNow ? p.live : p.eq) ?? 0;
                return <TooltipBox title={isNow ? 'Now, open trades included' : new Date(p.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} rows={[['Balance', fxUsd(v)], ['Since the start', fxUsd(v - d.startUsd, true)]]} />;
              }}
            />
            <Area type="linear" dataKey="eq" stroke={stroke} strokeWidth={2} fill={`url(#${gid})`} dot={false} activeDot={{ r: 5, stroke: c.surface, strokeWidth: 2, fill: stroke }} isAnimationActive={false} connectNulls={false} />
            <Line type="linear" dataKey="live" stroke={stroke} strokeWidth={2} strokeDasharray="3 4" dot={false} activeDot={false} isAnimationActive={false} connectNulls />
            <ReferenceDot x={rows[rows.length - 1]!.ts} y={d.equityUsd} r={5} fill={stroke} stroke={c.surface} strokeWidth={2} ifOverflow="extendDomain" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5">
          <svg width="18" height="6" aria-hidden="true"><line x1="0" x2="18" y1="3" y2="3" stroke={c['ink-2']} strokeOpacity={0.45} strokeWidth={1} /></svg>
          start {fxUsd(d.startUsd)}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <svg width="18" height="8" aria-hidden="true"><line x1="0" x2="12" y1="4" y2="4" stroke={stroke} strokeWidth={2} strokeDasharray="3 3" /><circle cx="14" cy="4" r="3.5" fill={stroke} /></svg>
          now, with open trades: <span className={`font-semibold ${fxTone(d.equityUsd - d.startUsd)}`}>{fxUsd(d.equityUsd)}</span>
        </span>
      </div>
      <ChartTable headers={['After the close at', 'Balance']} rows={d.curve.slice(-200).reverse().map(([t, v]) => [new Date(t).toLocaleString(), fxUsd(v)])} />
    </>
  );
}

function MonthCalendar({ d, acct, tz }: { d: PnlData; acct: 'bot' | 'me'; tz: number }) {
  const now = new Date();
  const today = keyOf(now.getFullYear(), now.getMonth(), now.getDate());
  const [month, setMonth] = useState({ y: now.getFullYear(), m: now.getMonth() });
  const [picked, setPicked] = useState<string | null>(null);
  const byDay = useMemo(() => new Map(d.days.map((x) => [x.day, x])), [d]);
  const first = new Date(month.y, month.m, 1);
  const lead = (first.getDay() + 6) % 7; // Monday first
  const count = new Date(month.y, month.m + 1, 0).getDate();
  const cells: Array<number | null> = [...Array(lead).fill(null), ...Array.from({ length: count }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(null);
  const ym = `${month.y}-${pad(month.m + 1)}`;
  const inMonth = d.days.filter((x) => x.day.startsWith(ym));
  const monthPnl = inMonth.reduce((a, x) => a + x.pnlUsd, 0);
  const green = inMonth.filter((x) => x.pnlUsd > 0).length;
  const red = inMonth.filter((x) => x.pnlUsd < 0).length;
  const firstDay = d.days[0]?.day ?? (d.since ? new Date(d.since).toISOString().slice(0, 10) : null);
  const canBack = !!firstDay && firstDay.slice(0, 7) < ym;
  const isThisMonth = month.y === now.getFullYear() && month.m === now.getMonth();
  const step = (k: number) => {
    setPicked(null);
    setMonth(({ y, m }) => ({ y: m + k < 0 ? y - 1 : m + k > 11 ? y + 1 : y, m: (m + k + 12) % 12 }));
  };
  const max = Math.max(0.01, ...inMonth.map((x) => Math.abs(x.pnlUsd)));
  const sel = picked ? byDay.get(picked) : undefined;
  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <button type="button" aria-label="Previous month" disabled={!canBack} onClick={() => step(-1)} className="grid h-10 w-10 place-items-center rounded-full text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-30">
          <Icon name="chevron" size={18} className="rotate-180" />
        </button>
        <div className="text-center">
          <div className="text-sm font-semibold text-ink">{first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</div>
          <div className="tabular mt-0.5 text-xs text-muted">
            <span className={`font-semibold ${fxTone(monthPnl)}`}>{fxUsd(monthPnl, true)}</span> · {green} up · {red} down
          </div>
        </div>
        <button type="button" aria-label="Next month" disabled={isThisMonth} onClick={() => step(1)} className="grid h-10 w-10 place-items-center rounded-full text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-30">
          <Icon name="chevron" size={18} />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center sm:gap-1.5">
        {WEEK.map((w) => (
          <div key={w} className="pb-1 text-[11px] font-medium uppercase tracking-wide text-muted">{w}</div>
        ))}
        {cells.map((n, i) => {
          if (n === null) return <div key={`e${i}`} />;
          const k = keyOf(month.y, month.m, n);
          const v = byDay.get(k);
          const intensity = v ? 0.14 + 0.5 * Math.min(1, Math.abs(v.pnlUsd) / max) : 0;
          const bg = v && v.pnlUsd > 0 ? `rgba(var(--pnl-up-bg), ${intensity})` : v && v.pnlUsd < 0 ? `rgba(var(--pnl-down-bg), ${intensity})` : undefined;
          const future = k > today;
          const isToday = k === today;
          const on = picked === k;
          return (
            <button
              key={k}
              type="button"
              disabled={future}
              aria-pressed={on}
              aria-label={`${new Date(`${k}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}${v ? `, ${fxUsd(v.pnlUsd, true)}, ${v.trades} trades` : ', no closed trades'}${isToday ? ' (today)' : ''}`}
              onClick={() => setPicked(on ? null : k)}
              style={bg ? { backgroundColor: bg } : undefined}
              className={`flex min-h-[2.9rem] min-w-0 flex-col items-center justify-center rounded-xl text-[11px] leading-tight transition-[transform,box-shadow,background-color] duration-150 ${on ? 'ring-2 ring-accent ring-offset-1 ring-offset-surface' : isToday ? 'ring-2 ring-ink/50' : ''} ${!v && !future ? 'bg-surface-2/50' : ''} ${future ? 'opacity-30' : 'hover:scale-[1.04]'}`}
            >
              <span className={isToday ? 'font-bold text-ink' : 'text-ink-2'}>{n}</span>
              {v && <span className={`tabular mt-0.5 max-w-full truncate px-0.5 font-semibold ${v.pnlUsd > 0 ? 'text-up' : v.pnlUsd < 0 ? 'text-down' : 'text-ink-2'}`}>{cell(v.pnlUsd)}</span>}
            </button>
          );
        })}
      </div>
      {picked && <DayTrades key={picked} day={picked} sum={sel} acct={acct} tz={tz} onClose={() => setPicked(null)} />}
    </div>
  );
}

function DayTrades({ day, sum, acct, tz, onClose }: { day: string; sum: Day | undefined; acct: 'bot' | 'me'; tz: number; onClose: () => void }) {
  const { data, error } = useApi<{ day: string; trades: DayTrade[] }>(sum ? `/api/forex/pnl/day?acct=${acct}&day=${day}&tz=${tz}` : null, 60_000);
  const trades = data?.day === day ? data.trades : null;
  return (
    <div className="fade-in mt-3 rounded-xl border border-line bg-surface-2/30 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-ink">{new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</div>
          {sum && (
            <div className="tabular mt-0.5 text-xs text-muted">
              {sum.trades} trade{sum.trades === 1 ? '' : 's'}{sum.trades ? ` · ${winPct(sum)}` : ''}
              {sum.bestUsd !== null && sum.trades > 1 ? ` · best ${fxUsd(sum.bestUsd, true)} · worst ${fxUsd(sum.worstUsd ?? 0, true)}` : ''}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {sum && <span className={`text-base font-semibold ${fxTone(sum.pnlUsd)}`}>{fxUsd(sum.pnlUsd, true)}</span>}
          <button type="button" aria-label="Close the day" onClick={onClose} className="grid h-8 w-8 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-ink">
            <Icon name="x" size={14} />
          </button>
        </div>
      </div>
      {!sum ? (
        <p className="mt-2 text-xs text-muted">No closed trades on this day.</p>
      ) : error && !trades ? (
        <p className="mt-2 text-xs text-down">Couldn't load this day's trades ({error}).</p>
      ) : !trades ? (
        <div className="mt-3 space-y-2">
          <Skeleton className="h-9" />
          <Skeleton className="h-9" />
        </div>
      ) : (
        <>
          {sum.byStrategy.length > 1 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {sum.byStrategy.map((s) => (
                <span key={`${s.strategy}:${s.tf}`} className="inline-flex items-center gap-1 rounded-md bg-surface px-1.5 py-0.5 text-[11px] text-ink-2">
                  {s.name}{s.tf ? ` (${s.tf})` : ''} <span className={`font-semibold ${fxTone(s.pnlUsd)}`}>{fxUsd(s.pnlUsd, true)}</span>
                </span>
              ))}
            </div>
          )}
          <ul className="mt-2 divide-y divide-line">
            {trades.map((t) => (
              <li key={t.id} className="flex items-start gap-2 py-2 first:pt-1 last:pb-0">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={t.side === 1 ? 'up' : 'down'}>{sideTxt(t.side)}</Badge>
                    <span className="text-sm font-medium text-ink">{t.pair}</span>
                    {t.partial && <Badge tone="neutral">part taken</Badge>}
                    <span className="min-w-0 truncate text-xs text-muted">{t.name ?? 'by hand'}{t.tf ? ` (${t.tf})` : ''}</span>
                  </div>
                  <div className="tabular mt-0.5 text-xs text-muted">
                    {t.entry.toFixed(fxDigits(t.pair))} → {t.exit.toFixed(fxDigits(t.pair))} · {t.partial ? 'part taken' : REASON[t.reason] ?? t.reason} · {new Date(t.closedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </div>
                </div>
                <span className={`tabular shrink-0 text-sm font-semibold ${fxTone(t.pnlUsd)}`}>{fxUsd(t.pnlUsd, true)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
