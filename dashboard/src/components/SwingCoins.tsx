/**
 * Swing coins (Positions page): the bigger coins the bot follows for swing trades — your
 * watchlist (paste a coin's contract address), trending coins that already migrated, and our own
 * coins that grew. Shows each coin's bounce-back power (how often its 20%+ dips got bought back
 * in the last 24 h) and what the bot thinks of it right now.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import { api } from '../lib/api';
import { Card } from './ui';

interface Bounce {
  recovered: number;
  failed: number;
  dips: number;
  avgDipPct: number | null;
  avgRecoverMin: number | null;
  fromHighPct: number;
  higherLows: boolean | null;
  score: number;
  spanHours: number;
}
interface Coin {
  mint: string;
  symbol: string;
  name: string;
  sources: string[];
  trendingLists: string[];
  watchlist: boolean;
  live: boolean;
  out: string | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  priceChange24hPct: number | null;
  bounce: Bounce | null;
  holders: { top10Pct: number } | null;
  last: { at: number; score: number; decision: string; why: string } | null;
}
interface SwingData {
  enabled: boolean;
  watchlist: string[];
  maxWatchlist: number;
  rules: { minMarketCapUsd: number; maxMarketCapUsd: number; minLiquidityUsd: number; minVolume24hUsd: number; minAgeMin: number; minScore: number; maxCoins: number };
  coins: Coin[];
  trader: { checks: number; setups: number; entered: number; learning: number } | null;
  pda: { match: number; mismatch: number; foreignCreator: number } | null;
  history: { ok: boolean; error: string | null } | null;
}

const usd = (n: number | null) => (n === null ? '—' : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}k` : `$${Math.round(n)}`);
const SRC: Record<string, string> = { watchlist: 'your list', trending: 'trending', dex: 'DexScreener', grown: 'grew here' };
const DECISION: Record<string, string> = { BUY: 'bought', LEARN: 'learning buy', SKIP: 'skipped', WAIT: 'watching', HOLD: 'holding' };

function Power({ b }: { b: Bounce | null }) {
  if (!b) return <span className="text-muted">history loading…</span>;
  const tone = b.score >= 0.6 ? 'text-up' : b.score >= 0.35 ? 'text-ink' : 'text-down';
  return (
    <span className={tone} title={`${b.recovered} of ${b.recovered + b.failed} dips of 20%+ were bought back in the last ${b.spanHours}h${b.avgDipPct !== null ? `, avg dip ${b.avgDipPct}%` : ''}${b.avgRecoverMin !== null ? `, back in ~${b.avgRecoverMin} min` : ''}${b.higherLows ? ', higher lows' : ''}`}>
      bounce-back {(b.score * 100).toFixed(0)} · {b.recovered}/{b.recovered + b.failed} dips recovered
    </span>
  );
}

export function SwingCoins() {
  const { data, reload } = useApi<SwingData>('/api/swing', 20_000);
  const [mint, setMint] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!data) return null;

  const add = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await api('/api/swing/watchlist', { method: 'POST', body: JSON.stringify({ mint: mint.trim() }) });
      setMint('');
      setMsg('Added — the bot starts following it within a minute (if it trades on PumpSwap).');
      await reload();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (m: string) => {
    await api(`/api/swing/watchlist/${m}`, { method: 'DELETE' }).catch(() => undefined);
    await reload();
  };
  const live = data.coins.filter((c) => c.live);
  const waiting = data.coins.filter((c) => !c.live && c.watchlist);

  return (
    <Card title="Swing coins (bigger coins that bounce back)" className="mb-4">
      <p className="mb-2 text-sm text-ink-2">
        Established coins ({usd(data.rules.minMarketCapUsd)}–{usd(data.rules.maxMarketCapUsd)} MC, migrated {data.rules.minAgeMin}+ min ago) that the bot follows trade by trade. It buys when one dips, holds a higher
        low and bounces with buyers in control — and favours coins whose dips keep getting bought back. {data.trader ? `${data.trader.entered} swing buys so far (${data.trader.learning} learning), ${data.trader.setups} setups seen.` : ''}
        {!data.enabled && <span className="text-down"> Swing trading is switched off.</span>}
      </p>
      <div className="mb-3 flex flex-wrap gap-2">
        <input
          value={mint}
          onChange={(e) => setMint(e.target.value)}
          placeholder="Paste a coin's contract address (e.g. $clude's)"
          className="min-w-0 flex-1 rounded-lg border border-line bg-page px-3 py-2 text-sm text-ink"
        />
        <button onClick={() => void add()} disabled={busy || mint.trim().length < 32} className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
          Add to swing list
        </button>
      </div>
      {msg && <p className="mb-2 text-xs text-ink-2">{msg}</p>}
      {data.watchlist.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5 text-xs">
          {data.watchlist.map((m) => {
            const c = data.coins.find((x) => x.mint === m);
            return (
              <span key={m} className="flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-ink">
                {c?.symbol || `${m.slice(0, 4)}…${m.slice(-4)}`}
                <button onClick={() => void remove(m)} className="text-muted hover:text-down" aria-label="remove">
                  ✕
                </button>
              </span>
            );
          })}
        </div>
      )}
      {live.length ? (
        <ul className="divide-y divide-line text-sm">
          {live.slice(0, 30).map((c) => (
            <li key={c.mint} className="flex min-w-0 flex-wrap items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Link to={`/token/${c.mint}`} className="truncate font-semibold text-ink hover:underline">
                    {c.symbol || c.mint.slice(0, 6)}
                  </Link>
                  {c.watchlist && <span className="shrink-0 rounded bg-accent/15 px-1 text-xs text-accent">your list</span>}
                  <span className="truncate text-xs text-muted">{c.sources.filter((s) => s !== 'watchlist').map((s) => SRC[s] ?? s).join(' · ')}</span>
                </div>
                <div className="truncate text-xs">
                  <Power b={c.bounce} />
                </div>
                {c.last && <div className="truncate text-xs text-muted">{DECISION[c.last.decision] ?? c.last.decision}: {c.last.why}</div>}
              </div>
              <div className="shrink-0 text-right text-xs tabular-nums text-ink-2">
                <div className="text-sm text-ink">{usd(c.marketCapUsd)}</div>
                <div>liq {usd(c.liquidityUsd)}</div>
                {c.priceChange24hPct !== null && <div className={c.priceChange24hPct >= 0 ? 'text-up' : 'text-down'}>{c.priceChange24hPct >= 0 ? '+' : ''}{c.priceChange24hPct.toFixed(0)}% 24h</div>}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">No swing coins yet — the list fills from trending coins within a few minutes of the bot starting, or add one above.</p>
      )}
      {waiting.length > 0 && (
        <p className="mt-2 text-xs text-muted">
          Not followed right now: {waiting.map((c) => `${c.symbol || c.mint.slice(0, 6)} (${c.out ?? 'checking'})`).join(', ')}
        </p>
      )}
      {data.pda && data.pda.mismatch > 0 && data.pda.match === 0 && <p className="mt-2 text-xs text-down">Pool address check failed on {data.pda.mismatch} migrations — swing coins may not be followed correctly.</p>}
      {data.history && !data.history.ok && data.history.error && <p className="mt-1 text-xs text-muted">Price history (GeckoTerminal): {data.history.error}</p>}
    </Card>
  );
}
