/** Performance → Money: the BOOST trade and the survivor trade, replayed on every graduate's PumpSwap tape. */
import { useEffect, useState } from 'react';
import { useApi } from '../hooks/useApi';
import { api } from '../lib/api';
import { ago } from '../lib/format';
import { Icon } from './Icon';
import { Button, Card, Loading, NumberInput } from './ui';

interface Agg { n: number; winPct: number; avgPct: number; medianPct: number; totalSol: number; profitFactor: number | null }
interface RuleRow extends Agg { cohort: 'boost' | 'survivor'; rule: string; byReason: Array<{ reason: string; n: number; avgPct: number }> }
interface Report { at: number; dropped?: number; from: string; to: string; graduates: number; withTape: number; survivors: number; sizeSol: number; rows: RuleRow[]; best: { cohort: string; rule: string } | null; verdict: string; durationMs: number }
interface Data { running: boolean; last: Report | null }

const signed = (x: number, dp = 1) => `${x >= 0 ? '+' : ''}${x.toFixed(dp)}`;
const tone = (x: number) => (x > 0 ? 'text-up' : x < 0 ? 'text-down' : 'text-ink-2');

export function CohortTest() {
  const { data, error, reload } = useApi<Data>('/api/cohort-test', 60_000);
  const [days, setDays] = useState('5');
  const [busy, setBusy] = useState(false);
  const running = !!data?.running;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void reload(), 5_000);
    return () => clearInterval(t);
  }, [running, reload]);
  const run = async () => {
    setBusy(true);
    try {
      await api('/api/cohort-test/run', { method: 'POST', body: JSON.stringify({ days: Number(days) || 5 }) });
      await reload();
    } finally {
      setBusy(false);
    }
  };
  const r = data?.last ?? null;
  const isBest = (x: RuleRow) => !!r?.best && x.cohort === r.best.cohort && x.rule === r.best.rule;
  const bestRow = r?.rows.find(isBest) ?? null;
  return (
    <Card
      title="BOOST trade & survivor trade"
      subtitle="Averages cap each trade at +300% and drop prints past 10× (fake pool prices); read the median first. Every graduate: buy 10 / 30 / 60 s after migration and sell at 1.3× / 1.5× / 2× or when pump.fun's 5-minute buy-and-burn ends (stop −30%). Survivors still trading 1–2 h after graduation: buy and hold up to 6 / 12 / 24 h with a 25% trail. All costs in."
      action={
        <div className="flex items-center gap-2">
          <NumberInput size="sm" label="Days" value={days} onChange={setDays} min={1} max={14} step={1} unit="d" className="w-24" />
          <Button size="sm" disabled={busy || running} onClick={() => void run()}>
            <Icon name="play" size={14} />
            {running ? 'Running…' : 'Run'}
          </Button>
        </div>
      }
    >
      {error && <p className="text-sm text-down">{error}</p>}
      {!data && !error && <Loading kind="rows" />}
      {running && <p className="mb-3 text-sm text-ink-2">Replaying graduates… a few minutes.</p>}
      {data && !r && !running && <p className="text-sm text-ink-2">Not run yet. Press Run.</p>}
      {r && (
        <div className="flex flex-col gap-4">
          <p className={`rounded-xl border p-3 text-sm ${r.verdict.startsWith('It pays') ? 'border-good/40 bg-good/5 text-ink' : 'border-line bg-surface-2/40 text-ink-2'}`}>{r.verdict}</p>
          <p className="text-xs text-muted">
            {r.graduates} graduates, {r.withTape} with a PumpSwap tape, {r.survivors} still alive at 1 h{r.dropped ? ` · ${r.dropped} broken price prints left out` : ''} · {r.from.slice(0, 10)} → {r.to.slice(0, 10)} · {r.sizeSol} SOL each · {ago(new Date(r.at).toISOString())}
          </p>
          <div className="overflow-x-auto">
            <table className="tabular w-full min-w-[36rem] text-sm">
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th className="py-1 font-medium">Trade</th>
                  <th className="py-1 font-medium">Rule</th>
                  <th className="py-1 text-right font-medium">Trades</th>
                  <th className="py-1 text-right font-medium">Won</th>
                  <th className="py-1 text-right font-medium">Avg</th>
                  <th className="py-1 text-right font-medium">Median</th>
                  <th className="py-1 text-right font-medium">Result</th>
                  <th className="py-1 text-right font-medium">PF</th>
                </tr>
              </thead>
              <tbody>
                {r.rows.map((x) => (
                  <tr key={`${x.cohort}:${x.rule}`} className={`border-t border-line ${isBest(x) ? 'bg-good/5' : ''}`}>
                    <td className="py-1.5 text-ink">{x.cohort === 'boost' ? 'BOOST' : 'Survivor'}</td>
                    <td className="py-1.5 text-ink">{x.rule}</td>
                    <td className="py-1.5 text-right text-ink-2">{x.n}</td>
                    <td className="py-1.5 text-right text-ink-2">{x.winPct}%</td>
                    <td className={`py-1.5 text-right ${tone(x.avgPct)}`}>{signed(x.avgPct)}%</td>
                    <td className={`py-1.5 text-right ${tone(x.medianPct)}`}>{signed(x.medianPct)}%</td>
                    <td className={`py-1.5 text-right font-semibold ${tone(x.totalSol)}`}>{signed(x.totalSol, 2)} SOL</td>
                    <td className="py-1.5 text-right text-ink-2">{x.profitFactor ?? '∞'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {bestRow && (
            <p className="text-xs text-muted">
              Best rule, how its trades ended: {bestRow.byReason.map((b) => `${b.reason} ×${b.n} (avg ${signed(b.avgPct)}%)`).join(' · ')}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
