/** Bot controls: pause / kill switch, trade size, entry rules, keywords, paper account reset. */
import { useEffect, useMemo, useState } from 'react';
import { ResetPaperForm } from '../components/ResetPaper';
import { groupRules, matchesRule, RuleGroup, useRuleSettings } from '../components/BuyRules';
import { DataFeed } from '../components/DataFeed';
import { SniperMode } from '../components/SniperMode';
import { Notifications } from '../components/Notifications';
import { Icon } from '../components/Icon';
import { UpdateCard } from '../components/UpdateCard';
import { Button, Card, Empty, ErrorBox, Field, inputCls, Loading, NumberInput, PageHeader, SectionHeader, Switch, Tabs, useStored, useTab } from '../components/ui';
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

/** A number setting row on the Trading form (saved with the floating Save pill). */
function NumRow({ label, description, value, onChange, step = 1, min, max, unit, saved }: { label: string; description?: string; value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; unit?: string; saved: number }) {
  return (
    <Field
      label={label}
      description={description}
      changed={value !== saved}
      onReset={() => onChange(saved)}
      control={<NumberInput size="sm" label={label} value={value} step={step} min={min} max={max} unit={unit} onChange={(v) => onChange(Number(v))} className="w-28 sm:w-36" />}
    />
  );
}

/** Things on the Trading form that the settings search can point to. */
const TRADING_FIELDS = ['Pause buys', 'Kill switch', 'Size per trade', 'Max open trades', 'Strategies', 'New pairs', 'Soon', 'After migration', 'Runners', 'Swing', 'KOL follow', 'Min score', 'Min fees paid', 'Min volume', 'Min market cap', 'Max bundlers', 'Max top 10', 'Max dev holds', 'Half size', 'X link', 'Keywords', 'Boost', 'Block', 'Sniper mode'];

const TABS = [
  { key: 'trading', label: 'Trading', icon: 'bolt' },
  { key: 'rules', label: 'Rules', icon: 'sliders' },
  { key: 'connections', label: 'Alerts & feed', icon: 'bell' },
  { key: 'system', label: 'System', icon: 'cpu' },
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
  const rules = useRuleSettings();
  const groups = useMemo(() => groupRules(rules.data?.settings ?? []), [rules.data]);
  const [group, setGroup] = useStored<string>('controls.ruleGroup', '');
  const [query, setQuery] = useState('');
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

  const q = query.trim();
  const currentGroup = groups.find(([g]) => g === group) ?? groups[0];
  const hits = q ? (rules.data?.settings ?? []).filter((x) => matchesRule(x, q)) : [];
  const tradingHits = q ? TRADING_FIELDS.filter((f) => f.toLowerCase().includes(q.toLowerCase())) : [];

  const search = (
    <label className="flex min-h-11 items-center gap-2 rounded-xl border border-line-strong bg-surface px-3 text-sm text-muted focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/30">
      <Icon name="search" size={16} />
      <span className="sr-only">Search settings</span>
      <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search settings" className="min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-muted" />
      {query && (
        <button type="button" onClick={() => setQuery('')} aria-label="Clear search" className="grid h-7 w-7 place-items-center rounded-full text-muted hover:text-ink">
          <Icon name="x" size={14} />
        </button>
      )}
    </label>
  );

  const navBtn = (on: boolean) => `relative flex min-h-10 w-full items-center gap-2.5 rounded-xl px-3 text-left text-sm font-medium transition-colors ${on ? 'bg-accent/12 text-accent-text' : 'text-ink-2 hover:bg-surface-2 hover:text-ink'}`;

  return (
    <>
      <PageHeader title="Controls" subtitle="Changes apply within 30 seconds, no restart needed." />
      <div className="md:grid md:grid-cols-[14rem_minmax(0,1fr)] md:gap-6 lg:grid-cols-[16rem_minmax(0,1fr)] lg:gap-8">
        {/* Settings nav: search + sections (+ rule groups under Rules) on desktop; search + tabs on phones. */}
        <aside className="min-w-0">
          <div className="mb-3 md:hidden">{search}</div>
          <div className="md:hidden">
            <Tabs tabs={TABS.map((t) => ({ key: t.key, label: t.label }))} value={tab} onChange={(k) => { setQuery(''); setTab(k); }} sticky label="Settings sections" />
          </div>
          <nav aria-label="Settings sections" className="sticky top-[calc(var(--hdr)+1.5rem)] hidden max-h-[calc(100vh-var(--hdr)-3rem)] flex-col gap-3 overflow-y-auto pb-4 md:flex">
            {search}
            <ul className="flex flex-col gap-0.5">
              {TABS.map((t) => {
                const on = !q && tab === t.key;
                return (
                  <li key={t.key}>
                    <button type="button" onClick={() => { setQuery(''); setTab(t.key); }} aria-current={on ? 'true' : undefined} className={navBtn(on)}>
                      {on && <span aria-hidden="true" className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-accent" />}
                      <Icon name={t.icon} size={16} className="text-muted" />
                      <span className="flex-1">{t.label}</span>
                      {t.key === 'rules' && <span className="tabular text-xs text-muted">{rules.data?.settings.length ?? ''}</span>}
                    </button>
                    {t.key === 'rules' && tab === 'rules' && !q && (
                      <ul className="ml-4 mt-0.5 flex flex-col border-l border-line pl-2">
                        {groups.map(([g, list]) => (
                          <li key={g}>
                            <button type="button" onClick={() => setGroup(g)} aria-current={currentGroup?.[0] === g ? 'true' : undefined} className={`flex min-h-9 w-full items-center justify-between gap-2 rounded-lg px-2.5 text-left text-[13px] transition-colors ${currentGroup?.[0] === g ? 'bg-surface-2 font-medium text-ink' : 'text-ink-2 hover:bg-surface-2 hover:text-ink'}`}>
                              <span className="min-w-0 truncate" title={g}>{g}</span>
                              <span className="tabular shrink-0 text-xs text-muted">{list.length}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </nav>
        </aside>

        <div className="min-w-0">
          {msg && (
            <div role="status" className={`pop mb-4 flex items-start gap-2 rounded-xl border px-3.5 py-3 text-sm ${msg.ok ? 'border-good/40 bg-good/10 text-ink' : 'border-critical/40 bg-critical/10 text-ink'}`}>
              <Icon name={msg.ok ? 'check' : 'alert'} size={18} className={msg.ok ? 'text-up' : 'text-critical'} />
              {msg.text}
            </div>
          )}

          {q ? (
            <div className="flex flex-col gap-6">
              <SectionHeader title={`Settings matching “${q}”`} description={`${hits.length} rule${hits.length === 1 ? '' : 's'}${tradingHits.length ? ` · ${tradingHits.length} on the Trading page` : ''}`} />
              {tradingHits.length > 0 && (
                <Card title="On the Trading page">
                  <div className="flex flex-wrap gap-2">
                    {tradingHits.map((f) => (
                      <button key={f} type="button" onClick={() => { setQuery(''); setTab('trading'); }} className="inline-flex min-h-9 items-center rounded-full border border-line-strong px-3 text-sm text-ink hover:bg-surface-2">
                        {f}
                      </button>
                    ))}
                  </div>
                </Card>
              )}
              {groupRules(hits).map(([g, list]) => (
                <RuleGroup key={g} title={g} list={list} onSaved={() => void rules.reload()} />
              ))}
              {!hits.length && !tradingHits.length && <Empty>No setting matches “{q}”.</Empty>}
            </div>
          ) : (
            <>
              {tab === 'trading' && (
                <div className="flex flex-col gap-6">
                  <SniperMode settings={rules.data?.settings ?? null} error={rules.error} reload={() => void rules.reload()} />
                  <div className="grid gap-6 xl:grid-cols-2">
                    <Card title="Bot status" subtitle={state.text}>
                      <div className="mb-4 flex items-center gap-3">
                        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${state.dot} ${!stopped ? 'shadow-[0_0_0_4px_rgba(var(--pnl-up-bg),0.18)]' : ''}`} aria-hidden="true" />
                        <div className="font-semibold text-ink">{state.title}</div>
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
                    <Card title="Trade size">
                      <div className="divide-y divide-line">
                        <NumRow label="Size per trade" description="Average size; raise it as results improve." value={form.trading.maxPositionSol} saved={data.trading.maxPositionSol} step={0.05} min={0.01} max={10} unit="SOL" onChange={(v) => set('trading', { maxPositionSol: v })} />
                        <NumRow label="Max open trades" value={form.trading.maxConcurrentPositions} saved={data.trading.maxConcurrentPositions} min={1} max={20} onChange={(v) => set('trading', { maxConcurrentPositions: v })} />
                      </div>
                    </Card>
                  </div>
                  <div className="grid gap-6 xl:grid-cols-2">
                    <Card title="Strategies" subtitle="Which kinds of trades it may open.">
                      <div className="divide-y divide-line">
                        {STRATS.map(([k, l, sub]) => (
                          <Field key={k} label={l} description={sub} changed={(form.trading.enabledStrategies[k] ?? false) !== (data.trading.enabledStrategies[k] ?? false)} control={<Switch label={l} checked={form.trading.enabledStrategies[k] ?? false} onChange={(v) => set('trading', { enabledStrategies: { ...form.trading.enabledStrategies, [k]: v } })} />} />
                        ))}
                      </div>
                    </Card>
                    <Card title="Basic buy rules" subtitle="Per-strategy limits are under Rules.">
                      <div className="divide-y divide-line">
                        <NumRow label="Min score" description="Lower = more trades." value={form.entry.minCombinedScore} saved={data.entry.minCombinedScore} min={30} max={95} onChange={(v) => set('entry', { minCombinedScore: v })} />
                        <NumRow label="Min fees paid" value={form.entry.minTotalFeesSol} saved={data.entry.minTotalFeesSol} step={0.1} unit="SOL" onChange={(v) => set('entry', { minTotalFeesSol: v })} />
                        <NumRow label="Min volume" value={form.entry.minVolumeUsd} saved={data.entry.minVolumeUsd} step={1000} unit="$" onChange={(v) => set('entry', { minVolumeUsd: v })} />
                        <NumRow label="Min market cap" value={form.entry.minMarketCapUsd} saved={data.entry.minMarketCapUsd} step={1000} unit="$" onChange={(v) => set('entry', { minMarketCapUsd: v })} />
                        <NumRow label="Max bundlers" value={form.entry.maxBundlePct} saved={data.entry.maxBundlePct} unit="%" onChange={(v) => set('entry', { maxBundlePct: v })} />
                        <NumRow label="Max top 10" value={form.entry.maxTop10Pct} saved={data.entry.maxTop10Pct} unit="%" onChange={(v) => set('entry', { maxTop10Pct: v })} />
                        <NumRow label="Max dev holds" value={form.entry.maxDevHoldingPct} saved={data.entry.maxDevHoldingPct} unit="%" onChange={(v) => set('entry', { maxDevHoldingPct: v })} />
                        <Field label="Half size on strong coins with bundlers" control={<Switch label="Half size on strong coins with bundlers" checked={form.entry.riskyEntry.enabled} onChange={(v) => set('entry', { riskyEntry: { ...form.entry.riskyEntry, enabled: v } })} />} />
                        <Field label="Only coins with an X link" description="Off by default: turning it on skips most new coins." control={<Switch label="Only coins with an X link" checked={form.entry.requireTwitter} onChange={(v) => set('entry', { requireTwitter: v })} />} />
                      </div>
                    </Card>
                  </div>
                  <Card title="Keywords" subtitle="Comma separated. Boost words raise the score; block words are never bought.">
                    <div className="grid gap-4 lg:grid-cols-2">
                      <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                        Boost
                        <textarea rows={3} value={form.keywords.boost.join(', ')} onChange={(e) => set('keywords', { boost: e.target.value.split(',').map((x) => x.trim()) })} className={`${inputCls} min-h-24`} />
                      </label>
                      <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                        Block
                        <textarea rows={3} value={form.keywords.block.join(', ')} onChange={(e) => set('keywords', { block: e.target.value.split(',').map((x) => x.trim()) })} className={`${inputCls} min-h-24`} />
                      </label>
                    </div>
                  </Card>
                </div>
              )}
              {tab === 'rules' && (
                <div className="flex flex-col gap-4">
                  <SectionHeader title="Rules" description="Every rule the bot uses. Each change saves at once and shows up under “What the bot changed”." />
                  <label className="flex flex-col gap-1 text-xs font-medium text-muted md:hidden">
                    Group
                    <select value={currentGroup?.[0] ?? ''} onChange={(e) => setGroup(e.target.value)} className={inputCls}>
                      {groups.map(([g, list]) => (
                        <option key={g} value={g}>{g} ({list.length})</option>
                      ))}
                    </select>
                  </label>
                  {rules.error && <ErrorBox message={rules.error} />}
                  {currentGroup ? <RuleGroup title={currentGroup[0]} list={currentGroup[1]} onSaved={() => void rules.reload()} /> : <Loading kind="rows" />}
                </div>
              )}
              {tab === 'connections' && (
                <div className="grid gap-6 xl:grid-cols-2">
                  <Notifications />
                  <DataFeed />
                </div>
              )}
              {tab === 'system' && (
                <div className="grid gap-6 xl:grid-cols-2">
                  <UpdateCard />
                  <Card title="Reset paper account" subtitle={`Current starting balance: ${form.paper.startingBalanceSol} SOL.`} className="border-critical/40">
                    <ResetPaperForm defaultBalance={10} />
                  </Card>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Save bar: only while the Trading tab has unsaved changes. A floating pill above the phone tab bar. */}
      {dirty && (
        <div className="pointer-events-none fixed inset-x-0 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-20 px-4 md:bottom-6 md:left-[4.5rem] md:px-6 lg:left-60">
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
