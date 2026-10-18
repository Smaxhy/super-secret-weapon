/**
 * Performance → Money: the elite launch test — buy a repeat-graduator's launch seconds after it starts, sell into
 * graduation / a take-profit / a stop, on the recorded tape with real costs. Does the 42% graduation rate pay?
 */
import { useEffect, useState } from 'react';
import { useApi } from '../hooks/useApi';
import { api } from '../lib/api';
import { ago } from '../lib/format';
import { Icon } from './Icon';
import { Button, Card, Loading, NumberInput, Row, Rows } from './ui';

interface Agg { n: number; winPct: number; avgPct: number; medianPct: number; totalSol: number; profitFactor: number | null }
interface GridRow extends Agg { delaySec: number; tpX: number; graduatedPct: number; byReason: Array<{ reason: string; n: number; avgPct: number }> }
interface Report { at: number; from: string; to: string; launches: number; withTape: number; sizeSol: number; grid: GridRow[]; best: { delaySec: number; tpX: number } | null; splits: Array<Agg & { label: string }>; verdict: string; durationMs: number }
interface Data { running: boolean; last: Report | null }

const signed = (x: number, dp = 1) => `${x >= 0 ? '+' : ''}${x.toFixed(dp)}`;
const tone = (x: number) => (x > 0 ? 'text-up' : x < 0 ? 'text-down' : 'text-ink-2');

export function EliteTest() {
  const { data, error, reload } = useApi<Data>('/api/elite-test', 60_000);
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
      await api('/api/elite-test/run', { method: 'POST', body: JSON.stringify({ days: Number(days) || 5 }) });
      await reload();
    } finally {
      setBusy(false);
    }
  };
  const r = data?.last ?? null;
  const isBest = (g: GridRow) => !!r?.best && g.delaySec === r.best.delaySec && g.tpX === r.best.tpX;
  return (
    <Card
      title="Elite launch test"
      subtitle="Every launch by a creator who was a repeat graduator at that moment: buy 15 / 30 / 60 s after launch, sell into graduation, at a multiple, at −50% or after 60 min — on the recorded tape, all costs in."
      action={
        <div className="flex items-center gap-2">
          <NumberInput size="sm" label="Days" value={days} onChange={setDays} min={1} max={7} step={1} unit="d" className="w-24" />
          <Button size="sm" disabled={busy || running} onClick={() => void run()}>
            <Icon name="play" size={14} />
            {running ? 'Running…' : 'Run'}
          </Button>
        </div>
      }
    >
      {error && <p className="text-sm text-down">{error}</p>}
      {!data && !error && <Loading kind="rows" />}
      {running && <p className="mb-3 text-sm text-ink-2">Replaying elite launches… a few minutes.</p>}
      {data && !r && !running && <p className="text-sm text-ink-2">Not run yet. Press Run.</p>}
      {r && (
        <div className="flex flex-col gap-4">
          <p className={`rounded-xl border p-3 text-sm ${r.best && (r.grid.find(isBest)?.totalSol ?? 0) > 0 ? 'border-good/40 bg-good/5 text-ink' : 'border-line bg-surface-2/40 text-ink-2'}`}>{r.verdict}</p>
          <p className="text-xs text-muted">
            {r.launches} elite launches with tape ({r.withTape} had a price path) · {r.from.slice(0, 10)} → {r.to.slice(0, 10)} · {r.sizeSol} SOL each · {ago(new Date(r.at).toISOString())}
          </p>
          <div className="overflow-x-auto">
            <table className="tabular w-full min-w-[36rem] text-sm">
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th className="py-1 font-medium">Buy after</th>
                  <th className="py-1 font-medium">Sell rule</th>
                  <th className="py-1 text-right font-medium">Trades</th>
                  <th className="py-1 text-right font-medium">Won</th>
                  <th className="py-1 text-right font-medium">Avg</th>
                  <th className="py-1 text-right font-medium">Median</th>
                  <th className="py-1 text-right font-medium">Result</th>
                  <th className="py-1 text-right font-medium">PF</th>
                </tr>
              </thead>
              <tbody>
                {r.grid.map((g) => (
                  <tr key={`${g.delaySec}:${g.tpX}`} className={`border-t border-line ${isBest(g) ? 'bg-good/5' : ''}`}>
                    <td className="py-1.5 text-ink">{g.delaySec} s</td>
                    <td className="py-1.5 text-ink">{g.tpX ? `${g.tpX}× or graduation` : 'into graduation'}</td>
                    <td className="py-1.5 text-right text-ink-2">{g.n}</td>
                    <td className="py-1.5 text-right text-ink-2">{g.winPct}%</td>
                    <td className={`py-1.5 text-right ${tone(g.avgPct)}`}>{signed(g.avgPct)}%</td>
                    <td className={`py-1.5 text-right ${tone(g.medianPct)}`}>{signed(g.medianPct)}%</td>
                    <td className={`py-1.5 text-right font-semibold ${tone(g.totalSol)}`}>{signed(g.totalSol, 2)} SOL</td>
                    <td className="py-1.5 text-right text-ink-2">{g.profitFactor ?? '∞'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {r.best && (
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Best rule, how the trades ended</div>
                <Rows>
                  {(r.grid.find(isBest)?.byReason ?? []).map((x) => (
                    <Row key={x.reason} label={x.reason} value={<span className={tone(x.avgPct)}>{signed(x.avgPct)}% avg</span>} sub={`${x.n} trades`} />
                  ))}
                </Rows>
              </div>
              <div>
                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Best rule, by kind of elite creator</div>
                <Rows>
                  {r.splits.map((s) => (
                    <Row key={s.label} label={s.label} value={<span className={tone(s.totalSol)}>{signed(s.totalSol, 2)} SOL</span>} sub={s.n ? `${s.n} trades · ${s.winPct}% won · avg ${signed(s.avgPct)}%` : 'none'} />
                  ))}
                </Rows>
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
