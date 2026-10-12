/**
 * Performance page: "Backtest: other exits on the same trades" — the bot's real paper trades replayed on their real
 * trade tapes with the live exit settings and every exit-lab variant (GET /api/backtest).
 */
import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { Card } from './ui';

interface Report {
  at: string;
  days: number;
  trades: number;
  tapes: number;
  actual: { avgPnlPct: number; winRatePct: number } | null;
  variants: Array<{ id: string; name: string; ownerOnly: boolean; n: number; avgPnlPct: number; medianPnlPct: number; winRatePct: number; vsActualPct: number }>;
  note: string;
}

const signed = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`;
const tone = (x: number) => (x > 0 ? 'text-up' : x < 0 ? 'text-down' : 'text-ink-2');

export function Backtest() {
  const [days, setDays] = useState(7);
  const { data, error, loading } = useApi<Report | null>(`/api/backtest?days=${days}`, 0);
  return (
    <Card
      title="Backtest: other exits on the same trades"
      action={
        <select aria-label="Days" value={days} onChange={(e) => setDays(Number(e.target.value))} className="rounded-lg border border-line bg-page px-2 py-1 text-sm text-ink">
          {[1, 3, 7, 14].map((d) => (
            <option key={d} value={d}>
              last {d} day{d > 1 ? 's' : ''}
            </option>
          ))}
        </select>
      }
    >
      <p className="mb-3 text-xs text-muted">Every paper trade replayed on its real price path: same buy, different exit rules. Starts filling as trades are archived (from this update on).</p>
      {error && <p className="text-sm text-down">{error}</p>}
      {loading && !data && <p className="text-sm text-muted">Replaying…</p>}
      {data && !data.trades && <p className="text-sm text-ink-2">No archived trades yet — come back after a few trades.</p>}
      {data && data.trades > 0 && (
        <>
          <p className="mb-2 text-sm text-ink-2">
            {data.trades} trades on {data.tapes} coins · real result{' '}
            {data.actual && <span className={tone(data.actual.avgPnlPct)}>{signed(data.actual.avgPnlPct)} avg, {data.actual.winRatePct}% wins</span>}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm tabular-nums">
              <thead>
                <tr className="text-left text-ink-2">
                  <th className="pb-2 font-medium">Exit rules</th>
                  <th className="pb-2 font-medium">Avg</th>
                  <th className="pb-2 font-medium">Median</th>
                  <th className="pb-2 font-medium">Wins</th>
                  <th className="pb-2 font-medium">vs real</th>
                </tr>
              </thead>
              <tbody>
                {data.variants.map((v) => (
                  <tr key={v.id} className="border-t border-line">
                    <td className="py-2 pr-2 text-ink">
                      {v.name}
                      {v.ownerOnly && <span className="ml-1 text-xs text-muted">(outside your stop band — info only)</span>}
                    </td>
                    <td className={`py-2 ${tone(v.avgPnlPct)}`}>{signed(v.avgPnlPct)}</td>
                    <td className={`py-2 ${tone(v.medianPnlPct)}`}>{signed(v.medianPnlPct)}</td>
                    <td className="py-2 text-ink-2">{v.winRatePct}%</td>
                    <td className={`py-2 ${tone(v.vsActualPct)}`}>{signed(v.vsActualPct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-muted">{data.note}</p>
        </>
      )}
    </Card>
  );
}
