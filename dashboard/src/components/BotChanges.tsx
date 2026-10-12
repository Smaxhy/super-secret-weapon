/** Performance page: "What the bot changed" — how each strategy enters / sizes now, and every change the learners made. */
import { useApi } from '../hooks/useApi';
import { ago, STRATEGY_LABEL } from '../lib/format';
import { Card } from './ui';

interface Change { at: string; source: string; strategy: string | null; what: string; why: string }
interface Style { strategy: string; minOffHighPct: number; maxRun3mPct: number | null; why: string[] }
interface Tune { strategy: string; barDelta: number; sizeFactor: number; trailFactor: number; why: string }
interface Data { changes: Change[]; entryStyles: Style[]; tuning: Tune[] }

const SOURCE: Record<string, string> = { autopsy: 'Loss report', 'entry-style': 'Entries', 'ai-coach': 'AI coach', 'strategy-lab': 'Exit lab' };
const strat = (s: string) => STRATEGY_LABEL[s] ?? s;

export function BotChanges() {
  const { data, error } = useApi<Data>('/api/changes', 60_000, ['trade']);
  const tunes = (data?.tuning ?? []).filter((t) => t.barDelta || t.sizeFactor !== 1 || t.trailFactor !== 1);
  const styles = data?.entryStyles ?? [];
  return (
    <Card title="What the bot changed">
      {error && <p className="text-sm text-down">{error}</p>}
      {data && (
        <div className="space-y-4 text-sm">
          <div>
            <div className="mb-1 font-medium text-ink">How it trades right now</div>
            {!styles.length && !tunes.length ? (
              <p className="text-ink-2">Everything on normal settings — nothing has lost often enough yet to change (needs ~15 trades of a kind).</p>
            ) : (
              <ul className="space-y-1.5">
                {styles.map((s) => (
                  <li key={`s-${s.strategy}`} className="text-ink-2">
                    <span className="font-medium text-ink">{strat(s.strategy)} entries:</span>{' '}
                    {[s.minOffHighPct ? `waits until it's ${s.minOffHighPct}%+ under the 10-min high` : '', s.maxRun3mPct !== null ? `won't chase more than +${s.maxRun3mPct}% in 3 min` : ''].filter(Boolean).join(' · ')}
                    <div className="text-xs text-muted">{s.why.join(' · ')}</div>
                  </li>
                ))}
                {tunes.map((t) => (
                  <li key={`t-${t.strategy}`} className="text-ink-2">
                    <span className="font-medium text-ink">{strat(t.strategy)}:</span> buy bar {t.barDelta > 0 ? `+${t.barDelta} (stricter)` : `${t.barDelta} (easier)`} · size ×{t.sizeFactor}
                    {t.trailFactor !== 1 ? ` · sells ${t.trailFactor < 1 ? 'sooner' : 'later'} after a peak` : ''}
                    {t.why && <div className="text-xs text-muted">{t.why}</div>}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <div className="mb-1 font-medium text-ink">Change log</div>
            {!data.changes.length ? (
              <p className="text-ink-2">No changes yet. Every adjustment the bot makes shows up here.</p>
            ) : (
              <ul className="divide-y divide-line">
                {data.changes.slice(0, 20).map((c, i) => (
                  <li key={`${c.at}-${i}`} className="py-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="min-w-0 break-words font-medium text-ink">{c.what}</span>
                      <span className="shrink-0 text-xs text-muted">{ago(c.at)}</span>
                    </div>
                    <div className="break-words text-xs text-muted">
                      {SOURCE[c.source] ?? c.source} · {c.why}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
