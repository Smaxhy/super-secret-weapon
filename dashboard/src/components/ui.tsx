/** Shared building blocks: cards, stats, tabs, rows, buttons and states — one look across every page. */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { pnl } from '../lib/format';
import { Icon } from './Icon';

const reduceMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function Card({ title, subtitle, action, children, className = '', accent = false, lift = false, padded = true }: { title?: ReactNode; subtitle?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; accent?: boolean; lift?: boolean; padded?: boolean }) {
  return (
    <section className={`card min-w-0 ${accent ? 'card-accent' : ''} ${lift ? 'card-lift' : ''} ${padded ? 'p-4 sm:p-5' : ''} ${className}`}>
      {(title || action) && (
        <div className={`flex items-start justify-between gap-3 ${padded ? 'mb-4' : 'px-4 pt-4 sm:px-5 sm:pt-5'}`}>
          <div className="min-w-0">
            {title && <h2 className="break-words text-[15px] font-semibold leading-snug text-ink">{title}</h2>}
            {subtitle && <p className="mt-1 text-pretty text-[13px] leading-snug text-muted">{subtitle}</p>}
          </div>
          {action && <div className="flex shrink-0 items-center gap-2 text-sm">{action}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** Vertical stack with the standard gap between cards (children fade in, staggered). */
export function Stack({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`stagger flex min-w-0 flex-col gap-4 ${className}`}>{children}</div>;
}

/** Small uppercase label above a group of rows or stats. */
export function SectionLabel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted ${className}`}>{children}</div>;
}

/** Counts up to a number on first paint (skipped when the user prefers reduced motion). */
export function AnimatedNumber({ value, format, duration = 700 }: { value: number; format: (v: number) => string; duration?: number }) {
  const [shown, setShown] = useState(() => (reduceMotion() ? value : 0));
  const prev = useRef(shown);
  useEffect(() => {
    if (reduceMotion()) {
      setShown(value);
      prev.current = value;
      return;
    }
    const from = prev.current;
    const to = value;
    if (from === to) return;
    const t0 = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / duration);
      const e = 1 - Math.pow(1 - k, 3);
      const v = from + (to - from) * e;
      setShown(v);
      if (k < 1) raf = requestAnimationFrame(tick);
      else prev.current = to;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return <>{format(shown)}</>;
}

/** Small signed-change chip (green/red, with sign — never colour alone). */
export function DeltaChip({ value, suffix = '%', dp = 1, className = '' }: { value: number | null | undefined; suffix?: string; dp?: number; className?: string }) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const tone = value > 0 ? 'bg-good/12 text-up' : value < 0 ? 'bg-critical/12 text-down' : 'bg-surface-2 text-ink-2';
  return (
    <span className={`tabular inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-semibold ${tone} ${className}`}>
      <span aria-hidden="true" className="text-[0.75em]">{value > 0 ? '▲' : value < 0 ? '▼' : '•'}</span>
      {value > 0 ? '+' : ''}
      {value.toFixed(dp)}
      {suffix}
    </span>
  );
}

/** Tiny inline line chart (one series, no axes). */
export function Sparkline({ points, width = 96, height = 28, tone = 'accent', className = '' }: { points: number[]; width?: number; height?: number; tone?: 'accent' | 'up' | 'down'; className?: string }) {
  if (points.length < 2) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const step = width / (points.length - 1);
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(height - 2 - ((p - min) / span) * (height - 4)).toFixed(1)}`).join(' ');
  const stroke = tone === 'up' ? 'var(--up-text)' : tone === 'down' ? 'var(--down-text)' : 'var(--accent)';
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className={`shrink-0 ${className}`} aria-hidden="true">
      <path d={d} fill="none" stroke={stroke} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Headline number in its own card (grids of stats). */
export function StatTile({ label, value, sub, tone, delta, spark, icon }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: 'up' | 'down'; delta?: number | null; spark?: number[]; icon?: ReactNode }) {
  const color = tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-ink';
  return (
    <div className="card card-lift min-w-0 p-4 sm:p-5">
      <div className="flex items-center justify-between gap-2">
        <div className="truncate text-xs font-medium text-muted">{label}</div>
        {icon && <span className="text-muted">{icon}</span>}
      </div>
      <div className="mt-2 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className={`tabular break-words text-2xl font-semibold leading-none tracking-tight sm:text-[28px] ${color}`}>{value}</div>
          {(sub || delta !== undefined) && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs leading-snug text-muted">
              {delta !== undefined && <DeltaChip value={delta} />}
              {sub && <span className="min-w-0">{sub}</span>}
            </div>
          )}
        </div>
        {spark && spark.length > 1 && <Sparkline points={spark} tone={tone} className="mb-0.5" />}
      </div>
    </div>
  );
}

/** Label + value inside a card (no box of its own). */
export function Stat({ label, value, sub, tone }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: 'up' | 'down' }) {
  const color = tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-ink';
  return (
    <div className="min-w-0">
      <div className="truncate text-xs font-medium text-muted">{label}</div>
      <div className={`tabular mt-1 break-words text-lg font-semibold leading-tight ${color}`}>{value}</div>
      {sub && <div className="mt-0.5 truncate text-xs text-muted">{sub}</div>}
    </div>
  );
}

/** Key/value list with hairline dividers — the default way to show "name … number" lines. */
export function Rows({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <ul className={`divide-y divide-line text-sm ${className}`}>{children}</ul>;
}
export function Row({ label, value, sub, tone }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: 'up' | 'down' | 'muted' }) {
  const color = tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : tone === 'muted' ? 'text-muted' : 'text-ink';
  return (
    <li className="flex items-start justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <div className="break-words text-ink-2">{label}</div>
        {sub && <div className="mt-0.5 break-words text-xs text-muted">{sub}</div>}
      </div>
      <div className={`tabular shrink-0 text-right font-medium ${color}`}>{value}</div>
    </li>
  );
}

/** Ranked list: label + count with a thin accent bar scaled to the biggest count (skip reasons, exit reasons). */
export function RankedBars({ rows, max: maxIn, tone = 'accent', className = '' }: { rows: Array<{ label: ReactNode; count: number; sub?: ReactNode }>; max?: number; tone?: 'accent' | 'muted'; className?: string }) {
  const max = Math.max(1, maxIn ?? Math.max(...rows.map((r) => r.count)));
  const bar = tone === 'accent' ? 'bg-accent' : 'bg-ink-2/50';
  return (
    <ul className={`space-y-2 ${className}`}>
      {rows.map((r, i) => (
        <li key={i} className="min-w-0">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate text-ink-2">{r.label}</span>
            <span className="tabular shrink-0 font-medium text-ink">{r.count.toLocaleString()}</span>
          </div>
          {r.sub && <div className="truncate text-xs text-muted">{r.sub}</div>}
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
            <div className={`h-full rounded-full ${bar} transition-[width] duration-400`} style={{ width: `${Math.max(2, (r.count / max) * 100)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Horizontal stepper with a number per stage (checked → passed rules → signal → bought). */
export function Funnel({ steps, className = '' }: { steps: Array<{ label: string; n: number; tone?: 'up' | 'warn' }>; className?: string }) {
  return (
    <ol className={`flex min-w-0 items-stretch gap-1 overflow-x-auto no-scrollbar ${className}`} aria-label="Funnel">
      {steps.map((s, i) => (
        <li key={s.label} className="flex min-w-0 flex-1 items-center gap-1">
          <div className={`min-w-0 flex-1 rounded-lg px-2 py-1.5 text-center ${i === steps.length - 1 ? (s.tone === 'up' ? 'bg-good/12' : 'bg-surface-2') : 'bg-surface-2'}`}>
            <div className={`tabular text-base font-semibold leading-none ${s.tone === 'up' ? 'text-up' : s.tone === 'warn' ? 'text-warning' : 'text-ink'}`}>{s.n.toLocaleString()}</div>
            <div className="mt-1 truncate text-[10px] font-medium uppercase tracking-wide text-muted">{s.label}</div>
          </div>
          {i < steps.length - 1 && <Icon name="chevron" size={12} className="shrink-0 text-muted" />}
        </li>
      ))}
    </ol>
  );
}

/** Signed P&L in up/down text colour, with an arrow so colour isn't the only cue. */
export function Pnl({ value, dp = 3, className = '' }: { value: number | null | undefined; dp?: number; className?: string }) {
  if (value === null || value === undefined) return <span className={`text-muted ${className}`}>—</span>;
  const tone = value > 0 ? 'text-up' : value < 0 ? 'text-down' : 'text-ink-2';
  const arrow = value > 0 ? '▲' : value < 0 ? '▼' : '';
  return (
    <span className={`tabular whitespace-nowrap font-medium ${tone} ${className}`}>
      {arrow && <span aria-hidden="true" className="mr-1 text-[0.7em]">{arrow}</span>}
      {pnl(value, dp)}
    </span>
  );
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-x-3 gap-y-3 sm:mb-6">
      <div className="min-w-0 max-w-full">
        <h1 className="break-words text-[24px] font-bold leading-tight tracking-tight text-ink sm:text-[30px]">{title}</h1>
        {subtitle && <p className="mt-1 max-w-2xl text-pretty text-sm leading-snug text-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function Badge({ children, tone = 'neutral', className = '' }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'up' | 'down' | 'warn'; className?: string }) {
  const cls =
    tone === 'accent' ? 'bg-accent/12 text-accent-text' : tone === 'up' ? 'bg-good/12 text-up' : tone === 'down' ? 'bg-critical/12 text-down' : tone === 'warn' ? 'bg-warning/15 text-ink' : 'bg-surface-2 text-ink-2';
  return <span className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${cls} ${className}`}>{children}</span>;
}

export function Button({ children, variant = 'primary', size = 'md', className = '', type = 'button', ...rest }: { children: ReactNode; variant?: 'primary' | 'ghost' | 'danger' | 'outline'; size?: 'sm' | 'md' | 'lg' } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const base = 'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl font-semibold transition-[background-color,transform,box-shadow,opacity] duration-150 ease-out active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50';
  const sz = size === 'sm' ? 'min-h-9 px-3 text-[13px]' : size === 'lg' ? 'min-h-12 px-5 text-[15px]' : 'min-h-11 px-4 text-sm';
  const v =
    variant === 'primary'
      ? 'bg-accent text-on-accent shadow-[0_6px_16px_-8px_var(--accent)] hover:brightness-110'
      : variant === 'danger'
        ? 'border border-critical/40 bg-critical/10 text-down hover:bg-critical/15'
        : variant === 'outline'
          ? 'border border-line-strong bg-surface text-ink hover:bg-surface-2'
          : 'text-ink-2 hover:bg-surface-2 hover:text-ink';
  return (
    <button type={type} className={`${base} ${sz} ${v} ${className}`} {...rest}>
      {children}
    </button>
  );
}

/** Floating circular primary action (phones: above the tab bar). */
export function Fab({ label, onClick, icon, disabled }: { label: string; onClick: () => void; icon: ReactNode; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={label} title={label} className="pop fixed bottom-[calc(5.25rem+env(safe-area-inset-bottom))] right-4 z-20 grid h-14 w-14 place-items-center rounded-full bg-accent text-on-accent shadow-[0_12px_28px_-8px_var(--accent)] transition-transform duration-150 active:scale-95 disabled:opacity-50 md:bottom-8 md:right-8">
      {icon}
    </button>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-line-strong px-4 py-10 text-center text-sm text-ink-2">{children}</div>;
}

export function ErrorBox({ message }: { message: string }) {
  return (
    <div role="alert" className="mb-4 flex items-start gap-2.5 rounded-xl border border-critical/40 bg-critical/10 px-3.5 py-3 text-sm text-ink">
      <Icon name="alert" size={18} className="mt-px text-critical" />
      <span className="min-w-0 break-words">{message}</span>
    </div>
  );
}

/** Placeholder blocks while a page loads (keeps the layout from jumping). */
export function Loading() {
  return (
    <div className="space-y-3 py-2" role="status" aria-label="Loading">
      <div className="skeleton h-7 w-44 rounded-lg" />
      <div className="skeleton h-32 rounded-2xl" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="skeleton h-20 rounded-2xl" />
        <div className="skeleton h-20 rounded-2xl" />
        <div className="skeleton h-20 rounded-2xl" />
        <div className="skeleton h-20 rounded-2xl" />
      </div>
      <div className="skeleton h-24 rounded-2xl" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton rounded-lg ${className}`} aria-hidden="true" />;
}

export function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`min-h-9 whitespace-nowrap rounded-full border px-3.5 text-sm font-medium transition-colors duration-150 ${active ? 'border-accent bg-accent text-on-accent' : 'border-line-strong bg-surface text-ink-2 hover:bg-surface-2 hover:text-ink'}`}
    >
      {children}
    </button>
  );
}

export const inputCls = 'min-h-11 rounded-xl border border-line-strong bg-surface px-3 py-2 text-sm text-ink transition-colors duration-150 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30';

export function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: Array<[string, string]> }) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-muted">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)} className={inputCls}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Phone bottom sheet / desktop centred dialog. */
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fade-in fixed inset-0 z-30 bg-black/55 md:grid md:place-items-center md:p-6" onClick={onClose} aria-hidden="true">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className="sheet-up absolute inset-x-0 bottom-0 max-h-[88vh] overflow-y-auto rounded-t-3xl border-t border-line bg-page px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-2 shadow-2xl md:static md:w-full md:max-w-lg md:rounded-3xl md:border md:p-5"
      >
        <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-line-strong md:hidden" aria-hidden="true" />
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-bold text-ink">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="grid h-9 w-9 place-items-center rounded-full bg-surface-2 text-ink-2 hover:text-ink">
            <Icon name="x" size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export interface TabDef<K extends string> {
  key: K;
  label: string;
  badge?: ReactNode;
}

/**
 * Segmented tabs with a sliding indicator. `sticky` pins them under the phone header while the page scrolls;
 * without it they're an inline switch (e.g. a timeframe picker). Scrolls sideways when the labels don't fit.
 */
export function Tabs<K extends string>({ tabs, value, onChange, sticky = false, label = 'Sections', className = '' }: { tabs: ReadonlyArray<TabDef<K>>; value: K; onChange: (k: K) => void; sticky?: boolean; label?: string; className?: string }) {
  const listRef = useRef<HTMLDivElement>(null);
  const [ind, setInd] = useState<{ x: number; w: number } | null>(null);
  useLayoutEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!el) {
      setInd(null);
      return;
    }
    const update = () => setInd({ x: el.offsetLeft, w: el.offsetWidth });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    if (listRef.current) ro.observe(listRef.current);
    return () => ro.disconnect();
  }, [value, tabs.length]);
  const bar = (
    <div ref={listRef} role="tablist" aria-label={label} className="no-scrollbar relative flex gap-1 overflow-x-auto rounded-xl border border-line bg-surface-2/70 p-1">
      {ind && <span aria-hidden="true" className="absolute top-1 bottom-1 rounded-lg bg-surface shadow-[0_1px_3px_rgba(0,0,0,0.18)] transition-[transform,width] duration-250 ease-out" style={{ transform: `translateX(${ind.x}px)`, width: ind.w, left: 0 }} />}
      {tabs.map((t) => {
        const on = t.key === value;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(t.key)}
            className={`relative z-[1] flex min-h-9 flex-1 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-[13px] font-medium transition-colors duration-150 ${on ? 'text-ink' : 'text-muted hover:text-ink'}`}
          >
            {t.label}
            {t.badge !== undefined && t.badge !== null && t.badge !== 0 && <span className={`tabular rounded-full px-1.5 text-[11px] font-semibold leading-4 ${on ? 'bg-accent/15 text-accent-text' : 'bg-surface text-muted'}`}>{t.badge}</span>}
          </button>
        );
      })}
    </div>
  );
  if (!sticky) return <div className={className}>{bar}</div>;
  return <div className={`glass sticky top-[var(--hdr)] z-10 -mx-4 mb-4 px-4 py-2 sm:-mx-6 sm:px-6 md:top-0 ${className}`}>{bar}</div>;
}

/** Tab state remembered per device (`tab.<id>` in localStorage). */
export function useTab<K extends string>(id: string, keys: readonly K[], fallback: K): [K, (k: K) => void] {
  const [tab, setTab] = useState<K>(() => {
    try {
      const v = localStorage.getItem(`tab.${id}`) as K | null;
      return v && keys.includes(v) ? v : fallback;
    } catch {
      return fallback;
    }
  });
  const set = (k: K) => {
    setTab(k);
    try {
      localStorage.setItem(`tab.${id}`, k);
    } catch {
      /* private mode */
    }
    window.scrollTo({ top: 0 });
  };
  return [tab, set];
}
