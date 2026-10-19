/** Shared building blocks: cards, stats, tabs, rows, tables, drawers, buttons and states — one look across every page. */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { pnl } from '../lib/format';
import { Icon } from './Icon';

const reduceMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function Card({ title, subtitle, action, children, className = '', accent = false, lift = false, padded = true, id }: { title?: ReactNode; subtitle?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; accent?: boolean; lift?: boolean; padded?: boolean; id?: string }) {
  return (
    <section id={id} className={`card min-w-0 ${accent ? 'card-accent' : ''} ${lift ? 'card-lift' : ''} ${padded ? 'p-4 sm:p-5' : ''} ${className}`}>
      {(title || action) && (
        <div className={`flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between ${padded ? 'mb-4' : 'px-4 pt-4 sm:px-5 sm:pt-5'}`}>
          <div className="min-w-0">
            {title && <h2 className="break-words text-[15px] font-semibold leading-snug text-ink">{title}</h2>}
            {subtitle && <p className="mt-1 text-pretty text-[13px] leading-snug text-muted">{subtitle}</p>}
          </div>
          {action && <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm sm:shrink-0">{action}</div>}
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
  return <div className={`mb-2 text-xs font-semibold text-muted ${className}`}>{children}</div>;
}

/** Section heading inside a page: title + one muted line + optional action on the right. Sticky on phones when asked. */
export function SectionHeader({ title, description, action, sticky = false, id }: { title: ReactNode; description?: ReactNode; action?: ReactNode; sticky?: boolean; id?: string }) {
  return (
    <div id={id} className={`flex items-end justify-between gap-3 ${sticky ? 'glass sticky top-[var(--hdr)] z-[5] -mx-4 px-4 py-2 md:static md:mx-0 md:px-0 md:py-0' : ''} scroll-mt-[calc(var(--hdr)+0.5rem)] md:scroll-mt-20`}>
      <div className="min-w-0">
        <h2 className="text-[17px] font-semibold leading-tight tracking-tight text-ink">{title}</h2>
        {description && <p className="mt-0.5 text-pretty text-[13px] text-muted">{description}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
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
export function StatTile({ label, value, sub, tone, delta, spark, icon, compact = false }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: 'up' | 'down' | 'warn'; delta?: number | null; spark?: number[]; icon?: ReactNode; compact?: boolean }) {
  const color = tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : tone === 'warn' ? 'text-warning' : 'text-ink';
  return (
    <div className={`card card-lift flex min-w-0 flex-col ${compact ? 'p-3' : 'p-4'}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="truncate text-xs font-medium text-muted">{label}</div>
        {icon && <span className="text-muted">{icon}</span>}
      </div>
      <div className={`tabular ${compact ? 'mt-1 text-xl' : 'mt-2 text-xl xl:text-2xl'} min-w-0 truncate whitespace-nowrap font-semibold leading-tight tracking-tight ${color}`}>{value}</div>
      {(sub || delta !== undefined || (spark && spark.length > 1)) && (
        <div className={`${compact ? 'mt-1' : 'mt-2'} flex flex-1 items-end justify-between gap-2`}>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-snug text-muted">
            {delta !== undefined && <DeltaChip value={delta} />}
            {sub && <span className="min-w-0">{sub}</span>}
          </div>
          {spark && spark.length > 1 && <Sparkline points={spark} width={72} height={24} tone={tone === 'warn' ? 'accent' : tone} className="mb-0.5" />}
        </div>
      )}
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
            <span className="min-w-0 truncate text-ink-2" title={typeof r.label === 'string' ? r.label : undefined}>{r.label}</span>
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

/** Signed percent with tone (never colour alone: the sign is in the text). */
export function SignedPct({ value, dp = 1, className = '' }: { value: number | null | undefined; dp?: number; className?: string }) {
  if (value === null || value === undefined || !Number.isFinite(value)) return <span className={`text-muted ${className}`}>—</span>;
  const tone = value > 0 ? 'text-up' : value < 0 ? 'text-down' : 'text-ink-2';
  return (
    <span className={`tabular whitespace-nowrap ${tone} ${className}`}>
      {value > 0 ? '+' : ''}
      {value.toFixed(dp)}%
    </span>
  );
}

/**
 * Page heading. On wide screens the top bar already shows the page name, so the big title is only for
 * screen readers there and this row carries the page's live context line and its actions.
 */
export function PageHeader({ title, subtitle, action, keepTitle = false }: { title: string; subtitle?: ReactNode; action?: ReactNode; keepTitle?: boolean }) {
  return (
    <div className={`mb-5 flex flex-wrap items-end justify-between gap-x-3 gap-y-3 sm:mb-6 ${subtitle || action || keepTitle ? '' : 'md:mb-0'}`}>
      <div className="min-w-0 max-w-full">
        <h1 className={`break-words text-[24px] font-bold leading-tight tracking-tight text-ink sm:text-[30px] ${keepTitle ? '' : 'md:sr-only'}`}>{title}</h1>
        {subtitle && <p className={`mt-1 max-w-3xl text-pretty text-sm leading-snug text-muted ${keepTitle ? '' : 'md:mt-0'}`}>{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function Badge({ children, tone = 'neutral', className = '', title }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'up' | 'down' | 'warn'; className?: string; title?: string }) {
  const cls =
    tone === 'accent' ? 'bg-accent/12 text-accent-text' : tone === 'up' ? 'bg-good/12 text-up' : tone === 'down' ? 'bg-critical/12 text-down' : tone === 'warn' ? 'bg-warning/15 text-ink' : 'bg-surface-2 text-ink-2';
  return (
    <span title={title} className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${cls} ${className}`}>
      {children}
    </span>
  );
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

/** Empty state with one line and, optionally, one action. */
export function Empty({ children, action, icon }: { children: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-line-strong px-4 py-8 text-center text-sm text-ink-2">
      {icon && <span className="text-muted">{icon}</span>}
      <div className="max-w-md text-pretty">{children}</div>
      {action}
    </div>
  );
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
export function Loading({ kind = 'page' }: { kind?: 'page' | 'table' | 'tiles' | 'rows' }) {
  if (kind === 'tiles')
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" role="status" aria-label="Loading">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="skeleton h-24 rounded-2xl" />
        ))}
      </div>
    );
  if (kind === 'table')
    return (
      <div className="card space-y-0 overflow-hidden" role="status" aria-label="Loading">
        <div className="skeleton h-10" />
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="flex gap-4 border-t border-line px-4 py-3">
            <div className="skeleton h-4 w-24 rounded" />
            <div className="skeleton h-4 flex-1 rounded" />
            <div className="skeleton h-4 w-16 rounded" />
          </div>
        ))}
      </div>
    );
  if (kind === 'rows')
    return (
      <div className="space-y-3" role="status" aria-label="Loading">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="skeleton h-12 rounded-xl" />
        ))}
      </div>
    );
  return (
    <div className="space-y-4 py-2" role="status" aria-label="Loading">
      <div className="skeleton h-8 w-48 rounded-lg" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="skeleton h-24 rounded-2xl" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-12">
        <div className="skeleton h-64 rounded-2xl lg:col-span-8" />
        <div className="skeleton h-64 rounded-2xl lg:col-span-4" />
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton rounded-lg ${className}`} aria-hidden="true" />;
}

export function Chip({ active, onClick, children, count }: { active: boolean; onClick: () => void; children: ReactNode; count?: number | null }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex min-h-9 items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 text-sm font-medium transition-colors duration-150 ${active ? 'border-accent bg-accent text-on-accent' : 'border-line-strong bg-surface text-ink-2 hover:bg-surface-2 hover:text-ink'}`}
    >
      {children}
      {count !== undefined && count !== null && <span className={`tabular rounded-full px-1.5 text-[11px] font-semibold leading-4 ${active ? 'bg-on-accent/15' : 'bg-surface-2 text-muted'}`}>{count}</span>}
    </button>
  );
}

export const inputCls = 'min-h-11 rounded-xl border border-line-strong bg-surface px-3 py-2 text-sm text-ink transition-colors duration-150 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30';

export function Select({ label, value, onChange, options, className = '' }: { label: string; value: string; onChange: (v: string) => void; options: Array<[string, string]>; className?: string }) {
  return (
    <label className={`flex min-w-0 flex-col gap-1 text-xs font-medium text-muted ${className}`}>
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

/** iOS-style switch, usable standalone or inside a row. */
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-7 w-12 shrink-0 rounded-full ring-1 transition-colors duration-150 disabled:opacity-50 ${checked ? 'bg-accent ring-accent' : 'bg-surface-3 ring-line-strong'}`}
    >
      <span aria-hidden="true" className={`absolute left-0.5 top-0.5 h-6 w-6 rounded-full bg-surface shadow-[0_1px_3px_rgba(0,0,0,0.35)] transition-transform duration-150 ${checked ? 'translate-x-5' : ''}`} />
    </button>
  );
}

/** A switch with a label and description, inside a divided list. */
export function ToggleRow({ label, sub, checked, onChange, disabled }: { label: string; sub?: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-3 py-3 first:pt-1 last:pb-1">
      <span className="min-w-0">
        <span className="block text-sm font-medium text-ink">{label}</span>
        {sub && <span className="block text-xs text-muted">{sub}</span>}
      </span>
      <Switch checked={checked} onChange={onChange} label={label} disabled={disabled} />
    </div>
  );
}

/** Settings field: label, description, control, default + reset. */
export function Field({ label, description, control, defaultText, onReset, changed, status }: { label: ReactNode; description?: ReactNode; control: ReactNode; defaultText?: string; onReset?: () => void; changed?: boolean; status?: { ok: boolean; text: string } | null }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-3 first:pt-0 last:pb-0 sm:gap-6">
      <div className="min-w-0">
        <div className="text-sm font-medium text-ink">{label}</div>
        {description && <div className="mt-0.5 text-pretty text-xs text-muted">{description}</div>}
        <div className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-muted">
          {defaultText && <span>default {defaultText}</span>}
          {changed && onReset && (
            <button type="button" onClick={onReset} className="font-medium text-accent-text hover:underline">
              reset
            </button>
          )}
          {status && <span className={status.ok ? 'text-up' : 'text-down'}>{status.text}</span>}
        </div>
      </div>
      <div className="flex items-center justify-end gap-2">{control}</div>
    </div>
  );
}

/** Number input with a unit suffix. */
export function NumberInput({ value, onChange, min, max, step, unit, label, className = '', size = 'md' }: { value: string | number; onChange: (v: string) => void; min?: number; max?: number; step?: number | 'any'; unit?: string; label: string; className?: string; size?: 'sm' | 'md' }) {
  return (
    <span className={`flex items-center rounded-xl border border-line-strong bg-surface transition-colors focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/30 ${size === 'sm' ? 'min-h-10' : 'min-h-11'} ${className}`}>
      <input type="number" inputMode="decimal" aria-label={label} value={value} min={min} max={max} step={step ?? 'any'} onChange={(e) => onChange(e.target.value)} className={`tabular w-full min-w-0 bg-transparent px-3 py-2 text-right text-ink outline-none ${size === 'sm' ? 'text-sm' : 'text-base'}`} />
      {unit && <span className="shrink-0 pr-3 text-xs text-muted">{unit}</span>}
    </span>
  );
}

/** Sortable table header cell. */
export function Th({ children, active, dir, onClick, right = false, className = '' }: { children: ReactNode; active?: boolean; dir?: 1 | -1; onClick?: () => void; right?: boolean; className?: string }) {
  return (
    <th scope="col" aria-sort={active ? (dir === 1 ? 'ascending' : 'descending') : undefined} className={`whitespace-nowrap px-3 py-2.5 text-xs font-medium text-muted first:pl-4 last:pr-4 ${right ? 'text-right' : 'text-left'} ${className}`}>
      {onClick ? (
        <button type="button" onClick={onClick} className={`inline-flex items-center gap-1 transition-colors hover:text-ink ${active ? 'text-ink' : ''}`}>
          {children}
          <span aria-hidden="true" className={`text-[10px] ${active ? 'opacity-100' : 'opacity-0'}`}>{dir === 1 ? '▲' : '▼'}</span>
        </button>
      ) : (
        children
      )}
    </th>
  );
}

/** Table wrapper: sticky header, hairlines, hover rows. Put <thead>/<tbody> inside. */
export function Table({ children, minWidth = 720, className = '' }: { children: ReactNode; minWidth?: number; className?: string }) {
  return (
    <div className={`card overflow-hidden ${className}`}>
      <div className="max-h-[70vh] overflow-auto">
        <table className="tabular w-full text-sm" style={{ minWidth }}>
          {children}
        </table>
      </div>
    </div>
  );
}
export const theadCls = 'sticky top-0 z-[1] bg-surface-2/95 backdrop-blur';
export const trCls = 'border-t border-line transition-colors hover:bg-surface-2/60';
export const tdCls = 'px-3 py-2.5 align-middle first:pl-4 last:pr-4';

/** Vertical timeline (change log, diary). */
export function Timeline({ items }: { items: Array<{ key: string; when: ReactNode; title: ReactNode; body?: ReactNode; tone?: 'accent' | 'up' | 'down' | 'muted'; icon?: ReactNode }> }) {
  return (
    <ol className="relative ml-2 border-l border-line pl-5">
      {items.map((it) => {
        const dot = it.tone === 'up' ? 'bg-good' : it.tone === 'down' ? 'bg-critical' : it.tone === 'muted' ? 'bg-line-strong' : 'bg-accent';
        return (
          <li key={it.key} className="relative pb-4 last:pb-0">
            <span aria-hidden="true" className={`absolute -left-[calc(1.25rem+5px)] top-1.5 grid h-2.5 w-2.5 place-items-center rounded-full ring-4 ring-surface ${dot}`}>
              {it.icon}
            </span>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
              <div className="min-w-0 break-words text-sm font-medium text-ink">{it.title}</div>
              <div className="tabular shrink-0 text-xs text-muted">{it.when}</div>
            </div>
            {it.body && <div className="mt-0.5 break-words text-xs text-muted">{it.body}</div>}
          </li>
        );
      })}
    </ol>
  );
}

/** Horizontal stacked bar (shares that sum to ~1). Colours by index from the series ramp. */
export function StackedBar({ parts, height = 12 }: { parts: Array<{ label: string; value: number; tone?: 'accent' | 'up' | 'down' | 'muted' }>; height?: number }) {
  const total = parts.reduce((a, p) => a + Math.max(0, p.value), 0) || 1;
  const fills = ['bg-accent', 'bg-accent/70', 'bg-accent/50', 'bg-accent/35', 'bg-ink-2/50', 'bg-ink-2/35'];
  return (
    <div>
      <div className="flex w-full gap-[2px] overflow-hidden rounded-full" style={{ height }} role="img" aria-label={parts.map((p) => `${p.label} ${Math.round((p.value / total) * 100)}%`).join(', ')}>
        {parts.map((p, i) => (
          <div key={p.label} className={`${p.tone === 'up' ? 'bg-good' : p.tone === 'down' ? 'bg-critical' : fills[i % fills.length]} h-full`} style={{ width: `${(Math.max(0, p.value) / total) * 100}%` }} title={`${p.label}: ${Math.round((p.value / total) * 100)}%`} />
        ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
        {parts.map((p, i) => (
          <li key={p.label} className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className={`h-2 w-2 rounded-sm ${p.tone === 'up' ? 'bg-good' : p.tone === 'down' ? 'bg-critical' : fills[i % fills.length]}`} />
            {p.label} <span className="tabular text-muted">{Math.round((p.value / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Row of heat cells (one hue, intensity by value; green/red when `signed`). */
export function HeatRow({ cells, signed = false, labels, ariaLabel }: { cells: Array<{ key: string; value: number | null; title: string }>; signed?: boolean; labels?: string[]; ariaLabel: string }) {
  const max = Math.max(0.0001, ...cells.map((c) => Math.abs(c.value ?? 0)));
  return (
    <div>
      <div className="flex gap-[3px]" role="img" aria-label={ariaLabel}>
        {cells.map((c) => {
          const v = c.value;
          const k = v === null ? 0 : Math.min(1, Math.abs(v) / max);
          const bg = v === null ? 'var(--surface-2)' : signed ? `rgba(var(${v >= 0 ? '--pnl-up-bg' : '--pnl-down-bg'}), ${0.15 + 0.7 * k})` : `color-mix(in srgb, var(--accent) ${Math.round(12 + 80 * k)}%, var(--surface-2))`;
          return <span key={c.key} title={c.title} className="h-7 min-w-0 flex-1 rounded-[5px] transition-colors" style={{ background: bg }} />;
        })}
      </div>
      {labels && (
        <div className="mt-1 flex justify-between text-[10px] text-muted tabular">
          {labels.map((l) => (
            <span key={l}>{l}</span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Slide-in panel: from the right on desktop, from the bottom on phones. */
export function Drawer({ open, onClose, title, subtitle, children, wide = false }: { open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', h);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fade-in fixed inset-0 z-40 bg-black/55" onClick={onClose} aria-hidden="true">
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className={`sheet-up absolute inset-x-0 bottom-0 max-h-[90vh] overflow-y-auto rounded-t-3xl border-t border-line bg-page shadow-2xl md:drawer-in md:inset-y-0 md:left-auto md:right-0 md:max-h-none md:w-full md:rounded-none md:border-l md:border-t-0 ${wide ? 'md:max-w-2xl' : 'md:max-w-lg'}`}
      >
        <div className="glass sticky top-0 z-[1] border-b border-line px-4 pb-3 pt-2 md:px-6 md:pt-4">
          <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-line-strong md:hidden" aria-hidden="true" />
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="truncate text-lg font-bold text-ink">{title}</h2>
              {subtitle && <div className="mt-0.5 text-xs text-muted">{subtitle}</div>}
            </div>
            <button type="button" onClick={onClose} aria-label="Close" className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-surface-2 text-ink-2 hover:text-ink">
              <Icon name="x" size={16} />
            </button>
          </div>
        </div>
        <div className="px-4 pb-[calc(1.25rem+env(safe-area-inset-bottom))] pt-4 md:px-6">{children}</div>
      </div>
    </div>,
    document.body,
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
  return createPortal(
    <div className="fade-in fixed inset-0 z-40 bg-black/55 md:grid md:place-items-center md:p-6" onClick={onClose} aria-hidden="true">
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
    </div>,
    document.body,
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
  return <div className={`glass sticky top-[var(--hdr)] z-10 -mx-4 mb-4 px-4 py-2 sm:-mx-6 sm:px-6 ${className}`}>{bar}</div>;
}

/**
 * Section navigation: a vertical list on the left of a two-column page (desktop) and segmented tabs on phones.
 * Use with `layout="select"` to show one section at a time, or `layout="anchor"` to scroll to anchored sections.
 */
export function SectionNav<K extends string>({ items, value, onChange, label = 'Sections' }: { items: ReadonlyArray<{ key: K; label: string; icon?: ReactNode; badge?: ReactNode }>; value: K; onChange: (k: K) => void; label?: string }) {
  return (
    <>
      <nav aria-label={label} className="hidden md:block">
        <ul className="sticky top-[calc(var(--hdr)+1.5rem)] flex flex-col gap-0.5">
          {items.map((it) => {
            const on = it.key === value;
            return (
              <li key={it.key}>
                <button type="button" onClick={() => onChange(it.key)} aria-current={on ? 'true' : undefined} className={`relative flex min-h-10 w-full items-center gap-2.5 rounded-xl px-3 text-left text-sm font-medium transition-colors ${on ? 'bg-accent/12 text-accent-text' : 'text-ink-2 hover:bg-surface-2 hover:text-ink'}`}>
                  {on && <span aria-hidden="true" className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-accent" />}
                  {it.icon && <span className="text-muted">{it.icon}</span>}
                  <span className="min-w-0 flex-1 truncate">{it.label}</span>
                  {it.badge !== undefined && it.badge !== null && <span className="tabular text-xs text-muted">{it.badge}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="md:hidden">
        <Tabs tabs={items.map((i) => ({ key: i.key, label: i.label, badge: i.badge }))} value={value} onChange={onChange} sticky label={label} />
      </div>
    </>
  );
}

/** Two-column page: a narrow nav column on the left, content on the right (stacked on phones). */
export function SplitLayout({ nav, children }: { nav: ReactNode; children: ReactNode }) {
  return (
    <div className="md:grid md:grid-cols-[13rem_minmax(0,1fr)] md:gap-6 lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-8">
      <div className="min-w-0">{nav}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
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

/** Small remembered-per-device string state. */
export function useStored<T extends string>(key: string, initial: T, allowed?: readonly T[]): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const s = localStorage.getItem(key) as T | null;
      return s && (!allowed || allowed.includes(s)) ? s : initial;
    } catch {
      return initial;
    }
  });
  const set = (x: T) => {
    setV(x);
    try {
      localStorage.setItem(key, x);
    } catch {
      /* private mode */
    }
  };
  return [v, set];
}

/** Hairline-separated inline facts: "12 trades · 51% wins · +0.3 SOL". */
export function Facts({ items, className = '' }: { items: Array<ReactNode | null | undefined | false>; className?: string }) {
  const shown = items.filter(Boolean);
  return (
    <span className={`tabular inline-flex flex-wrap items-center gap-x-1.5 text-xs text-muted ${className}`}>
      {shown.map((it, i) => (
        <span key={i} className="inline-flex items-center gap-1.5">
          {i > 0 && <span aria-hidden="true">·</span>}
          {it}
        </span>
      ))}
    </span>
  );
}
