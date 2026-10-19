/**
 * Performance → Money: "Who's actually making money" — the copy replay. Walks the recorded tape, finds wallets whose
 * record qualifies as a winner, copies their NEXT buys (our costs, mirror their sells) and reports whether that paid.
 * One button adds the wallets that paid in both halves of the test as COPY wallets.
 */
import { useEffect, useState } from 'react';
import { useApi } from '../hooks/useApi';
import { api } from '../lib/api';
import { ago, shortAddr } from '../lib/format';
import { Icon } from './Icon';
import { Badge, Button, Card, Loading, NumberInput, Row, Rows, StatTile } from './ui';

interface Agg { n: number; winPct: number; avgPct: number; medianPct: number; totalSol: number; profitFactor: number | null }
interface WalletRow { wallet: string; kind: 'proven' | 'tracked'; label: string | null; qualifiedAt: number | null; n: number; winPct: number; avgPct: number; medianPct: number; totalSol: number; profitFactor: number | null; medianHoldMin: number; firstHalfSol: number; secondHalfSol: number; consistent: boolean; own: { sells: number; winRate: number; realized: number } | null }
interface Report {
  id: string; from: string; to: string; rows: number; wallets: number; qualified: number; sizeSol: number;
  overall: Agg; byKind: Array<Agg & { kind: 'proven' | 'tracked'; wallets: number }>;
  byExit: Array<{ reason: string; n: number; totalSol: number; avgPct: number }>;
  byDay: Array<{ day: string; n: number; sol: number; cumSol: number }>;
  wallets_: WalletRow[]; copyable: WalletRow[]; verdict: string; durationMs: number;
}
interface Job { id: string; startedAt: string; log: string[]; finishedAt: string | null; exitCode: number | null }
interface Data { running: Job | null; lastJob: Job | null; last: Report | null }

const signed = (x: number, dp = 1) => `${x >= 0 ? '+' : ''}${x.toFixed(dp)}`;
const tone = (x: number) => (x > 0 ? 'text-up' : x < 0 ? 'text-down' : 'text-ink-2');

export function CopyReplay() {
  const { data, error, reload } = useApi<Data>('/api/copy-replay', 60_000);
  const [days, setDays] = useState('5');
  const [size, setSize] = useState('0.5');
  const [method, setMethod] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const running = !!data?.running;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void reload(), 5_000);
    return () => clearInterval(t);
  }, [running, reload]);
  const run = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const d = Math.min(7, Math.max(1, Number(days) || 5));
      await api('/api/copy-replay/run', { method: 'POST', body: JSON.stringify({ from: new Date(Date.now() - d * 86_400_000).toISOString(), sizeSol: Number(size) || 0.5, method }) });
      await reload();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const r = data?.last ?? null;
  const copyNow = async () => {
    if (!r?.copyable.length) return;
    setBusy(true);
    try {
      const text = r.copyable.map((w) => `copy-${w.wallet.slice(0, 6)} ${w.wallet}`).join('\n');
      const res = await api<{ added: number }>('/api/wallets/bulk', { method: 'POST', body: JSON.stringify({ text, kind: 'COPY' }) });
      setAdded(`${res.added} wallets now copied live (Wallets → KOLs to manage them).`);
    } catch (e) {
      setAdded((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card
      title="Who's actually making money?"
      subtitle="Walks the recorded tape: the moment a wallet's record qualifies as a winner, its next buys are copied (our costs, sold when it sells). Every result is out of sample. Method only = a wallet's record counts just the trades it held 5+ minutes and bought 60+ s after the first trade — people with a repeatable method, not block snipers."
      action={
        <div className="flex flex-wrap items-center gap-2">
          <NumberInput size="sm" label="Days" value={days} onChange={setDays} min={1} max={7} step={1} unit="d" className="w-24" />
          <label className="flex items-center gap-1.5 text-xs text-ink-2"><input type="checkbox" checked={method} onChange={(e) => setMethod(e.target.checked)} />Method only</label>
          <NumberInput size="sm" label="SOL per copy" value={size} onChange={setSize} min={0.05} max={10} step={0.1} unit="SOL" className="w-32" />
          <Button size="sm" disabled={busy || running} onClick={() => void run()}>
            <Icon name="play" size={14} />
            {running ? 'Running…' : 'Run'}
          </Button>
        </div>
      }
    >
      {error && <p className="text-sm text-down">{error}</p>}
      {msg && <p className="mb-3 text-sm text-down">{msg}</p>}
      {!data && !error && <Loading kind="rows" />}
      {data?.running && (
        <div className="mb-4 rounded-xl border border-line bg-surface-2/50 p-3 text-sm">
          <div className="text-ink">Walking the tape since {new Date(data.running.startedAt).toLocaleTimeString()}… about 6 minutes per day of tape.</div>
          {data.running.log.slice(-2).map((l, i) => (
            <div key={i} className="mt-1 truncate text-xs text-muted">{l}</div>
          ))}
        </div>
      )}
      {data?.lastJob && data.lastJob.exitCode !== 0 && data.lastJob.exitCode !== null && !data.running && (
        <p className="mb-3 text-sm text-down">The last run failed: {data.lastJob.log.slice(-2).join(' · ') || `exit code ${data.lastJob.exitCode}`}</p>
      )}
      {data && !r && !data.running && <p className="text-sm text-ink-2">Not run yet. Press Run — it reads the tape (up to 5–7 days) and takes a few minutes.</p>}
      {r && (
        <div className="flex flex-col gap-5">
          <p className={`rounded-xl border p-3 text-sm ${r.copyable.length ? 'border-good/40 bg-good/5 text-ink' : 'border-line bg-surface-2/40 text-ink-2'}`}>{r.verdict}</p>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <StatTile compact label="Copies" value={r.overall.n.toLocaleString()} sub={`${r.qualified} winners found of ${r.wallets.toLocaleString()} wallets`} />
            <StatTile compact label="Result" value={`${signed(r.overall.totalSol, 2)} SOL`} sub={`at ${r.sizeSol} SOL a copy`} tone={r.overall.totalSol > 0 ? 'up' : r.overall.totalSol < 0 ? 'down' : undefined} />
            <StatTile compact label="Won" value={`${r.overall.winPct}%`} sub={`median ${signed(r.overall.medianPct)}%`} />
            <StatTile compact label="Avg per copy" value={`${signed(r.overall.avgPct)}%`} tone={r.overall.avgPct > 0 ? 'up' : 'down'} sub={r.overall.profitFactor !== null ? `profit factor ${r.overall.profitFactor}` : undefined} />
            <StatTile compact label="Copyable wallets" value={r.copyable.length} sub="paid in both halves" tone={r.copyable.length ? 'up' : undefined} />
          </div>
          {r.copyable.length > 0 && (
            <div className="flex flex-wrap items-center gap-3">
              <Button disabled={busy} onClick={() => void copyNow()}>
                <Icon name="plus" size={14} />
                Copy these {r.copyable.length} wallets live
              </Button>
              {added && <span className="text-sm text-ink-2">{added}</span>}
            </div>
          )}
          <div className="grid gap-5 lg:grid-cols-2">
            <div>
              <div className="mb-2 text-xs font-semibold text-muted">By kind</div>
              <Rows>
                {r.byKind.map((k) => (
                  <Row key={k.kind} label={k.kind === 'proven' ? `Winners found on the tape (${k.wallets})` : `Your tracked wallets (${k.wallets})`} value={<span className={tone(k.totalSol)}>{signed(k.totalSol, 2)} SOL</span>} sub={`${k.n} copies · ${k.winPct}% won · avg ${signed(k.avgPct)}%`} />
                ))}
                {r.byExit.map((e) => (
                  <Row key={e.reason} label={`Exit: ${e.reason}`} value={<span className={tone(e.totalSol)}>{signed(e.totalSol, 2)} SOL</span>} sub={`${e.n} copies · avg ${signed(e.avgPct)}%`} tone="muted" />
                ))}
              </Rows>
            </div>
            <div>
              <div className="mb-2 text-xs font-semibold text-muted">Day by day</div>
              {!r.byDay.length ? (
                <p className="text-sm text-ink-2">No copies closed.</p>
              ) : (
                <Rows>
                  {r.byDay.map((d) => (
                    <Row key={d.day} label={d.day} value={<span className={tone(d.sol)}>{signed(d.sol, 2)} SOL</span>} sub={`${d.n} copies · running total ${signed(d.cumSol, 2)} SOL`} />
                  ))}
                </Rows>
              )}
            </div>
          </div>
          <div>
            <div className="mb-2 text-xs font-semibold text-muted">Wallets (best first)</div>
            <div className="overflow-x-auto">
              <table className="tabular w-full min-w-[40rem] text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted">
                    <th className="py-2 font-medium">Wallet</th>
                    <th className="py-2 text-right font-medium">Copies</th>
                    <th className="py-2 text-right font-medium">Won</th>
                    <th className="py-2 text-right font-medium">Avg</th>
                    <th className="py-2 text-right font-medium">Result</th>
                    <th className="py-2 text-right font-medium">1st / 2nd half</th>
                    <th className="py-2 text-right font-medium">Hold</th>
                    <th className="py-2 text-right font-medium">Its own record</th>
                  </tr>
                </thead>
                <tbody>
                  {r.wallets_.slice(0, 20).map((w) => (
                    <tr key={w.wallet} className="border-t border-line">
                      <td className="py-2">
                        <a href={`https://solscan.io/account/${w.wallet}`} target="_blank" rel="noreferrer" className="font-medium text-ink hover:underline">{w.label ?? shortAddr(w.wallet)}</a>
                        <span className="ml-2 inline-flex gap-1">
                          <Badge tone={w.kind === 'tracked' ? 'accent' : 'neutral'}>{w.kind === 'tracked' ? 'yours' : 'found'}</Badge>
                          {w.consistent && <Badge tone="up">consistent</Badge>}
                        </span>
                      </td>
                      <td className="py-2 text-right text-ink-2">{w.n}</td>
                      <td className="py-2 text-right text-ink-2">{w.winPct}%</td>
                      <td className={`py-2 text-right ${tone(w.avgPct)}`}>{signed(w.avgPct)}%</td>
                      <td className={`py-2 text-right font-semibold ${tone(w.totalSol)}`}>{signed(w.totalSol, 2)} SOL</td>
                      <td className="py-2 text-right text-ink-2">
                        <span className={tone(w.firstHalfSol)}>{signed(w.firstHalfSol, 2)}</span> / <span className={tone(w.secondHalfSol)}>{signed(w.secondHalfSol, 2)}</span>
                      </td>
                      <td className="py-2 text-right text-ink-2">{w.medianHoldMin} min</td>
                      <td className="py-2 text-right text-ink-2">{w.own ? `${w.own.sells} sells · ${Math.round(w.own.winRate * 100)}% · ${signed(w.own.realized, 1)} SOL` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <p className="text-xs text-muted">
            {r.from.slice(0, 10)} → {r.to.slice(0, 10)} · {r.rows.toLocaleString()} trades · took {(r.durationMs / 1000).toFixed(0)} s · {ago(r.to)}. Costs: 1.25% fee + 0.8% slippage each way, real tx fees. Hard stop −35%, max hold 6 h. Winners' buys in a coin's first 15 s aren't copied (sniper edge we can't match).
          </p>
        </div>
      )}
    </Card>
  );
}
