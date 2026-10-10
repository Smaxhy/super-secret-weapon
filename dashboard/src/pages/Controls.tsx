/** Bot controls: pause / kill switch, trade size, entry rules, keywords, paper account reset. */
import { useEffect, useState } from 'react';
import { ResetPaperForm } from '../components/ResetPaper';
import { Card, ErrorBox, Loading, PageHeader } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { api } from '../lib/api';

interface ControlsData {
  state: { paused: boolean; killSwitch: boolean };
  trading: { maxPositionSol: number; maxConcurrentPositions: number; enabledStrategies: Record<string, boolean> };
  entry: { minCombinedScore: number; minVolumeUsd: number; minMarketCapUsd: number; minTotalFeesSol: number; maxBundlePct: number; maxTop10Pct: number; maxDevHoldingPct: number; requireTwitter: boolean; riskyEntry: { enabled: boolean } };
  keywords: { boost: string[]; block: string[] };
  paper: { startingBalanceSol: number };
}

const STRATS: Array<[string, string]> = [
  ['SOON', 'Soon (curve 70%+, about to graduate)'],
  ['CURVE_SNIPE', 'New pairs (after the launch snipers)'],
  ['MIGRATION_MOMENTUM', 'After migration'],
  ['SMART_MONEY_COPY', 'Copy tracked wallets'],
  ['SWING', 'Swing trades on bigger coins (dips that bounce)'],
];

function NumberField({ label, value, onChange, step = 1, min, max, suffix, hint }: { label: string; value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; suffix?: string; hint?: string }) {
  return (
    <label className="flex flex-col gap-1 text-sm text-ink-2">
      {label}
      <span className="flex items-center gap-2">
        <input type="number" inputMode="decimal" value={value} step={step} min={min} max={max} onChange={(e) => onChange(Number(e.target.value))} className="w-full rounded-lg border border-line bg-page px-3 py-2.5 text-base text-ink tabular" />
        {suffix && <span className="shrink-0 text-ink-2">{suffix}</span>}
      </span>
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </label>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-line px-3 py-3 text-ink">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-5 w-5 accent-[var(--accent)]" />
    </label>
  );
}

export function Controls() {
  const { data, error, loading, reload } = useApi<ControlsData>('/api/controls');
  const [form, setForm] = useState<ControlsData | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data) setForm(structuredClone(data));
  }, [data]);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg(ok);
      await reload();
    } catch (e) {
      setMsg(`⚠ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  if (loading && !data) return <Loading />;
  if (!form) return error ? <ErrorBox message={error} /> : null;
  const set = <K extends keyof ControlsData>(k: K, v: Partial<ControlsData[K]>) => setForm({ ...form, [k]: { ...form[k], ...v } });
  const stopped = form.state.killSwitch || form.state.paused;

  const save = () =>
    run(
      () =>
        api('/api/controls', {
          method: 'PUT',
          body: JSON.stringify({
            trading: form.trading,
            entry: { ...form.entry, riskyEnabled: form.entry.riskyEntry.enabled },
            keywords: form.keywords,
          }),
        }),
      '✓ Saved — the bot uses the new settings within 30 seconds.',
    );

  return (
    <>
      <PageHeader title="Controls" subtitle="Change how the bot trades. Changes apply within 30 seconds, no restart needed." />
      {msg && <div role="status" className="mb-4 rounded-lg border border-line bg-surface px-4 py-3 text-sm text-ink">{msg}</div>}

      <Card title="Bot status" className="mb-4">
        <div className="mb-3 text-ink">
          {form.state.killSwitch ? '⛔ Kill switch ON — no trading.' : form.state.paused ? '⏸ Paused — no new buys (open positions are still managed).' : '● Running — scanning and trading.'}
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {stopped ? (
            <button type="button" disabled={busy} onClick={() => run(() => api('/api/controls/resume', { method: 'POST' }), '▶ Resumed')} className="rounded-xl bg-accent px-4 py-3 font-semibold text-white">
              ▶ Resume trading
            </button>
          ) : (
            <button type="button" disabled={busy} onClick={() => run(() => api('/api/controls/pause', { method: 'POST', body: JSON.stringify({ paused: true }) }), '⏸ Paused')} className="rounded-xl border border-line px-4 py-3 font-semibold text-ink">
              ⏸ Pause new buys
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => window.confirm('KILL SWITCH: stop all trading and sell every open position now?') && run(() => api('/api/controls/kill', { method: 'POST' }), '⛔ Kill switch on — all positions sold')}
            className="rounded-xl bg-critical px-4 py-3 font-bold text-white sm:col-span-2"
          >
            ⛔ KILL SWITCH — sell everything & stop
          </button>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Trade size">
          <div className="grid grid-cols-2 gap-3">
            <NumberField label="Size per trade" value={form.trading.maxPositionSol} step={0.05} min={0.01} max={10} suffix="SOL" onChange={(v) => set('trading', { maxPositionSol: v })} hint="Raise as results improve." />
            <NumberField label="Max open trades" value={form.trading.maxConcurrentPositions} min={1} max={20} onChange={(v) => set('trading', { maxConcurrentPositions: v })} />
          </div>
          <div className="mt-3 grid gap-2">
            {STRATS.map(([k, l]) => (
              <Toggle key={k} label={l} checked={form.trading.enabledStrategies[k] ?? false} onChange={(v) => set('trading', { enabledStrategies: { ...form.trading.enabledStrategies, [k]: v } })} />
            ))}
          </div>
        </Card>

        <Card title="Buy rules">
          <div className="grid grid-cols-2 gap-3">
            <NumberField label="Min score" value={form.entry.minCombinedScore} min={30} max={95} onChange={(v) => set('entry', { minCombinedScore: v })} hint="Lower = more trades." />
            <NumberField label="Min fees paid" value={form.entry.minTotalFeesSol} step={0.1} suffix="SOL" onChange={(v) => set('entry', { minTotalFeesSol: v })} />
            <NumberField label="Min volume" value={form.entry.minVolumeUsd} step={1000} suffix="$" onChange={(v) => set('entry', { minVolumeUsd: v })} />
            <NumberField label="Min market cap" value={form.entry.minMarketCapUsd} step={1000} suffix="$" onChange={(v) => set('entry', { minMarketCapUsd: v })} />
            <NumberField label="Max bundlers" value={form.entry.maxBundlePct} suffix="%" onChange={(v) => set('entry', { maxBundlePct: v })} />
            <NumberField label="Max top 10" value={form.entry.maxTop10Pct} suffix="%" onChange={(v) => set('entry', { maxTop10Pct: v })} />
            <NumberField label="Max dev holds" value={form.entry.maxDevHoldingPct} suffix="%" onChange={(v) => set('entry', { maxDevHoldingPct: v })} />
          </div>
          <div className="mt-3 grid gap-2">
            <Toggle label="Half-size buys on strong coins with bundlers" checked={form.entry.riskyEntry.enabled} onChange={(v) => set('entry', { riskyEntry: { ...form.entry.riskyEntry, enabled: v } })} />
            <Toggle label="Only buy coins with an X link" checked={form.entry.requireTwitter} onChange={(v) => set('entry', { requireTwitter: v })} />
          </div>
        </Card>

        <Card title="Keywords" className="lg:col-span-2">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm text-ink-2">
              Boost (raises the score) — comma separated
              <textarea rows={3} value={form.keywords.boost.join(', ')} onChange={(e) => set('keywords', { boost: e.target.value.split(',').map((x) => x.trim()) })} className="rounded-lg border border-line bg-page px-3 py-2 text-ink" />
            </label>
            <label className="flex flex-col gap-1 text-sm text-ink-2">
              Block (never buys) — comma separated
              <textarea rows={3} value={form.keywords.block.join(', ')} onChange={(e) => set('keywords', { block: e.target.value.split(',').map((x) => x.trim()) })} className="rounded-lg border border-line bg-page px-3 py-2 text-ink" />
            </label>
          </div>
        </Card>
      </div>

      <div className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-10 mt-4 md:bottom-4">
        <button type="button" disabled={busy} onClick={save} className="w-full rounded-xl bg-accent py-3.5 text-base font-semibold text-white shadow-lg disabled:opacity-60">
          {busy ? 'Saving…' : 'Save settings'}
        </button>
      </div>

      <Card title="Reset paper account" className="mt-6 border-critical/40">
        <ResetPaperForm defaultBalance={10} />
        <p className="mt-3 text-xs text-muted">Current paper starting balance: {form.paper.startingBalanceSol} SOL.</p>
      </Card>
    </>
  );
}
