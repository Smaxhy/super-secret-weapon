/**
 * v17.8 Auto-bot: the bot's open trade, live (owner: "see the active trade and the graph it's in"). Candles of its
 * pair with the entry (and when it entered), the stop, the target and the live price; P&L in $ and pips, room to the
 * stop and the target, time in the trade; every rule that can close it; "Close now". Several trades → a switch.
 */
import { useEffect, useRef, useState } from 'react';
import { useApi } from '../hooks/useApi';
import { duration } from '../lib/format';
import { MarketChart } from './MarketChart';
import { TvChart } from './TvChart';
import { Badge, Button, Card, Tabs, useStored } from './ui';

export interface ActiveConviction { tier: 'normal' | 'sure' | 'verySure'; conf: number; of: number; mult: number; lev: number | null }
export interface ActivePos {
  id: string;
  pair: string;
  side: 1 | -1;
  entry: number;
  px: number;
  stop: number | null;
  target: number | null;
  openedAt: number;
  pnlUsd: number;
  pnlPct?: number;
  marginUsd?: number;
  leverage?: number;
  strategy?: string;
  tf?: string;
  riskPct?: number;
  conviction?: ActiveConviction | null;
  sniper?: { votes: number; of: number } | null;
  closePending?: { reason: string; at: number } | null;
}
export interface ActivePlan { id: string; name: string; tf: string; lines: Array<{ k: string; text: string; done?: boolean }> }

type Gran = 'M1' | 'M5' | 'M15' | 'H1';
const GRANS: Array<[Gran, string, string]> = [
  ['M1', '1m', '1'],
  ['M5', '5m', '5'],
  ['M15', '15m', '15'],
  ['H1', '1h', '60'],
];
const GRAN_MS: Record<Gran, number> = { M1: 60_000, M5: 300_000, M15: 900_000, H1: 3_600_000 };
/** the trade's own chart → a chart a step finer, so the move since the entry has enough candles */
const DEFAULT_GRAN: Record<string, Gran> = { '1m': 'M1', '15m': 'M5', '1h': 'M15', '4h': 'H1' };

export const fxDigits = (id: string) => (id.includes('JPY') ? 3 : id === 'XAUUSD' ? 2 : id === 'XAGUSD' ? 3 : 5);
export const fxPip = (id: string) => (id.includes('JPY') ? 0.01 : id === 'XAUUSD' ? 0.01 : id === 'XAGUSD' ? 0.001 : 0.0001);
export const fxUsd = (x: number, signed = false) => `${x < 0 ? '−' : signed && x > 0 ? '+' : ''}$${Math.abs(x).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const fxTone = (x: number) => (x > 0 ? 'text-up' : x < 0 ? 'text-down' : 'text-ink-2');
export const sinceOpen = (t: number, now = Date.now()) => duration(Math.max(0, Math.round((now - t) / 1000))).replace(/ 0s$/, '').replace(/^(\d+m) \d+s$/, '$1');
const pipsTxt = (x: number) => `${Math.abs(x) >= 100 ? Math.round(Math.abs(x)) : Math.abs(x).toFixed(1)}`;

/** Candle rows from the API: [t,o,h,l,c] arrays or {t,o,h,l,c} objects (both shapes exist). Pure. */
export function toBars(raw: unknown): number[][] {
  if (!Array.isArray(raw)) return [];
  const out: number[][] = [];
  const num = (v: unknown) => (typeof v === 'number' ? v : NaN);
  for (const b of raw) {
    const r = Array.isArray(b) ? b.slice(0, 5).map(num) : b && typeof b === 'object' ? ['t', 'o', 'h', 'l', 'c'].map((k) => num((b as Record<string, unknown>)[k])) : null;
    // a missing value is not a 0 price
    if (r && r.length === 5 && r.every(Number.isFinite) && r.slice(1).every((p) => p > 0)) out.push(r);
  }
  return out.sort((a, b) => a[0]! - b[0]!);
}

/** Minutes since the newest candle opened when the feed is behind (> 3 candles and > 5 min; Yahoo metals run ~10 min
 * late), else null — the chart then says so instead of looking like the trade opened "in the future". Pure. */
export function candleLagMin(bars: number[][], barMs: number, now = Date.now()): number | null {
  const t = bars.length ? bars[bars.length - 1]![0]! : NaN;
  if (!Number.isFinite(t)) return null;
  const age = now - t;
  return age > Math.max(3 * barMs, 5 * 60_000) ? Math.round(age / 60_000) : null;
}

/** Width of an element, kept up to date. */
function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.round(el.clientWidth)));
    ro.observe(el);
    setW(Math.round(el.clientWidth));
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** True while the element is on screen (candles only refresh then). */
function useOnScreen<T extends HTMLElement>(ref: React.RefObject<T>): boolean {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((e) => setOn(e.some((x) => x.isIntersecting)), { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return on;
}

export function FxActiveTrade({ positions, selectedId, onSelect, plan, onClose, id = 'fx-active-trade' }: { positions: ActivePos[]; selectedId: string | null; onSelect: (id: string) => void; plan: ActivePlan[]; onClose: (id: string) => void; id?: string }) {
  const p = positions.find((x) => x.id === selectedId) ?? positions[0];
  if (!p) return null;
  const pl = plan.find((x) => x.id === p.id) ?? null;
  return (
    <Card id={id} padded={false} className="scroll-mt-[calc(var(--hdr)+0.75rem)] md:scroll-mt-20">
      {positions.length > 1 && (
        <div className="px-4 pt-4 sm:px-5">
          <Tabs label="Open trades" tabs={positions.map((x) => ({ key: x.id, label: `${x.side === 1 ? '▲' : '▼'} ${x.pair}` }))} value={p.id} onChange={onSelect} />
        </div>
      )}
      <TradeView key={p.id} p={p} plan={pl} onClose={onClose} />
    </Card>
  );
}

function TradeView({ p, plan, onClose }: { p: ActivePos; plan: ActivePlan | null; onClose: (id: string) => void }) {
  const pip = fxPip(p.pair);
  const dg = fxDigits(p.pair);
  const tf = p.tf ?? plan?.tf ?? null;
  const [gran, setGran] = useState<Gran>(DEFAULT_GRAN[tf ?? ''] ?? 'M5');
  const [view, setView] = useStored<'bot' | 'tv'>('fx.activeView', 'bot', ['bot', 'tv']);
  const [box, width] = useWidth<HTMLDivElement>();
  const visible = useOnScreen(box);
  const phone = width > 0 && width < 560;
  // enough candles to show the whole trade (plus a few before it), rounded so the address changes rarely
  const since = Math.ceil((Date.now() - p.openedAt) / GRAN_MS[gran]);
  const count = Math.min(240, Math.max(phone ? 72 : 120, Math.ceil((since + 12) / 24) * 24));
  const path = view === 'bot' && visible && width > 0 ? `/api/forex/candles?pair=${encodeURIComponent(p.pair)}&tf=${gran}&count=${count}` : null;
  const candles = useApi<{ source?: string; bars?: unknown }>(path, 15_000);
  const bars = toBars(candles.data?.bars);
  const lagMin = candleLagMin(bars, GRAN_MS[gran]);
  const pnlPips = ((p.px - p.entry) * p.side) / pip;
  const toStop = p.stop !== null ? ((p.px - p.stop) * p.side) / pip : null;
  const toTarget = p.target !== null ? ((p.target - p.px) * p.side) / pip : null;
  const name = plan?.name ?? p.strategy ?? 'bot';
  const cv = p.conviction && p.conviction.mult > 1 ? p.conviction : null;
  return (
    <div className="p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={p.side === 1 ? 'up' : 'down'}>{p.side === 1 ? 'Long ▲' : 'Short ▼'}</Badge>
            <span className="text-lg font-semibold leading-tight text-ink">{p.pair}</span>
            {tf && <Badge tone="neutral">{tf} chart</Badge>}
            {p.closePending && <Badge tone="warn">closing at the next price</Badge>}
          </div>
          <div className="mt-1 truncate text-sm text-ink-2" title={name}>{name}</div>
        </div>
        <div className="shrink-0 text-right">
          <div className={`text-2xl font-semibold leading-tight tracking-tight ${fxTone(p.pnlUsd)}`}>{fxUsd(p.pnlUsd, true)}</div>
          <div className={`tabular text-sm font-medium ${fxTone(pnlPips)}`}>{pnlPips > 0 ? '+' : pnlPips < 0 ? '−' : ''}{pipsTxt(pnlPips)} pips</div>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <Fact label="To stop" mark="bg-[#ef4444]" value={toStop === null ? 'none' : toStop <= 0 ? 'at the stop' : `${pipsTxt(toStop)} pips`} sub={p.stop !== null ? p.stop.toFixed(dg) : 'no stop'} />
        <Fact label="Price now" mark="bg-[#6366f1]" value={p.px.toFixed(dg)} sub={`in at ${p.entry.toFixed(dg)}`} />
        <Fact label="To target" mark="bg-[#22c55e]" value={toTarget === null ? 'trailing' : toTarget <= 0 ? 'reached' : `${pipsTxt(toTarget)} pips`} sub={p.target !== null ? p.target.toFixed(dg) : 'no fixed target'} />
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
        <span className="tabular">In the trade {sinceOpen(p.openedAt)}</span>
        {p.riskPct !== undefined && <Badge tone="neutral">risked {p.riskPct}% of the account</Badge>}
        {p.leverage !== undefined && <Badge tone="neutral">{p.leverage}×</Badge>}
        {cv && <Badge tone="accent" title={`${cv.conf} of ${cv.of} checks agreed`}>{cv.tier === 'verySure' ? 'very sure' : 'sure'} · {cv.mult}× size</Badge>}
        {p.sniper && <Badge tone="accent">sniper · {p.sniper.votes}/{p.sniper.of} checks</Badge>}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <Segmented label="Candle size" value={gran} onChange={(g) => setGran(g as Gran)} options={GRANS.map(([g, l]) => [g, l])} />
        <Segmented label="Chart" value={view} onChange={(v) => setView(v as 'bot' | 'tv')} options={[['bot', 'Bot'], ['tv', 'TradingView']]} />
      </div>
      <div ref={box} className="mt-2">
        {view === 'tv' ? (
          <TvChart pair={p.pair} interval={GRANS.find((g) => g[0] === gran)![2]} height={phone ? 380 : 460} />
        ) : bars.length >= 2 && width > 0 ? (
          <div className={`rounded-xl border border-line bg-surface p-1.5 transition-opacity ${candles.error ? 'opacity-60' : ''}`}>
            <MarketChart bars={bars} trades={[{ side: p.side, entryT: p.openedAt, entry: p.entry, stop: p.stop, target: p.target, strategy: name }]} digits={dg} width={width - 14} height={phone ? 250 : 340} live={p.px} entryMarker tradeLabels timeAxis interactive />
          </div>
        ) : (
          <div className="grid h-56 place-items-center rounded-xl border border-dashed border-line-strong px-4 text-center text-sm text-muted">
            {candles.error ? `The chart can't load right now (${candles.error}). Try TradingView.` : candles.data ? 'No candles for this market yet.' : 'Loading the chart…'}
          </div>
        )}
      </div>
      {view === 'bot' && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <Key color="#6366f1">entry</Key>
          {p.stop !== null && <Key color="#ef4444" dashed>stop</Key>}
          {p.target !== null && <Key color="#22c55e" dashed>target</Key>}
          <Key color="#6366f1" dotted>price now</Key>
          <span className="ml-auto">
            {candles.data?.source === 'oanda' ? 'OANDA candles' : candles.data?.source ? 'Yahoo candles' : ''}
            {lagMin !== null ? <span className="text-warning">{`${candles.data?.source ? ' · ' : ''}newest candle ${lagMin >= 90 ? `${Math.round(lagMin / 60)} h` : `${lagMin} min`} old`}</span> : candles.data?.source ? ' · updates every 15 s' : ''}
          </span>
        </div>
      )}

      {!!plan?.lines.length && (
        <div className="mt-4">
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Every rule that can close the trade</div>
          <ol className="space-y-1">
            {plan.lines.map((l, k) => (
              <li key={k} className={`flex gap-2 text-sm ${l.done ? 'text-muted' : 'text-ink-2'}`}>
                <span aria-hidden="true" className={`mt-0.5 shrink-0 ${l.done ? 'text-up' : 'text-muted'}`}>{l.done ? '✓' : '•'}</span>
                <span>{l.text}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      <div className="mt-4 flex items-center justify-between gap-3 border-t border-line pt-3">
        <span className="text-xs text-muted">The bot closes it by itself.</span>
        <Button size="sm" variant="outline" onClick={() => onClose(p.id)}>Close now</Button>
      </div>
    </div>
  );
}

function Fact({ label, value, sub, mark }: { label: string; value: string; sub: string; mark: string }) {
  return (
    <div className="min-w-0 rounded-xl bg-surface-2/60 px-2.5 py-2">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted">
        <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${mark}`} />
        <span className="truncate">{label}</span>
      </div>
      <div className="tabular mt-0.5 truncate text-sm font-semibold text-ink">{value}</div>
      <div className="tabular truncate text-[11px] text-muted">{sub}</div>
    </div>
  );
}

function Key({ color, dashed, dotted, children }: { color: string; dashed?: boolean; dotted?: boolean; children: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <svg width="18" height="6" aria-hidden="true">
        <line x1="0" x2="18" y1="3" y2="3" stroke={color} strokeWidth={dotted ? 1.5 : 2} strokeDasharray={dashed ? '4 3' : dotted ? '1 3' : undefined} strokeLinecap="round" />
      </svg>
      {children}
    </span>
  );
}

/** Small segmented switch (stays on one line on a phone). */
export function Segmented({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: Array<[string, string]> }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex gap-0.5 rounded-lg border border-line bg-surface-2/70 p-0.5">
      {options.map(([k, l]) => (
        <button
          key={k}
          type="button"
          role="radio"
          aria-checked={value === k}
          onClick={() => onChange(k)}
          className={`min-h-8 whitespace-nowrap rounded-md px-2 text-xs font-medium transition-colors duration-150 ${value === k ? 'bg-surface text-ink shadow-[0_1px_3px_rgba(0,0,0,0.18)]' : 'text-muted hover:text-ink'}`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}
