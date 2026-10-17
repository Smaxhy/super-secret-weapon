/** Controls → Trading: Sniper mode — one switch, the rules in force in plain words (values from /api/controls/rules). */
import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { api } from '../lib/api';
import { Card, Row, Rows } from './ui';

interface Setting { key: string; group: string; label: string; unit?: string; value: number | boolean; default: number | boolean }

const num = (m: Map<string, number | boolean>, key: string, fallback: number): number => {
  const v = m.get(key);
  return typeof v === 'number' ? v : fallback;
};

export function SniperMode() {
  const { data, error, reload } = useApi<{ settings: Setting[] }>('/api/controls/rules', 60_000);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const m = new Map<string, number | boolean>((data?.settings ?? []).map((s) => [s.key, s.value]));
  const on = m.get('sniper.enabled') === true;

  async function toggle() {
    setBusy(true);
    setMsg(null);
    try {
      await api('/api/controls/rules', { method: 'PUT', body: JSON.stringify({ key: 'sniper.enabled', value: on ? 0 : 1 }) });
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

  return (
    <Card
      title="Sniper mode"
      subtitle="Few trades, only when everything lines up, at the big size. Every self-tuning learner is watch-only while it's on."
      action={
        <button type="button" disabled={busy || !data} onClick={() => void toggle()} className={`rounded-full px-4 py-1.5 text-sm font-semibold ${on ? 'bg-up/15 text-up' : 'bg-surface-2 text-muted'}`}>
          {on ? 'On' : 'Off'}
        </button>
      }
    >
      {error && <p className="text-sm text-down">{error}</p>}
      {msg && <p className="text-sm text-down">{msg}</p>}
      {data && (
        <Rows>
          <Row label="1. Real volume" value={`${buyers}+ real buyers and ${sol}+ SOL bought in the last 5 min`} />
          <Row label="2. Buyers in charge" value={`buys ≥ ${buyShare}% of volume, ≥ ${organic}% of it organic (no bots)`} />
          <Row label="3. Score" value={`at least ${margin} points over the bar`} />
          <Row label="4. Not chasing" value="momentum gate green (no buying the top), entry quality green" />
          <Row label="5. Strategy earns it" value="the edge gate says the strategy makes money after costs" />
          <Row label="6. Right crowd" value={proven ? 'no dump crews inside, 20%+ of buying from proven wallets' : 'no dump crews inside'} />
          <Row label="7. No shortcuts" value="no learning, probe or half-size entries; new pairs and runners stay off" />
          <Row label="8. Size" value={`${size} SOL per trade (under the usual caps), max ${maxOpen} open`} />
          <Row label="9. Taking profit" value={`sell pieces at 1.5×, 2.5× and 5×; from ${trailAt}× trail ${trailPct}% under the peak, never under break-even`} />
          <Row label="10. Cutting losses" value={`stop ${stop}% after fees; out after ${tsMin} min if it never reached ${tsPeak}×; dead-coin and rug exits always on`} />
        </Rows>
      )}
      <p className="mt-2 text-xs text-muted">Numbers are editable under Rules → "Sniper mode". Judge it on Performance → Mistakes after ~100 trades.</p>
    </Card>
  );
}
