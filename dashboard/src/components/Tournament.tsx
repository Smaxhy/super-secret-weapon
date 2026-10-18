/** Performance → Tests: the policy tournament — Sniper variants trading virtually on the same live candidates. */
import { useMemo, useState } from 'react';
import { useApi } from '../hooks/useApi';
import { ago } from '../lib/format';
import { Badge, Card, Loading, Table, Th, tdCls, theadCls, trCls } from './ui';

type Status = 'winner' | 'leading' | 'losing' | 'too few' | 'baseline';
interface Row {
  id: string;
  name: string;
  n: number;
  winRate: number;
  avgPnlPct: number;
  profitFactor: number | null;
  totalSol: number;
  vsBaselinePts: number | null;
  q: number | null;
  status: Status;
}
interface Offer { variant: string; key: string; value: unknown; at: number; result: string }
interface Data { enabled: boolean; baseline: string; rows: Row[]; open: number; minResults: number; offers: Offer[] }

const TONE: Record<Status, 'up' | 'accent' | 'down' | 'neutral' | 'warn'> = { winner: 'up', leading: 'accent', losing: 'down', 'too few': 'neutral', baseline: 'warn' };
const pct = (x: number) => `${x > 0 ? '+' : ''}${x.toFixed(1)}%`;
const BASE: Record<string, string> = { live: 'the current settings', random: 'random coins (the current settings hardly trade yet)', zero: 'break-even (not enough results yet)' };

type Key = 'name' | 'n' | 'winRate' | 'avgPnlPct' | 'profitFactor' | 'vsBaselinePts';

export function Tournament() {
  const { data } = useApi<Data>('/api/tournament', 60_000);
  const [sort, setSort] = useState<{ key: Key; dir: 1 | -1 }>({ key: 'avgPnlPct', dir: -1 });
  const rows = useMemo(() => {
    const r = [...(data?.rows ?? [])];
    r.sort((a, b) => {
      const x = a[sort.key] ?? -Infinity;
      const y = b[sort.key] ?? -Infinity;
      return (typeof x === 'string' ? String(x).localeCompare(String(y)) : (x as number) - (y as number)) * sort.dir;
    });
    return r;
  }, [data, sort]);
  if (!data) return <Loading kind="table" />;
  if (!data.enabled) return null;
  const th = (key: Key, label: string, right = true) => (
    <Th right={right} active={sort.key === key} dir={sort.dir} onClick={() => setSort((s) => ({ key, dir: s.key === key ? ((-s.dir) as 1 | -1) : -1 }))}>
      {label}
    </Th>
  );
  return (
    <Card
      title="Tournament — which Sniper setting really makes money"
      subtitle={`Each variant trades the same live candidates virtually (same prices, same fees). Compared with ${BASE[data.baseline] ?? data.baseline}; a winner needs ${data.minResults}+ trades and is only offered to the self-improving loop, which still proves it on the recorded market. ${data.open} test trades open.`}
    >
      <Table minWidth={640}>
        <thead className={theadCls}>
          <tr>
            {th('name', 'Variant', false)}
            {th('n', 'Trades')}
            {th('winRate', 'Win %')}
            {th('avgPnlPct', 'Avg / trade')}
            {th('profitFactor', 'PF')}
            {th('vsBaselinePts', 'vs baseline')}
            <Th right>Status</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={trCls}>
              <td className={`${tdCls} font-medium text-ink`}>{r.name}</td>
              <td className={`${tdCls} text-right`}>{r.n}</td>
              <td className={`${tdCls} text-right`}>{r.n ? `${r.winRate.toFixed(0)}%` : '—'}</td>
              <td className={`${tdCls} text-right ${r.avgPnlPct > 0 ? 'text-up' : r.avgPnlPct < 0 ? 'text-down' : 'text-ink-2'}`}>{r.n ? pct(r.avgPnlPct) : '—'}</td>
              <td className={`${tdCls} text-right text-ink-2`}>{r.n ? (r.profitFactor ?? '∞') : '—'}</td>
              <td className={`${tdCls} text-right ${(r.vsBaselinePts ?? 0) > 0 ? 'text-up' : (r.vsBaselinePts ?? 0) < 0 ? 'text-down' : 'text-ink-2'}`}>{r.vsBaselinePts === null || !r.n ? '—' : `${r.vsBaselinePts > 0 ? '+' : ''}${r.vsBaselinePts} pts`}</td>
              <td className={`${tdCls} text-right`}>
                <Badge tone={TONE[r.status]}>{r.status}</Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      {data.offers.length > 0 && (
        <div className="mt-4">
          <div className="mb-1 text-xs font-medium text-muted">Offered to the self-improving loop</div>
          <ul className="divide-y divide-line text-sm">
            {data.offers.slice(0, 5).map((o) => (
              <li key={`${o.key}-${o.at}`} className="flex flex-wrap justify-between gap-2 py-1.5">
                <span className="text-ink">
                  {o.key} → {String(o.value)}
                </span>
                <span className="text-muted">
                  {o.result} · {ago(new Date(o.at))}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
