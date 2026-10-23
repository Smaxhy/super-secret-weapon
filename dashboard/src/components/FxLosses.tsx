/**
 * v27.23 loss review (owner: "any loss that's not a bug — analyse it thoroughly and make sure it doesn't happen again").
 * Every losing bot trade graded against the lab's own copy of the same signal: normal (the tested trade lost too) or
 * avoidable (doubled bet, cut by the loss cap, worse than the test) with the rule that now stops it.
 */
import { Badge, Card, Row, Rows } from './ui';
import { ago } from '../lib/format';

export interface LossReviewRow { id: string; pair: string; strategy: string | null; tf: string | null; side: 1 | -1; closedAt: number; usd: number; verdict: 'normal' | 'avoidable' | 'pending' | 'unknown'; why: string; fix: string | null; testR: number | null; capDelta?: number }
export interface LossSummary {
  by: Record<'normal' | 'avoidable' | 'pending' | 'unknown', { n: number; usd: number }>;
  capSavedUsd: number;
  capStops: number;
  capVerdict: string | null;
  newest: LossReviewRow[];
}

const usd = (x: number) => `${x < 0 ? '−' : '+'}$${Math.abs(x).toFixed(2)}`;
const VERDICT: Record<LossReviewRow['verdict'], { label: string; tone: 'down' | 'neutral' | 'warn' }> = {
  normal: { label: 'Normal loss', tone: 'neutral' },
  avoidable: { label: 'Avoidable', tone: 'down' },
  pending: { label: 'Waiting for the test', tone: 'warn' },
  unknown: { label: 'No tested copy', tone: 'neutral' },
};

export function LossReviewCard({ s, names }: { s: LossSummary | null | undefined; names?: Record<string, string> }) {
  if (!s) return null;
  const n = s.by.normal.n + s.by.avoidable.n + s.by.pending.n + s.by.unknown.n;
  const head = n === 0
    ? 'No losing bot trade to review yet.'
    : `${s.by.avoidable.n} avoidable (${usd(s.by.avoidable.usd)}), ${s.by.normal.n} normal (${usd(s.by.normal.usd)})${s.by.pending.n ? `, ${s.by.pending.n} waiting for their tested copy` : ''}.`;
  return (
    <Card title="Why it lost (loss review)" subtitle="Every losing trade is checked against the lab's own copy of the same signal. Normal = the tested strategy lost it too (part of its record). Avoidable = the bot did something the test didn't; the rule that now stops it is listed.">
      <p className="mb-2 text-sm font-medium text-ink">{head}</p>
      {s.capStops > 0 && <p className="mb-3 text-xs text-ink-2">The $20 loss cap stopped {s.capStops} trade{s.capStops === 1 ? '' : 's'}: {s.capSavedUsd >= 0 ? `saved ${usd(s.capSavedUsd)}` : `cost ${usd(s.capSavedUsd)}`} against the tested trades. {s.capVerdict ?? ''}</p>}
      {s.newest.length ? (
        <Rows>
          {s.newest.map((x) => (
            <Row
              key={x.id}
              label={<span>{x.side === 1 ? 'Long' : 'Short'} {x.pair} · {names?.[x.strategy ?? ''] ?? x.strategy} {x.tf ? `(${x.tf})` : ''} <Badge tone={VERDICT[x.verdict].tone}>{VERDICT[x.verdict].label}</Badge></span>}
              sub={`${ago(new Date(x.closedAt).toISOString())} · ${x.why}${x.fix ? ` · Fix: ${x.fix}` : ''}`}
              value={<span className="text-down">{usd(x.usd)}</span>}
            />
          ))}
        </Rows>
      ) : <p className="text-sm text-ink-2">Nothing to show yet.</p>}
    </Card>
  );
}
