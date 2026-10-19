/**
 * v17.9 live prices: a number that flashes green on an up-tick and red on a down-tick (~600 ms; nothing with
 * prefers-reduced-motion), and the small "LIVE" badge shown while the bot's price stream is moving.
 */
import { useEffect, useRef, useState } from 'react';
import { isLive, useFxLive, useReducedMotion, type FxLive } from '../hooks/useFxLive';

/** `text` defaults to value.toFixed(digits); it only flashes when the shown text changes. */
export function LivePrice({ value, digits = 5, text, className = '', flash = true, title }: { value: number; digits?: number; text?: string; className?: string; flash?: boolean; title?: string }) {
  const shown = text ?? (Number.isFinite(value) ? value.toFixed(digits) : '—');
  const reduced = useReducedMotion();
  const prev = useRef<{ text: string; value: number }>({ text: shown, value });
  const [tick, setTick] = useState<{ dir: 1 | -1; n: number } | null>(null);
  useEffect(() => {
    const p = prev.current;
    prev.current = { text: shown, value };
    if (!flash || reduced || p.text === shown || !Number.isFinite(p.value) || !Number.isFinite(value) || p.value === value) return;
    setTick((x) => ({ dir: value > p.value ? 1 : -1, n: (x?.n ?? 0) + 1 }));
    const t = setTimeout(() => setTick(null), 650);
    return () => clearTimeout(t);
  }, [shown, value, flash, reduced]);
  // a new key restarts the animation on every tick
  return (
    <span key={tick?.n ?? 0} title={title} className={`tabular ${tick ? (tick.dir === 1 ? 'tick-up' : 'tick-down') : ''} ${className}`}>
      {shown}
    </span>
  );
}

/** "● LIVE" while any pair moved in the last 10 s; nothing otherwise (older server, market closed, socket down). */
export function LiveBadge({ fx, className = '' }: { fx?: FxLive; className?: string }) {
  const own = useFxLive();
  if (!isLive(fx ?? own)) return null;
  return (
    <span title="Live prices from the bot, as they change" className={`inline-flex shrink-0 items-center gap-1 rounded-full border border-good/40 bg-good/10 px-1.5 py-0.5 text-[10px] font-bold uppercase leading-none tracking-[0.1em] text-up ${className}`}>
      <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-good opacity-70" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-good" />
      </span>
      Live
    </span>
  );
}
