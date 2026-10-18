/** Performance → Mistakes: coins that passed every rule but were under the score bar — and what they did next. */
import { useApi } from '../hooks/useApi';
import { STRATEGY_LABEL } from '../lib/format';
import { Badge, Card, Loading, Tabs, useStored } from './ui';

interface Band { label: string; n: number; winPct: number; avgPct: number; sol: number }
interface Strat { strategy: string; n: number; bar: number | null; bands: Band[]; verdict: 'too_high' | 'right' | 'unclear'; verdictText: string }
interface Data { hours: number; at: number; strategies: Strat[]; sniper: { n: number; avgPct: number; reasons: Array<{ why: string; n: number }> } | null }

const RANGES = [
  { key: '12', label: '12 h' },
  { key: '24', label: '24 h' },
  { key: '48', label: '48 h' },
  { key: '168', label: '7 days' },
] as const;
type RangeKey = (typeof RANGES)[number]['key'];
const VERDICT: Record<Strat['verdict'], { tone: 'up' | 'down' | 'neutral'; text: string }> = {
  too_high: { tone: 'up', text: 'Bar too high' },
  right: { tone: 'down', text: 'Bar is right' },
  unclear: { tone: 'neutral', text: 'Too few yet' },
};
const signed = (x: number, d = 1) => `${x >= 0 ? '+' : ''}${x.toFixed(d)}`;

export function ScoreGap() {
  const [range, setRange] = useStored<RangeKey>('scoregap.range', '48', RANGES.map((r) => r.key));
  const { data, error } = useApi<Data>(`/api/score-gap?hours=${range}`, 120_000);
  return (
    <Card title="Coins the score held back" subtitle="Passed every rule but scored under the bar. What they did afterwards with the bot's own exits, after fees.">
      <Tabs tabs={RANGES} value={range} onChange={setRange} label="Time range" className="mb-4" />
      {error && <p className="text-sm text-down">{error}</p>}
      {!data && !error && <Loading kind="rows" />}
      {data && !data.strategies.length && <p className="text-sm text-ink-2">No coins were held back only by the score in this window.</p>}
      <div className="flex flex-col gap-5">
        {data?.strategies.map((s) => (
          <div key={s.strategy} className="min-w-0">
            <div className="flex min-w-0 items-baseline justify-between gap-2">
              <div className="min-w-0 font-medium text-ink">
                {STRATEGY_LABEL[s.strategy] ?? s.strategy} <span className="text-xs font-normal text-muted">{s.n} coins · bar ≈ {s.bar?.toFixed(0) ?? '?'}</span>
              </div>
              <Badge tone={VERDICT[s.verdict].tone}>{VERDICT[s.verdict].text}</Badge>
            </div>
            <p className="mt-1 text-sm text-ink-2">{s.verdictText}</p>
            <ul className="mt-2 divide-y divide-line text-sm">
              {s.bands.map((b) => (
                <li key={b.label} className="flex items-center justify-between gap-3 py-2">
                  <span className="text-ink-2">{b.label}</span>
                  <span className="tabular flex shrink-0 gap-3 text-right">
                    <span className="text-muted">{b.n} coins</span>
                    <span className="text-muted">{b.winPct}% won</span>
                    <span className={b.avgPct >= 0 ? 'font-medium text-up' : 'font-medium text-down'}>{signed(b.avgPct)}%</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {data?.sniper && (
          <div className="rounded-xl border border-line p-3 text-sm">
            <div className="font-medium text-ink">Over the bar, stopped by Sniper mode: {data.sniper.n} coins, {signed(data.sniper.avgPct)}% avg</div>
            <ul className="mt-1 text-xs text-muted">
              {data.sniper.reasons.map((r) => (
                <li key={r.why}>×{r.n} {r.why}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}
