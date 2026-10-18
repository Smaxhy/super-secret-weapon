/** Controls → Trading: Sniper mode — one switch and the ten rules in force as a checklist with their values. */
import { useState } from 'react';
import { api } from '../lib/api';
import type { Setting } from './BuyRules';
import { Icon } from './Icon';
import { Badge, Card, Switch } from './ui';

const num = (m: Map<string, number | boolean>, key: string, fallback: number): number => {
  const v = m.get(key);
  return typeof v === 'number' ? v : fallback;
};

export function SniperMode({ settings, error, reload }: { settings: Setting[] | null; error: string | null; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const m = new Map<string, number | boolean>((settings ?? []).map((s) => [s.key, s.value]));
  const on = m.get('sniper.enabled') === true;

  async function toggle(next: boolean) {
    setBusy(true);
    setMsg(null);
    try {
      await api('/api/controls/rules', { method: 'PUT', body: JSON.stringify({ key: 'sniper.enabled', value: next ? 1 : 0 }) });
      reload();
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const buyers = num(m, 'sniper.volume.minBuyers', 30);
  const sol = num(m, 'sniper.volume.minBuySol', 12);
  const buyShare = num(m, 'sniper.volume.minBuySharePct', 60);
  const organic = num(m, 'sniper.volume.minOrganicPct', 60);
  const margin = num(m, 'sniper.minScoreMargin', 8);
  const maxOpen = num(m, 'sniper.maxOpen', 3);
  const size = num(m, 'trading.highConviction.sizeSol', 1);
  const trailAt = num(m, 'sniper.exits.trailActivateMultiple', 1.5);
  const trailPct = num(m, 'sniper.exits.trailPct', 25);
  const stop = num(m, 'sniper.exits.stopMaxPct', 12);
  const tsMin = num(m, 'sniper.exits.timeStopMinutes', 2);
  const tsPeak = num(m, 'sniper.exits.timeStopMinPeakMultiple', 1.08);
  const proven = m.get('sniper.requireProvenCrowd') === true;

  const rules: Array<[string, string, string]> = [
    ['Real volume', `${buyers}+ buyers · ${sol}+ SOL`, 'bought in the last 5 minutes, bots excluded'],
    ['Buyers in charge', `${buyShare}% buys · ${organic}% organic`, 'share of volume that is buying, and how much of it is real'],
    ['Score', `bar + ${margin}`, 'points over the normal buy bar'],
    ['Not chasing', 'momentum + entry quality', 'no buying the top of a candle'],
    ['Strategy earns it', 'edge gate green', 'the strategy makes money after costs'],
    ['Right crowd', proven ? 'no dumpers · 20%+ proven' : 'no dump crews', 'who is buying the coin'],
    ['No shortcuts', 'full entries only', 'no learning, probe or half-size buys'],
    ['Size', `${size} SOL · max ${maxOpen} open`, 'under the usual capital and liquidity caps'],
    ['Taking profit', `1.5× · 2.5× · 5×, trail ${trailPct}% from ${trailAt}×`, 'never sells under break-even once trailing'],
    ['Cutting losses', `stop ${stop}% · out after ${tsMin} min under ${tsPeak}×`, 'dead-coin and rug exits always on'],
  ];

  return (
    <Card
      accent={on}
      title={
        <span className="inline-flex items-center gap-2">
          Sniper mode <Badge tone={on ? 'up' : 'neutral'}>{on ? 'on' : 'off'}</Badge>
        </span>
      }
      subtitle="Few trades, only when everything lines up, at the big size. The self-tuning learners only watch while it's on."
      action={<Switch checked={on} disabled={busy || !settings} onChange={(v) => void toggle(v)} label="Sniper mode" />}
    >
      {error && <p className="mb-2 text-sm text-down">{error}</p>}
      {msg && <p className="mb-2 text-sm text-down">{msg}</p>}
      {settings && (
        <ol className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
          {rules.map(([title, value, sub], i) => (
            <li key={title} className="flex items-start gap-3 border-b border-line py-2.5 last:border-b-0 sm:[&:nth-last-child(2)]:border-b-0">
              <span className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-bold ${on ? 'bg-good/15 text-up' : 'bg-surface-2 text-muted'}`} aria-hidden="true">
                {on ? <Icon name="check" size={13} strokeWidth={2.5} /> : i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-sm font-medium text-ink">{title}</span>
                  <span className="tabular text-sm text-ink-2">{value}</span>
                </span>
                <span className="block text-xs text-muted">{sub}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
      <p className="mt-3 text-xs text-muted">Numbers are editable under Rules → Sniper mode. Judge it on Performance → Mistakes after about 100 trades.</p>
    </Card>
  );
}
