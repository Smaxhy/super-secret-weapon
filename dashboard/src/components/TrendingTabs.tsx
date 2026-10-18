/**
 * Trending tabs (Scanner page): coins on pump.fun's own tabs (live streams with real viewer
 * counts, King of the Hill, for-you, top runners) and GeckoTerminal's trending pools, plus the
 * health of each feed and DexScreener's trending narratives.
 */
import { Link } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import { DexTrending } from './DexTrending';
import { Card, SectionHeader } from './ui';

interface Coin {
  mint: string;
  symbol: string;
  name: string;
  rank: number;
  usdMarketCap: number | null;
  viewers: number | null;
  live: boolean;
  complete: boolean | null;
  banned: boolean;
  mayhem: boolean;
  sources: string[];
}
interface Health {
  source: string;
  ok: boolean;
  coins: number;
  updatedAt: string | null;
  pausedUntil: string | null;
  error: string | null;
}

const LABEL: Record<string, string> = {
  pump_live: 'live',
  pump_koth: 'KOTH',
  pump_for_you: 'for you',
  pump_runners: 'runners',
  gecko_5m: 'Gecko 5m',
  gecko_1h: 'Gecko 1h',
  dex_metas: 'Dex narratives',
};
const k = (n: number | null) => (n === null ? '—' : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}k` : `$${Math.round(n)}`);

function CoinList({ coins, empty }: { coins: Coin[]; empty: string }) {
  if (!coins.length) return <p className="py-4 text-sm text-muted">{empty}</p>;
  return (
    <ol className="divide-y divide-line text-sm">
      {coins.slice(0, 15).map((c, i) => (
        <li key={c.mint} className="flex min-h-11 min-w-0 items-center justify-between gap-2 py-1.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className="tabular w-5 shrink-0 text-xs text-muted">{i + 1}</span>
            <Link to={`/token/${c.mint}`} className="truncate font-semibold text-ink hover:underline">
              {c.symbol || c.mint.slice(0, 6)}
            </Link>
            {c.live && <span className="shrink-0 rounded bg-critical/12 px-1 text-xs text-down">live{c.viewers !== null ? ` ${c.viewers}` : ''}</span>}
            {(c.banned || c.mayhem) && <span className="shrink-0 rounded border border-critical/40 px-1 text-xs text-down">{c.banned ? 'banned' : 'mayhem'}</span>}
          </span>
          <span className="tabular shrink-0 text-right text-xs text-ink-2">
            {k(c.usdMarketCap)}
            <span className="block text-[11px] text-muted">{c.sources.map((x) => LABEL[x] ?? x).join(' · ')}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Scanner → Trending: a three-column board — pump.fun live · other lists (and their health) · DexScreener. */
export function TrendingBoard() {
  const { data } = useApi<{ coins: Coin[]; health: Health[]; narratives: string[] }>('/api/trending', 30_000);
  const live = (data?.coins ?? []).filter((c) => c.sources.includes('pump_live')).sort((a, b) => (b.viewers ?? 0) - (a.viewers ?? 0));
  const other = (data?.coins ?? []).filter((c) => !c.sources.includes('pump_live'));
  const pumpOff = (data?.health ?? []).filter((h) => ['pump_koth', 'pump_for_you', 'pump_runners'].includes(h.source) && !h.ok);
  return (
    <div className="flex flex-col gap-4">
      <SectionHeader title="Trending" description="A coin new on a list is checked straight away, never bought just for trending: lists usually catch a coin after its move." />
      {data && (
        <div className="flex flex-wrap gap-1.5 text-xs">
          {data.health.map((h) => (
            <span key={h.source} title={h.error ?? (h.updatedAt ? `updated ${new Date(h.updatedAt).toLocaleTimeString()}` : 'not yet')} className={`inline-flex min-h-7 items-center gap-1.5 rounded-full border px-2.5 ${h.ok ? 'border-good/40 text-up' : h.pausedUntil ? 'border-line text-muted' : 'border-critical/40 text-down'}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${h.ok ? 'bg-good' : h.pausedUntil ? 'bg-line-strong' : 'bg-critical'}`} aria-hidden="true" />
              {LABEL[h.source] ?? h.source}: {h.ok ? h.coins : h.pausedUntil ? 'paused' : 'off'}
            </span>
          ))}
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="pump.fun live" subtitle="Streams with real viewer counts">
          {data ? <CoinList coins={live} empty="No live streams in the list right now." /> : <p className="text-sm text-muted">Loading…</p>}
        </Card>
        <Card title="Other lists" subtitle="King of the hill, for you, runners, GeckoTerminal">
          {pumpOff.length > 0 && (
            <div className="mb-3 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2.5 text-xs text-ink">
              <span className="font-semibold">{pumpOff.map((h) => LABEL[h.source] ?? h.source).join(', ')} off.</span> pump.fun moved these lists. They come back once their new addresses are set in the bot config.
            </div>
          )}
          {data ? <CoinList coins={other} empty="No coins on the other lists yet." /> : <p className="text-sm text-muted">Loading…</p>}
          {!!data?.narratives.length && (
            <div className="mt-3 border-t border-line pt-3">
              <div className="mb-1.5 text-xs font-medium text-muted">Trending narratives</div>
              <div className="flex flex-wrap gap-1.5">
                {data.narratives.map((n) => (
                  <span key={n} className="rounded-full bg-surface-2 px-2.5 py-0.5 text-xs text-ink">{n}</span>
                ))}
              </div>
            </div>
          )}
        </Card>
        <DexTrending />
      </div>
    </div>
  );
}
