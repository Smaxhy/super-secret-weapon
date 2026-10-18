/** Performance page: "What the bot changed" — how each strategy enters / sizes now, and every change the learners made. */
import { useApi } from '../hooks/useApi';
import { ago, STRATEGY_LABEL } from '../lib/format';
import { Card, ErrorBox, SectionHeader, Timeline } from './ui';

interface Change { at: string; source: string; strategy: string | null; what: string; why: string }
interface Style { strategy: string; minOffHighPct: number; maxRun3mPct: number | null; why: string[] }
interface Tune { strategy: string; barDelta: number; sizeFactor: number; trailFactor: number; why: string }
interface Data { changes: Change[]; entryStyles: Style[]; tuning: Tune[] }

const SOURCE: Record<string, string> = { autopsy: 'Loss report', 'entry-style': 'Entries', 'ai-coach': 'AI coach', 'strategy-lab': 'Exit lab', owner: 'You', 'exit-tuner': 'Exit tuner', brain: 'Brain' };
const strat = (s: string) => STRATEGY_LABEL[s] ?? s;

export function BotChanges() {
  const { data, error } = useApi<Data>('/api/changes', 60_000, ['trade']);
  const tunes = (data?.tuning ?? []).filter((t) => t.barDelta || t.sizeFactor !== 1 || t.trailFactor !== 1);
  const styles = data?.entryStyles ?? [];
  return (
    <div className="flex flex-col gap-4">
      <SectionHeader title="What the bot changed" description="How each strategy trades right now, and every adjustment the learners made." />
      {error && <ErrorBox message={error} />}
      {data && (
        <div className="grid gap-6 xl:grid-cols-12">
          <Card title="How it trades right now" className="xl:col-span-5">
            {!styles.length && !tunes.length ? (
              <p className="text-sm text-ink-2">Everything on normal settings. Nothing has lost often enough yet to change (needs ~15 trades of a kind).</p>
            ) : (
              <ul className="divide-y divide-line text-sm">
                {styles.map((s) => (
                  <li key={`s-${s.strategy}`} className="py-2.5 first:pt-0 last:pb-0">
                    <div className="font-medium text-ink">{strat(s.strategy)} entries</div>
                    <div className="text-ink-2">{[s.minOffHighPct ? `waits until ${s.minOffHighPct}%+ under the 10-min high` : '', s.maxRun3mPct !== null ? `won't chase more than +${s.maxRun3mPct}% in 3 min` : ''].filter(Boolean).join(' · ')}</div>
                    <div className="text-xs text-muted">{s.why.join(' · ')}</div>
                  </li>
                ))}
                {tunes.map((t) => (
                  <li key={`t-${t.strategy}`} className="py-2.5 first:pt-0 last:pb-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-ink">{strat(t.strategy)}</span>
                      <span className="tabular text-xs text-muted">bar {t.barDelta > 0 ? `+${t.barDelta}` : t.barDelta} · size ×{t.sizeFactor}</span>
                    </div>
                    <div className="text-ink-2">
                      Buy bar {t.barDelta > 0 ? 'stricter' : 'easier'}{t.trailFactor !== 1 ? ` · sells ${t.trailFactor < 1 ? 'sooner' : 'later'} after a peak` : ''}
                    </div>
                    {t.why && <div className="text-xs text-muted">{t.why}</div>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Change log" subtitle="Newest first" className="xl:col-span-7">
            {!data.changes.length ? (
              <p className="text-sm text-ink-2">No changes yet. Every adjustment the bot makes shows up here.</p>
            ) : (
              <Timeline
                items={data.changes.slice(0, 25).map((c, i) => ({
                  key: `${c.at}-${i}`,
                  when: ago(c.at),
                  title: c.what,
                  body: `${SOURCE[c.source] ?? c.source}${c.strategy ? ` · ${strat(c.strategy)}` : ''} · ${c.why}`,
                  tone: c.source === 'owner' ? 'up' : c.source === 'ai-coach' ? 'accent' : 'muted',
                }))}
              />
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
