/** Wallets page: analyze any wallet's trading (Solscan or our own RPC) — patterns + "could we copy it?". */
import { useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { shortAddr } from '../lib/format';
import { Card } from './ui';

interface Coin { mint: string; symbol: string | null; buys: number; sells: number; solIn: number; solOut: number; pnlSol: number; pnlPct: number; holdSec: number | null; firstSellAfterSec: number | null; soldPct: number; exitMultiple: number | null; lastActionAt: number }
interface Sim { sizeSol: number; entrySlipPct: number; exitSlipPct: number; trades: number; wins: number; pnlSol: number; medianPct: number; endBalanceSol: number; maxDrawdownPct: number }
interface Report {
  address: string; generatedAt: string; cached: boolean; swapsRead: number; from: string | null; to: string | null; coins: number; tradesPerDay: number; buysPerDay: number;
  medianBuySol: number; avgBuySol: number; closedCoins: number; winRatePct: number; realisedPnlSol: number; profitFactor: number | null; medianWinPct: number; medianLossPct: number;
  medianHoldMin: number | null; medianFirstSellSec: number | null; busiestHoursUtc: number[]; style: string[]; best: Coin[]; worst: Coin[]; recent: Coin[]; copy: Sim[]; verdict: string;
  usage?: { today: number; cap: number };
  source?: string;
}

const hold = (s: number | null) => (s === null ? 'open' : s < 120 ? `${s}s` : s < 7200 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`);
const sign = (n: number) => `${n >= 0 ? '+' : ''}${n}`;

export function WalletAnalyzer() {
  const [address, setAddress] = useState('');
  const [pages, setPages] = useState(5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [r, setR] = useState<Report | null>(null);

  const run = async (e?: FormEvent, refresh = false) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setR(await api<Report>(`/api/wallets/${address.trim()}/report?pages=${pages}${refresh ? '&refresh=1' : ''}`));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Analyze a wallet" className="mb-4">
      <form onSubmit={(e) => void run(e)} className="grid gap-3 sm:grid-cols-[2fr_auto_auto] sm:items-end">
        <label className="flex min-w-0 flex-col gap-1 text-sm text-ink-2">
          Wallet address
          <input required value={address} onChange={(e) => setAddress(e.target.value)} placeholder="e.g. 7BNa…" className="rounded-lg border border-line bg-page px-3 py-2.5 font-mono text-sm text-ink" />
        </label>
        <label className="flex flex-col gap-1 text-sm text-ink-2">
          History
          <select value={pages} onChange={(e) => setPages(Number(e.target.value))} className="rounded-lg border border-line bg-page px-3 py-2.5 text-sm text-ink">
            <option value={2}>last 200 transactions</option>
            <option value={5}>last 500 transactions</option>
            <option value={10}>last 1000 transactions</option>
          </select>
        </label>
        <button type="submit" disabled={busy} className="rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">
          {busy ? 'Reading…' : 'Analyze'}
        </button>
      </form>
      <p className="mt-2 text-xs text-muted">
        Reads the wallet's history from the Solana node (~1 Helius credit per transaction) or Solscan when your plan allows it. Results are kept 30 min (no extra cost).
        {r?.source ? ` Source: ${r.source === 'rpc' ? 'Solana RPC' : 'Solscan'}.` : ''}
      </p>
      {error && <p className="mt-2 text-sm text-down">{error}</p>}
      {r && (
        <div className="mt-4 space-y-4 text-sm">
          <p className={`rounded-lg border px-3 py-2 ${/^Copyable/.test(r.verdict) ? 'border-up/40 bg-up/10' : 'border-warning/40 bg-warning/10'} text-ink`}>{r.verdict}</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Profit (sold part)" value={`${sign(r.realisedPnlSol)} SOL`} warn={r.realisedPnlSol < 0} />
            <Stat label="Win rate" value={`${r.winRatePct}%`} sub={`${r.closedCoins} finished coins`} />
            <Stat label="Median win / loss" value={`${sign(r.medianWinPct)}% / ${r.medianLossPct}%`} sub={r.profitFactor !== null ? `profit factor ${r.profitFactor}` : undefined} />
            <Stat label="Trades / day" value={String(r.tradesPerDay)} sub={`${r.buysPerDay} buys/day`} />
            <Stat label="Buy size" value={`${r.medianBuySol} SOL`} sub={`avg ${r.avgBuySol}`} />
            <Stat label="Hold (median)" value={r.medianHoldMin !== null ? `${r.medianHoldMin} min` : '—'} sub={r.medianFirstSellSec !== null ? `first sell after ${hold(r.medianFirstSellSec)}` : undefined} />
            <Stat label="Busiest hours (UTC)" value={r.busiestHoursUtc.map((h) => `${h}:00`).join(', ') || '—'} />
            <Stat label="History read" value={`${r.swapsRead} swaps`} sub={r.from ? `${new Date(r.from).toLocaleDateString()} → ${new Date(r.to!).toLocaleDateString()}${r.cached ? ' · cached' : ''}` : undefined} />
          </div>
          <ul className="list-disc space-y-1 pl-5 text-ink-2">{r.style.map((s) => <li key={s}>{s}</li>)}</ul>

          <div>
            <div className="mb-1 font-medium text-ink">If we had copied it (10 SOL account)</div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs tabular-nums">
                <thead className="text-muted"><tr><th className="py-1 pr-3">Size</th><th className="pr-3">Entry / exit worse</th><th className="pr-3">Trades</th><th className="pr-3">Wins</th><th className="pr-3">Median</th><th className="pr-3">Result</th><th>Worst drop</th></tr></thead>
                <tbody>
                  {r.copy.map((s) => (
                    <tr key={`${s.sizeSol}-${s.entrySlipPct}`} className="border-t border-line">
                      <td className="py-1 pr-3">{s.sizeSol} SOL</td>
                      <td className="pr-3">{s.entrySlipPct}% / {s.exitSlipPct}%</td>
                      <td className="pr-3">{s.trades}</td>
                      <td className="pr-3">{s.wins}</td>
                      <td className="pr-3">{sign(s.medianPct)}%</td>
                      <td className={`pr-3 font-semibold ${s.pnlSol >= 0 ? 'text-up' : 'text-down'}`}>{sign(s.pnlSol)} SOL → {s.endBalanceSol}</td>
                      <td>{s.maxDrawdownPct}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <CoinList title="Best coins" rows={r.best} />
          <CoinList title="Worst coins" rows={r.worst} />
          <CoinList title="Latest coins" rows={r.recent} />
          <button type="button" disabled={busy} onClick={() => void run(undefined, true)} className="rounded-xl border border-line px-4 py-2 text-xs font-semibold text-ink disabled:opacity-50">
            Refresh from Solscan (uses credits)
          </button>
        </div>
      )}
    </Card>
  );
}

function CoinList({ title, rows }: { title: string; rows: Coin[] }) {
  if (!rows.length) return null;
  return (
    <div>
      <div className="mb-1 font-medium text-ink">{title}</div>
      <ul className="divide-y divide-line text-xs">
        {rows.map((c) => (
          <li key={c.mint + title} className="flex min-w-0 items-center justify-between gap-2 py-1.5">
            <a href={`https://dexscreener.com/solana/${c.mint}`} target="_blank" rel="noreferrer" className="min-w-0 truncate font-semibold text-ink hover:underline">
              {c.symbol ?? shortAddr(c.mint)}
            </a>
            <span className="shrink-0 tabular-nums text-ink-2">
              {c.buys}b/{c.sells}s · in {c.solIn} → out {c.solOut} · {c.exitMultiple !== null ? `${c.exitMultiple}x` : '—'} · held {hold(c.holdSec)} ·{' '}
              <span className={c.pnlSol >= 0 ? 'text-up' : 'text-down'}>{sign(c.pnlSol)} SOL</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Stat({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-muted">{label}</div>
      <div className={`truncate font-medium tabular-nums ${warn ? 'text-down' : 'text-ink'}`}>{value}</div>
      {sub && <div className="truncate text-xs text-muted">{sub}</div>}
    </div>
  );
}
