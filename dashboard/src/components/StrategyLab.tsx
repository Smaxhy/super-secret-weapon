/**
 * Strategy lab: every BUY signal is also traded VIRTUALLY by several exit setups (same live
 * prices, same fees). Shows which setup actually makes money — the bot switches its live exits
 * to the best one once the evidence is strong (never for owner-only tests like a wider stop).
 */
import { useApi } from '../hooks/useApi';
import { Card } from './ui';

interface Stats {
  id: string;
  name: string;
  n: number;
  winRate: number;
  avgPnlPct: number;
  medianPnlPct: number;
  sumPnlPct: number;
  avgWinPct: number;
  avgLossPct: number;
  profitFactor: number | null;
  lowerPct: number;
}
interface LabData {
  enabled: boolean;
  variants: Array<Stats & { live: boolean; ownerOnly: boolean; near: Stats }>;
  applied: { id: string; at: number } | null;
  open: number;
  autoApply: boolean;
  minTrades: number;
}

const signed = (x: number) => `${x > 0 ? '+' : ''}${x.toFixed(1)}%`;
const tone = (x: number) => (x > 0 ? 'text-up' : x < 0 ? 'text-down' : 'text-ink-2');

export function StrategyLab() {
  const { data } = useApi<LabData>('/api/lab', 30_000);
  if (!data?.enabled) return null;
  const best = [...data.variants].filter((v) => v.n >= data.minTrades).sort((a, b) => b.lowerPct - a.lowerPct)[0];
  return (
    <Card title="Strategy lab — which exit setup really makes money" className="mt-4">
      <p className="mb-3 text-sm text-ink-2">
        Every buy signal is also traded on paper by each setup below (same prices, same fees, no money moves). {data.open} test trades open.
        {data.autoApply ? ` Once a setup has ${data.minTrades}+ results and clearly beats the live one, the bot switches to it.` : ' Auto-switching is off.'}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm tabular-nums">
          <thead>
            <tr className="text-left text-ink-2">
              <th className="pb-2 font-medium">Setup</th>
              <th className="pb-2 font-medium">Trades</th>
              <th className="pb-2 font-medium">Win rate</th>
              <th className="pb-2 font-medium">Avg / trade</th>
              <th className="pb-2 font-medium">Avg win / loss</th>
              <th className="pb-2 font-medium">Near-misses</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {data.variants.map((v) => (
              <tr key={v.id} className={best?.id === v.id ? 'bg-up/5' : ''}>
                <td className="py-2 pr-2">
                  <div className="font-medium text-ink">
                    {v.name}
                    {v.live && <span className="ml-2 rounded bg-accent/15 px-1.5 py-0.5 text-xs text-accent">LIVE</span>}
                    {best?.id === v.id && <span className="ml-2 rounded bg-up/15 px-1.5 py-0.5 text-xs text-up">best</span>}
                  </div>
                  {v.ownerOnly && <div className="text-xs text-muted">test only — needs your OK to use</div>}
                </td>
                <td className="py-2">{v.n}</td>
                <td className="py-2">{v.n ? `${v.winRate.toFixed(0)}%` : '—'}</td>
                <td className={`py-2 ${tone(v.avgPnlPct)}`}>{v.n ? signed(v.avgPnlPct) : '—'}</td>
                <td className="py-2 text-ink-2">{v.n ? `${signed(v.avgWinPct)} / ${signed(v.avgLossPct)}` : '—'}</td>
                <td className={`py-2 ${tone(v.near.avgPnlPct)}`}>{v.near.n ? `${v.near.n} · ${signed(v.near.avgPnlPct)}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.applied && <p className="mt-2 text-xs text-muted">Switched the live exits to "{data.variants.find((v) => v.id === data.applied!.id)?.name ?? data.applied.id}" on {new Date(data.applied.at).toLocaleString()}.</p>}
    </Card>
  );
}
