/**
 * Performance → Money: the deployer study — does a creator's past predict the next launch, on OUR Token table?
 * Each coin is judged only by what its creator had done BEFORE it launched (no peeking).
 */
import { useEffect, useState } from 'react';
import { useApi } from '../hooks/useApi';
import { api } from '../lib/api';
import { ago } from '../lib/format';
import { Icon } from './Icon';
import { Button, Card, Loading, NumberInput } from './ui';

interface Band { label: string; launches: number; graduated: number; pct: number; lift: number }
interface Study { at: number; days: number; tokens: number; creators: number; base: Band; byPriorGrads: Band[]; byPriorLaunches: Band[]; repeat24h: Band[]; quietAfterGrad: Band[]; elite: Band[]; verdict: string; durationMs: number }
interface Data { running: boolean; last: Study | null }

const tone = (lift: number, n: number) => (n < 20 ? 'text-muted' : lift >= 1.5 ? 'text-up' : lift <= 0.7 ? 'text-down' : 'text-ink');

export function DeployerStudy() {
  const { data, error, reload } = useApi<Data>('/api/deployers/study', 60_000);
  const [days, setDays] = useState('14');
  const [busy, setBusy] = useState(false);
  const running = !!data?.running;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void reload(), 4_000);
    return () => clearInterval(t);
  }, [running, reload]);
  const run = async () => {
    setBusy(true);
    try {
      await api('/api/deployers/study/run', { method: 'POST', body: JSON.stringify({ days: Number(days) || 14 }) });
      await reload();
    } finally {
      setBusy(false);
    }
  };
  const s = data?.last ?? null;
  return (
    <Card
      title="Does the creator's past predict the launch?"
      subtitle="Every launch in our database, judged only by what its creator had done before that moment. Graduation = the curve completed."
      action={
        <div className="flex items-center gap-2">
          <NumberInput size="sm" label="Days" value={days} onChange={setDays} min={1} max={30} step={1} unit="d" className="w-24" />
          <Button size="sm" disabled={busy || running} onClick={() => void run()}>
            <Icon name="play" size={14} />
            {running ? 'Running…' : 'Run'}
          </Button>
        </div>
      }
    >
      {error && <p className="text-sm text-down">{error}</p>}
      {!data && !error && <Loading kind="rows" />}
      {running && <p className="mb-3 text-sm text-ink-2">Walking the launches… a minute or two.</p>}
      {data && !s && !running && <p className="text-sm text-ink-2">Not run yet. Press Run.</p>}
      {s && (
        <div className="flex flex-col gap-4">
          <p className="rounded-xl border border-line bg-surface-2/40 p-3 text-sm text-ink">{s.verdict}</p>
          <p className="text-xs text-muted">
            {s.tokens.toLocaleString()} launches by {s.creators.toLocaleString()} creators over {s.days} days · base rate {s.base.pct}% graduate · {ago(new Date(s.at).toISOString())}
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            <Table title="Graduations the creator already had" bands={s.byPriorGrads} />
            <Table title="Which launch this is for the creator" bands={s.byPriorLaunches} />
            <Table title="Launched again within 24 h?" bands={s.repeat24h} />
            <Table title="Graduated before — quiet or busy?" bands={s.quietAfterGrad} />
            <Table title="Elite definition in force" bands={s.elite} />
          </div>
        </div>
      )}
    </Card>
  );
}

function Table({ title, bands }: { title: string; bands: Band[] }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">{title}</div>
      <table className="tabular w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted">
            <th className="py-1 font-medium">Group</th>
            <th className="py-1 text-right font-medium">Launches</th>
            <th className="py-1 text-right font-medium">Graduated</th>
            <th className="py-1 text-right font-medium">vs base</th>
          </tr>
        </thead>
        <tbody>
          {bands.map((b) => (
            <tr key={b.label} className="border-t border-line">
              <td className="py-1.5 text-ink">{b.label}</td>
              <td className="py-1.5 text-right text-ink-2">{b.launches.toLocaleString()}</td>
              <td className={`py-1.5 text-right font-medium ${tone(b.lift, b.launches)}`}>{b.pct}%</td>
              <td className={`py-1.5 text-right ${tone(b.lift, b.launches)}`}>{b.launches < 20 ? 'too few' : `${b.lift}×`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
