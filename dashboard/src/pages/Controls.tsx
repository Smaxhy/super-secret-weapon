/** Bot controls: pause / kill switch, trade size, entry rules, keywords, paper account reset. */
import { useEffect, useState } from 'react';
import { ResetPaperForm } from '../components/ResetPaper';
import { BuyRules } from '../components/BuyRules';
import { DataFeed } from '../components/DataFeed';
import { SniperMode } from '../components/SniperMode';
import { Notifications } from '../components/Notifications';
import { Icon } from '../components/Icon';
import { UpdateCard } from '../components/UpdateCard';
import { Button, Card, ErrorBox, Loading, PageHeader, Stack, Tabs, useTab } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { api } from '../lib/api';

interface ControlsData {
  state: { paused: boolean; killSwitch: boolean };
  trading: { maxPositionSol: number; maxConcurrentPositions: number; enabledStrategies: Record<string, boolean> };
  entry: { minCombinedScore: number; minVolumeUsd: number; minMarketCapUsd: number; minTotalFeesSol: number; maxBundlePct: number; maxTop10Pct: number; maxDevHoldingPct: number; requireTwitter: boolean; riskyEntry: { enabled: boolean } };
  keywords: { boost: string[]; block: string[] };
  paper: { startingBalanceSol: number };
}

const STRATS: Array<[string, string, string]> = [
  ['CURVE_SNIPE', 'New pairs', 'After the launch snipers'],
  ['SOON', 'Soon', 'Curve 70%+, about to graduate'],
  ['MIGRATION_MOMENTUM', 'After migration', 'Migrated coins with real volume'],
  ['RUNNER', 'Runners', 'Real buying took off after the first checks'],
  ['SWING', 'Swing', 'Dips that bounce on bigger coins'],
  ['SMART_MONEY_COPY', 'KOL follow / copy', 'Coins several KOLs or tracked wallets buy'],
];

function NumberField({ label, value, onChange, step = 1, min, max, suffix, hint }: { label: string; value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; suffix?: string; hint?: string }) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-muted">
      {label}
      <span className="flex min-h-11 items-center rounded-xl border border-line-strong bg-surface transition-colors focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/30">
        <input type="number" inputMode="decimal" value={value} step={step} min={min} max={max} onChange={(e) => onChange(Number(e.target.value))} className="w-full min-w-0 bg-transparent px-3 py-2.5 text-base text-ink tabular outline-none focus-visible:outline-none" />
        {suffix && <span className="shrink-0 pr-3 text-sm text-muted">{suffix}</span>}
      </span>
      {hint && <span className="font-normal">{hint}</span>}
    </label>
  );
}

/** iOS-style switch row; sits inside a divided list. */
function Toggle({ label, sub, checked, onChange }: { label: string; sub?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex min-h-12 cursor-pointer items-center justify-between gap-3 py-3 first:pt-1 last:pb-1">
      <span className="min-w-0">
        <span className="block text-sm font-medium text-ink">{label}</span>
        {sub && <span className="block text-xs text-muted">{sub}</span>}
      </span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="peer sr-only" />
      <span aria-hidden="true" className="relative h-7 w-12 shrink-0 rounded-full bg-surface-3 ring-1 ring-line-strong transition-colors duration-150 peer-checked:bg-accent peer-checked:ring-accent peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-accent after:absolute after:left-0.5 after:top-0.5 after:h-6 after:w-6 after:rounded-full after:bg-surface after:shadow-[0_1px_3px_rgba(0,0,0,0.35)] after:transition-transform after:duration-150 peer-checked:after:translate-x-5" />
    </label>
  );
}

const TABS = [
  { key: 'trading', label: 'Trading' },
  { key: 'rules', label: 'Rules' },
  { key: 'alerts', label: 'Alerts' },
  { key: 'feed', label: 'Feed' },
  { key: 'system', label: 'System' },
] as const;
type Tab = (typeof TABS)[number]['key'];

/** The part of the form the Save button sends (dirty check compares it to the saved copy). */
const editable = (c: ControlsData) => JSON.stringify({ t: c.trading, e: c.entry, k: c.keywords });

export function Controls() {
  const { data, error, loading, reload } = useApi<ControlsData>('/api/controls');
  const [form, setForm] = useState<ControlsData | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useTab<Tab>('controls', TABS.map((t) => t.key), 'trading');
  useEffect(() => {
    if (data) setForm(structuredClone(data));
  }, [data]);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: ok });
      await reload();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (loading && !data) return <Loading />;
  if (!form || !data) return error ? <ErrorBox message={error} /> : null;
  const set = <K extends keyof ControlsData>(k: K, v: Partial<ControlsData[K]>) => setForm({ ...form, [k]: { ...form[k], ...v } });
  const stopped = form.state.killSwitch || form.state.paused;
  const dirty = editable(form) !== editable(data);

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
      'Saved. The bot uses the new settings within 30 seconds.',
    );

  const state = form.state.killSwitch
    ? { dot: 'bg-critical', title: 'Kill switch on', text: 'No trading at all.' }
    : form.state.paused
      ? { dot: 'bg-warning', title: 'Paused', text: 'No new buys; open trades are still managed.' }
      : { dot: 'bg-good', title: 'Running', text: 'Scanning and trading.' };

  return (
    <>
      <PageHeader title="Controls" subtitle="Changes apply within 30 seconds, no restart needed." />
      <Tabs tabs={[...TABS]} value={tab} onChange={setTab} sticky label="Settings sections" />
      {msg && (
        <div role="status" className={`pop mb-4 flex items-start gap-2 rounded-xl border px-3.5 py-3 text-sm ${msg.ok ? 'border-good/40 bg-good/10 text-ink' : 'border-critical/40 bg-critical/10 text-ink'}`}>
          <Icon name={msg.ok ? 'check' : 'alert'} size={18} className={msg.ok ? 'text-up' : 'text-critical'} />
          {msg.text}
        </div>
      )}

      {tab === 'trading' && (
        <Stack>
          <SniperMode />
          <Card title="Bot status">
            <div className="mb-4 flex items-center gap-3">
              <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${state.dot} ${!stopped ? 'shadow-[0_0_0_4px_rgba(var(--pnl-up-bg),0.18)]' : ''}`} aria-hidden="true" />
              <div>
                <div className="font-semibold text-ink">{state.title}</div>
                <div className="text-sm text-muted">{state.text}</div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {stopped ? (
                <Button disabled={busy} onClick={() => run(() => api('/api/controls/resume', { method: 'POST' }), 'Resumed.')}>
                  <Icon name="play" size={16} />
                  Resume
                </Button>
              ) : (
                <Button variant="outline" disabled={busy} onClick={() => run(() => api('/api/controls/pause', { method: 'POST', body: JSON.stringify({ paused: true }) }), 'Paused: no new buys.')}>
                  <Icon name="pause" size={16} />
                  Pause buys
                </Button>
              )}
              <Button variant="danger" disabled={busy} onClick={() => window.confirm('KILL SWITCH: stop all trading and sell every open position now?') && run(() => api('/api/controls/kill', { method: 'POST' }), 'Kill switch on: all positions sold.')}>
                <Icon name="stop" size={16} />
                Sell all &amp; stop
              </Button>
            </div>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Trade size">
              <div className="grid grid-cols-2 gap-3">
                <NumberField label="Size per trade" value={form.trading.maxPositionSol} step={0.05} min={0.01} max={10} suffix="SOL" onChange={(v) => set('trading', { maxPositionSol: v })} hint="Raise as results improve." />
                <NumberField label="Max open trades" value={form.trading.maxConcurrentPositions} min={1} max={20} onChange={(v) => set('trading', { maxConcurrentPositions: v })} />
              </div>
            </Card>

            <Card title="Strategies" subtitle="Which kinds of trades it may open.">
              <div className="divide-y divide-line">
                {STRATS.map(([k, l, sub]) => (
                  <Toggle key={k} label={l} sub={sub} checked={form.trading.enabledStrategies[k] ?? false} onChange={(v) => set('trading', { enabledStrategies: { ...form.trading.enabledStrategies, [k]: v } })} />
                ))}
              </div>
            </Card>

            <Card title="Basic buy rules" subtitle="Per-strategy limits are under Rules.">
              <div className="grid grid-cols-2 gap-3">
                <NumberField label="Min score" value={form.entry.minCombinedScore} min={30} max={95} onChange={(v) => set('entry', { minCombinedScore: v })} hint="Lower = more trades." />
                <NumberField label="Min fees paid" value={form.entry.minTotalFeesSol} step={0.1} suffix="SOL" onChange={(v) => set('entry', { minTotalFeesSol: v })} />
                <NumberField label="Min volume" value={form.entry.minVolumeUsd} step={1000} suffix="$" onChange={(v) => set('entry', { minVolumeUsd: v })} />
                <NumberField label="Min market cap" value={form.entry.minMarketCapUsd} step={1000} suffix="$" onChange={(v) => set('entry', { minMarketCapUsd: v })} />
                <NumberField label="Max bundlers" value={form.entry.maxBundlePct} suffix="%" onChange={(v) => set('entry', { maxBundlePct: v })} />
                <NumberField label="Max top 10" value={form.entry.maxTop10Pct} suffix="%" onChange={(v) => set('entry', { maxTop10Pct: v })} />
                <NumberField label="Max dev holds" value={form.entry.maxDevHoldingPct} suffix="%" onChange={(v) => set('entry', { maxDevHoldingPct: v })} />
              </div>
              <div className="mt-3 divide-y divide-line border-t border-line pt-1">
                <Toggle label="Half size on strong coins with bundlers" checked={form.entry.riskyEntry.enabled} onChange={(v) => set('entry', { riskyEntry: { ...form.entry.riskyEntry, enabled: v } })} />
                <Toggle label="Only coins with an X link" checked={form.entry.requireTwitter} onChange={(v) => set('entry', { requireTwitter: v })} />
              </div>
            </Card>

            <Card title="Keywords" subtitle="Comma separated.">
              <div className="grid gap-3">
                <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                  Boost (raises the score)
                  <textarea rows={3} value={form.keywords.boost.join(', ')} onChange={(e) => set('keywords', { boost: e.target.value.split(',').map((x) => x.trim()) })} className="rounded-xl border border-line-strong bg-surface px-3 py-2 text-sm text-ink transition-colors focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30" />
                </label>
                <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                  Block (never buys)
                  <textarea rows={3} value={form.keywords.block.join(', ')} onChange={(e) => set('keywords', { block: e.target.value.split(',').map((x) => x.trim()) })} className="rounded-xl border border-line-strong bg-surface px-3 py-2 text-sm text-ink transition-colors focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30" />
                </label>
              </div>
            </Card>
          </div>
        </Stack>
      )}
      {tab === 'rules' && <BuyRules />}
      {tab === 'alerts' && <Notifications />}
      {tab === 'feed' && <DataFeed />}
      {tab === 'system' && (
        <Stack>
          <UpdateCard />
          <Card title="Reset paper account" subtitle={`Current starting balance: ${form.paper.startingBalanceSol} SOL.`} className="border-critical/40">
            <ResetPaperForm defaultBalance={10} />
          </Card>
        </Stack>
      )}

      {/* Save bar: only while the Trading tab has unsaved changes. A floating pill above the phone tab bar. */}
      {dirty && (
        <div className="pointer-events-none fixed inset-x-0 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-20 px-4 md:bottom-6 md:left-[4.5rem] md:px-6 lg:left-64">
          <div className="pop pointer-events-auto mx-auto flex max-w-md items-center gap-2 rounded-full border border-line-strong bg-surface p-1.5 pl-4 shadow-card-hover">
            <span className="inline-flex items-center gap-2 text-sm font-medium text-ink">
              <span className="h-2 w-2 rounded-full bg-accent" aria-hidden="true" />
              Unsaved changes
            </span>
            <span className="flex-1" />
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setForm(structuredClone(data))} className="rounded-full">
              Discard
            </Button>
            <Button size="sm" disabled={busy} onClick={save} className="rounded-full px-4">
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
