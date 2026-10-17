/**
 * Controls page: "Buy rules per strategy" — every rule the owner can tune (market cap, liquidity, holders, fees,
 * curve range, score bar, size, max open, budget share, stop) grouped by strategy. Each change saves at once.
 */
import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { api } from '../lib/api';
import { Card } from './ui';

interface Setting {
  key: string;
  group: string;
  label: string;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  help?: string;
  value: number | boolean;
  default: number | boolean;
}

function Row({ s, onSaved }: { s: Setting; onSaved: () => void }) {
  const onOff = typeof s.value === 'boolean';
  const [v, setV] = useState(String(onOff ? (s.value ? 1 : 0) : s.value));
  const [state, setState] = useState<{ ok: boolean; text: string } | null>(null);
  const changed = !onOff && v !== String(s.value);

  async function put(value: number) {
    setState(null);
    try {
      await api('/api/controls/rules', { method: 'PUT', body: JSON.stringify({ key: s.key, value }) });
      setState({ ok: true, text: '✓ saved' });
      onSaved();
    } catch (err) {
      setState({ ok: false, text: (err as Error).message });
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line py-2 first:border-t-0">
      <div className="min-w-0 flex-1">
        <div className="text-sm text-ink">{s.label}</div>
        <div className="text-xs text-muted">
          default {typeof s.default === 'boolean' ? (s.default ? 'on' : 'off') : `${s.default}${s.unit && s.unit !== '0–1' ? ` ${s.unit}` : ''}`}
          {state && <span className={`ml-2 ${state.ok ? 'text-up' : 'text-down'}`}>{state.text}</span>}
        </div>
      </div>
      {onOff ? (
        <button
          type="button"
          onClick={() => void put(s.value ? 0 : 1)}
          className={`rounded-full px-4 py-1.5 text-sm font-semibold ${s.value ? 'bg-up/15 text-up' : 'bg-surface-2 text-muted'}`}
        >
          {s.value ? 'On' : 'Off'}
        </button>
      ) : (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (changed) void put(Number(v));
          }}
        >
          <input
            type="number"
            inputMode="decimal"
            aria-label={s.label}
            min={s.min}
            max={s.max}
            step={s.step ?? 'any'}
            value={v}
            onChange={(e) => setV(e.target.value)}
            className="w-28 rounded-lg border border-line bg-page px-2 py-1.5 text-right text-base text-ink"
          />
          <span className="w-8 text-xs text-muted">{s.unit === '0–1' ? '' : s.unit ?? ''}</span>
          <button type="submit" disabled={!changed} className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-on-accent disabled:opacity-30">
            Save
          </button>
        </form>
      )}
    </div>
  );
}

export function BuyRules() {
  const { data, error, reload } = useApi<{ settings: Setting[] }>('/api/controls/rules', 0);
  const groups = new Map<string, Setting[]>();
  for (const s of data?.settings ?? []) groups.set(s.group, [...(groups.get(s.group) ?? []), s]);
  return (
    <Card title="Buy rules per strategy">
      <p className="mb-3 text-xs text-muted">Each change saves at once and shows up under "What the bot changed". Budget share is 0–1 (0.3 = 30%).</p>
      {error && <p className="text-sm text-down">{error}</p>}
      <div className="space-y-2">
        {[...groups].map(([g, list]) => (
          <details key={g} className="rounded-xl border border-line px-3 py-1">
            <summary className="cursor-pointer py-2 text-sm font-semibold text-ink">{g}</summary>
            {list.map((s) => (
              <Row key={`${s.key}:${String(s.value)}`} s={s} onSaved={() => void reload()} />
            ))}
          </details>
        ))}
      </div>
    </Card>
  );
}
