/** Overview profit card: daily P&L calendar — every day starts at 0; tapping a day shows that day's chart above it. */
import { useMemo, useState } from 'react';
import { useApi } from '../hooks/useApi';
import { STRATEGY_LABEL } from '../lib/format';
import { Icon } from './Icon';
import { Pnl } from './ui';

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
const short = (v: number) => `${v > 0 ? '+' : ''}${Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2)}`;

export function PnlCalendar({ picked, onPick, bare = false }: { picked: string | null; onPick: (day: string | null) => void; bare?: boolean }) {
  const tz = new Date().getTimezoneOffset();
  const { data, error } = useApi<Calendar>(`/api/pnl-calendar?tz=${tz}`, 60_000, ['trade']);
  const now = new Date();
  const today = keyOf(now.getFullYear(), now.getMonth(), now.getDate());
  const [month, setMonth] = useState(() => (picked ? { y: Number(picked.slice(0, 4)), m: Number(picked.slice(5, 7)) - 1 } : { y: now.getFullYear(), m: now.getMonth() }));

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
  const sel = picked ? byDay.get(picked) : undefined;
  const isThisMonth = month.y === now.getFullYear() && month.m === now.getMonth();
  const step = (k: number) => setMonth(({ y, m }) => ({ y: m + k < 0 ? y - 1 : m + k > 11 ? y + 1 : y, m: (m + k + 12) % 12 }));
  const max = Math.max(0.0001, ...inMonth.map((d) => Math.abs(d.pnlSol)));

  return (
    <div className={bare ? '' : 'pop rounded-2xl border border-line bg-surface-2/40 p-3 sm:p-4'}>
      {error && <p className="mb-2 text-sm text-down">{error}</p>}
      <div className="mb-3 flex items-center justify-between gap-2">
        <button type="button" aria-label="Previous month" onClick={() => step(-1)} className="grid h-10 w-10 place-items-center rounded-full text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink">
          <Icon name="chevron" size={18} className="rotate-180" />
        </button>
        <div className="text-center">
          <div className="text-sm font-semibold text-ink">{first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</div>
          <div className="tabular mt-0.5 text-xs text-muted">
            <Pnl value={monthPnl} /> · <span className="text-up">{green} up</span> · <span className="text-down">{red} down</span>
          </div>
        </div>
        <button type="button" aria-label="Next month" disabled={isThisMonth} onClick={() => step(1)} className="grid h-10 w-10 place-items-center rounded-full text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-30">
          <Icon name="chevron" size={18} />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-1.5 text-center">
        {WEEK.map((w) => (
          <div key={w} className="pb-1 text-[11px] font-medium uppercase tracking-wide text-muted">{w}</div>
        ))}
        {cells.map((d, i) => {
          if (d === null) return <div key={`e${i}`} />;
          const k = keyOf(month.y, month.m, d);
          const v = byDay.get(k);
          const intensity = v ? 0.14 + 0.5 * Math.min(1, Math.abs(v.pnlSol) / max) : 0;
          const bg = v && v.pnlSol > 0 ? `rgba(var(--pnl-up-bg), ${intensity})` : v && v.pnlSol < 0 ? `rgba(var(--pnl-down-bg), ${intensity})` : undefined;
          const future = k > today;
          const isToday = k === today;
          const on = picked === k;
          return (
            <button
              key={k}
              type="button"
              disabled={future}
              aria-pressed={on}
              aria-label={`${new Date(`${k}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}${v ? `, ${short(v.pnlSol)} SOL` : ''}`}
              onClick={() => onPick(on ? null : k)}
              style={bg ? { backgroundColor: bg } : undefined}
              className={`flex min-h-[2.9rem] flex-col items-center justify-center rounded-xl text-[11px] leading-tight transition-[transform,box-shadow,background-color] duration-150 ${on ? 'ring-2 ring-accent ring-offset-1 ring-offset-page' : isToday ? 'ring-1 ring-line-strong' : ''} ${!v && !future ? 'bg-surface/60' : ''} ${future ? 'opacity-30' : 'hover:scale-[1.04]'}`}
            >
              <span className={`${isToday ? 'font-bold text-ink' : 'text-ink-2'}`}>{d}</span>
              {v && <span className={`tabular mt-0.5 font-semibold ${v.pnlSol > 0 ? 'text-up' : v.pnlSol < 0 ? 'text-down' : 'text-ink-2'}`}>{short(v.pnlSol)}</span>}
            </button>
          );
        })}
      </div>
      {picked && (
        <div className="fade-in mt-3 rounded-xl border border-line bg-surface p-3 text-sm">
          {sel ? (
            <>
              <div className="flex items-baseline justify-between gap-2">
                <span className="tabular text-xs text-muted">
                  {sel.trades} trade{sel.trades === 1 ? '' : 's'} · {sel.volumeSol.toFixed(2)} SOL traded{sel.winRate !== null ? ` · ${Math.round(sel.winRate)}% wins` : ''}
                </span>
                <Pnl value={sel.pnlSol} />
              </div>
              <ul className="mt-2 divide-y divide-line text-xs">
                {sel.byStrategy.map((s) => (
                  <li key={s.strategy} className="flex justify-between gap-2 py-1.5">
                    <span className="text-ink-2">{STRATEGY_LABEL[s.strategy] ?? s.strategy} · {s.trades}</span>
                    <Pnl value={s.pnlSol} />
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-xs text-muted">No closed trades on this day.</p>
          )}
        </div>
      )}
    </div>
  );
}
