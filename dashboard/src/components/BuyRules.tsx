/**
 * Controls → Rules: every rule the owner can tune (GET/PUT /api/controls/rules), shown as settings rows —
 * label, help, the value with its unit, the default, a reset link. Each change saves at once.
 */
import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { api } from '../lib/api';
import { Button, Card, Field, NumberInput, Switch } from './ui';

export interface Setting {
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

export function useRuleSettings() {
  return useApi<{ settings: Setting[] }>('/api/controls/rules', 0);
}

const unitOf = (s: Setting) => (s.unit === '0–1' ? '' : (s.unit ?? ''));
const fmt = (s: Setting, v: number | boolean) => (typeof v === 'boolean' ? (v ? 'on' : 'off') : `${v}${unitOf(s) ? ` ${unitOf(s)}` : ''}`);

function RuleField({ s, onSaved }: { s: Setting; onSaved: () => void }) {
  const onOff = typeof s.value === 'boolean';
  const [v, setV] = useState(String(onOff ? (s.value ? 1 : 0) : s.value));
  const [state, setState] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const edited = !onOff && v !== String(s.value);
  const notDefault = onOff ? s.value !== s.default : Number(s.value) !== Number(s.default);

  async function put(value: number) {
    setState(null);
    setBusy(true);
    try {
      await api('/api/controls/rules', { method: 'PUT', body: JSON.stringify({ key: s.key, value }) });
      setState({ ok: true, text: 'saved' });
      onSaved();
    } catch (err) {
      setState({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Field
      label={s.label}
      description={s.help ?? (s.unit === '0–1' ? 'A share from 0 to 1 (0.3 = 30%).' : undefined)}
      defaultText={fmt(s, s.default)}
      changed={notDefault}
      onReset={() => void put(typeof s.default === 'boolean' ? (s.default ? 1 : 0) : Number(s.default))}
      status={state}
      control={
        onOff ? (
          <Switch checked={s.value === true} disabled={busy} onChange={(on) => void put(on ? 1 : 0)} label={s.label} />
        ) : (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (edited) void put(Number(v));
            }}
          >
            <NumberInput size="sm" label={s.label} min={s.min} max={s.max} step={s.step ?? 'any'} value={v} onChange={setV} unit={unitOf(s)} className="w-28 sm:w-36" />
            <Button type="submit" size="sm" disabled={!edited || busy} className={edited ? '' : 'invisible'}>
              Save
            </Button>
          </form>
        )
      }
    />
  );
}

/** One group of rules as a settings card. */
export function RuleGroup({ title, list, onSaved, subtitle }: { title: string; list: Setting[]; onSaved: () => void; subtitle?: string }) {
  return (
    <Card title={title} subtitle={subtitle}>
      <div className="divide-y divide-line">
        {list.map((s) => (
          <RuleField key={`${s.key}:${String(s.value)}`} s={s} onSaved={onSaved} />
        ))}
      </div>
    </Card>
  );
}

export function groupRules(settings: Setting[]): Array<[string, Setting[]]> {
  const groups = new Map<string, Setting[]>();
  for (const s of settings) groups.set(s.group, [...(groups.get(s.group) ?? []), s]);
  return [...groups];
}

export const matchesRule = (s: Setting, q: string) => {
  const t = q.trim().toLowerCase();
  return !t || s.label.toLowerCase().includes(t) || s.group.toLowerCase().includes(t) || s.key.toLowerCase().includes(t) || (s.help ?? '').toLowerCase().includes(t);
};
