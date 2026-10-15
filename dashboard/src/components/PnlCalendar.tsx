/** Overview: daily P&L calendar — every day starts at 0, tap a day for its numbers. */
import { useMemo, useState } from 'react';
import { useApi } from '../hooks/useApi';
import { STRATEGY_LABEL } from '../lib/format';
import { Card, Pnl } from './ui';

interface Day {
  day: string;
  pnlSol: number;
  trades: number;
  wins: number;
  winRate: number | null;
  avgPct: number | null;
  bestPct: number | null;
  worstPct: number | null;
  volumeSol: number;
  byStrategy: Array<{ strategy: string; trades: number; pnlSol: number }>;
}
interface Calendar { mode: string; statsSince: string | null; days: Day[] }

const WEEK = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const pad = (n: number) => String(n).padStart(2, '0');
const keyOf = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;
const pct = (n: number | null) => (n === null ? '—' : `${n > 0 ? '+' : ''}${n}%`);
const short = (v: number) => `${v > 0 ? '+' : ''}${Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2)}`;

export function PnlCalendar() {
  const tz = new Date().getTimezoneOffset();
  const { data, error } = useApi<Calendar>(`/api/pnl-calendar?tz=${tz}`, 60_000, ['trade']);
  const now = new Date();
  const today = keyOf(now.getFullYear(), now.getMonth(), now.getDate());
  const [month, setMonth] = useState({ y: now.getFullYear(), m: now.getMonth() });
  const [picked, setPicked] = useState<string>(today);

  const byDay = useMemo(() => new Map((data?.days ?? []).map((d) => [d.day, d])), [data]);
  const first = new Date(month.y, month.m, 1);
  const lead = (first.getDay() + 6) % 7; // Monday first
  const count = new Date(month.y, month.m + 1, 0).getDate();
  const cells: Array<number | null> = [...Array(lead).fill(null), ...Array.from({ length: count }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(null);

  const inMonth = (data?.days ?? []).filter((d) => d.day.startsWith(`${month.y}-${pad(month.m + 1)}`));
  const monthPnl = inMonth.reduce((a, d) => a + d.pnlSol, 0);
  const green = inMonth.filter((d) => d.pnlSol > 0).length;
  const red = inMonth.filter((d) => d.pnlSol < 0).length;
  const sel = byDay.get(picked);
  const isThisMonth = month.y === now.getFullYear() && month.m === now.getMonth();
  const step = (k: number) => setMonth(({ y, m }) => ({ y: m + k < 0 ? y - 1 : m + k > 11 ? y + 1 : y, m: (m + k + 12) % 12 }));
  const max = Math.max(0.0001, ...inMonth.map((d) => Math.abs(d.pnlSol)));

  return (
    <Card
      title="Daily profit"
      subtitle="Every day starts at 0 — tap a day"
      action={
        <div className="flex items-center gap-1">
          <button type="button" aria-label="Previous month" onClick={() => step(-1)} className="rounded-md px-2 py-1 text-ink-2 hover:bg-surface-2">‹</button>
          <span className="min-w-[6.5rem] text-center text-sm font-medium text-ink">{first.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}</span>
          <button type="button" aria-label="Next month" disabled={isThisMonth} onClick={() => step(1)} className="rounded-md px-2 py-1 text-ink-2 hover:bg-surface-2 disabled:opacity-30">›</button>
        </div>
      }
    >
      {error && <p className="text-sm text-down">{error}</p>}
      <div className="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
        <span className="text-muted">This month</span>
        <Pnl value={monthPnl} className="font-semibold" />
        <span className="text-xs text-ink-2 tabular-nums">{green} green · {red} red day{red === 1 ? '' : 's'}</span>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center">
        {WEEK.map((w) => (
          <div key={w} className="pb-1 text-[11px] text-muted">{w}</div>
        ))}
        {cells.map((d, i) => {
          if (d === null) return <div key={`e${i}`} />;
          const k = keyOf(month.y, month.m, d);
          const v = byDay.get(k);
          const a = v ? 0.12 + 0.38 * Math.min(1, Math.abs(v.pnlSol) / max) : 0;
          const bg = v && v.pnlSol > 0 ? `rgba(34,197,94,${a})` : v && v.pnlSol < 0 ? `rgba(239,68,68,${a})` : undefined;
          return (
            <button
              key={k}
              type="button"
              onClick={() => setPicked(k)}
              style={bg ? { backgroundColor: bg } : undefined}
              className={`flex aspect-square min-h-[2.6rem] flex-col items-center justify-center rounded-md border text-[11px] leading-tight ${picked === k ? 'border-accent' : 'border-line'} ${k === today ? 'font-semibold' : ''} ${k > today ? 'opacity-40' : ''}`}
            >
              <span className="text-ink-2">{d}</span>
              {v && <span className={`tabular-nums ${v.pnlSol > 0 ? 'text-up' : v.pnlSol < 0 ? 'text-down' : 'text-ink-2'}`}>{short(v.pnlSol)}</span>}
            </button>
          );
        })}
      </div>
      <div className="mt-3 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-medium text-ink">{new Date(`${picked}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' })}</span>
          {sel ? <Pnl value={sel.pnlSol} className="font-semibold" /> : <span className="text-muted">no closed trades</span>}
        </div>
        {sel && (
          <>
            <p className="mt-1 text-xs text-ink-2 tabular-nums">
              {sel.trades} trade{sel.trades === 1 ? '' : 's'} · {sel.wins} won ({sel.winRate === null ? '—' : `${Math.round(sel.winRate * 100)}%`}) · avg {pct(sel.avgPct)} · best {pct(sel.bestPct)} · worst {pct(sel.worstPct)} · {sel.volumeSol.toFixed(2)} SOL traded
            </p>
            <ul className="mt-2 space-y-0.5 text-xs">
              {sel.byStrategy.map((s) => (
                <li key={s.strategy} className="flex justify-between gap-2">
                  <span className="text-ink-2">{STRATEGY_LABEL[s.strategy] ?? s.strategy} · {s.trades}</span>
                  <Pnl value={s.pnlSol} />
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Card>
  );
}
