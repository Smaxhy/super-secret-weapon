/**
 * Performance → Tests: "Moonshot test" — migrated coins where huge real buying, KOLs and trending all lined up,
 * traded as pretend trades with moonshot exits vs the normal exits (GET /api/moonshot). No money involved.
 */
import { useApi } from '../hooks/useApi';
import { ago } from '../lib/format';
import { Card, Empty, Stat } from './ui';

interface Agg { n: number; avgPct: number; winRatePct: number; went2xPct: number; bestPct: number }
interface Report {
  live: boolean;
  open: number;
  setups: number;
  moonshot: Agg;
  normal: Agg;
  recent: Array<{ mint: string; symbol: string; openedAtMs: number; pnlPct: number; peakX: number; exitReason: string; why: string }>;
  lastSetups: Array<{ mint: string; symbol: string; at: string; why: string }>;
}

const signed = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`;
const tone = (x: number) => (x > 0 ? 'up' : x < 0 ? 'down' : undefined) as 'up' | 'down' | undefined;

export function MoonshotCard() {
  const { data } = useApi<Report | null>('/api/moonshot', 60_000);
  return (
    <Card title="Moonshot test" subtitle="Migrated coins where huge real buying, KOLs holding and trending all lined up. Pretend trades only — moonshot exits vs normal exits.">
      {!data ? (
        <p className="text-sm text-ink-2">Starting…</p>
      ) : (
        <div className="space-y-4 text-sm">
          <p className="text-xs text-muted">
            {data.live ? 'LIVE — trading these setups' : 'Test mode — no money'} · {data.setups} setups since the last restart · {data.open} pretend trades running
          </p>
          {data.moonshot.n + data.normal.n === 0 ? (
            <Empty>No finished moonshot setups yet. They're rare by design — expect a few a day on busy days.</Empty>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              {([['Moonshot exits', data.moonshot], ['Normal exits', data.normal]] as const).map(([label, a]) => (
                <div key={label} className="rounded-xl border border-line p-3">
                  <div className="mb-2 font-medium text-ink">{label}</div>
                  <div className="grid grid-cols-2 gap-3">
                    <Stat label="Avg per trade" value={signed(a.avgPct)} tone={tone(a.avgPct)} sub={`${a.n} trades`} />
                    <Stat label="Wins" value={`${a.winRatePct}%`} sub={`${a.went2xPct}% went 2x`} />
                  </div>
                </div>
              ))}
            </div>
          )}
          {data.recent.length > 0 && (
            <ul className="-my-1 divide-y divide-line">
              {data.recent.map((r) => (
                <li key={`${r.mint}-${r.openedAtMs}`} className="flex items-start justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <div className="font-medium text-ink">{r.symbol}</div>
                    <div className="break-words text-xs text-muted">{r.why} · {ago(new Date(r.openedAtMs).toISOString())}</div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className={`tabular font-semibold ${r.pnlPct >= 0 ? 'text-up' : 'text-down'}`}>{signed(r.pnlPct)}</div>
                    <div className="tabular text-xs text-muted">peak {r.peakX}x</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}
