/** Width of an element in px, kept up to date (charts draw at the real width so text stays readable on a phone).
 * v26.3: a callback ref — the element may mount AFTER the first render (a chart inside a toggle, a drawer, or behind a
 * loading state); the old `useEffect([])` version never saw it, so those charts stayed blank until a reload. The ref
 * also carries `current`, so it still works where a RefObject is expected. */
import { useCallback, useEffect, useRef, useState } from 'react';

export type WidthRef<T extends HTMLElement> = ((el: T | null) => void) & { current: T | null };

export function useWidth<T extends HTMLElement>(): [WidthRef<T>, number] {
  const [el, setEl] = useState<T | null>(null);
  const [w, setW] = useState(0);
  const box = useRef<{ current: T | null }>({ current: null });
  const ref = useCallback((node: T | null) => {
    box.current.current = node;
    setEl(node);
  }, []) as WidthRef<T>;
  // the same function every render; `current` reads the element it was given last
  if (!Object.getOwnPropertyDescriptor(ref, 'current')) Object.defineProperty(ref, 'current', { get: () => box.current.current, set: (v: T | null) => { box.current.current = v; } });
  useEffect(() => {
    if (!el) return;
    let raf = 0;
    const read = () => {
      cancelAnimationFrame(raf);
      // one read per frame; ignore sub-pixel jitter (a scrollbar flicker would redraw the chart over and over)
      raf = requestAnimationFrame(() => setW((old) => {
        const nw = Math.round(el.clientWidth);
        return Math.abs(nw - old) >= 2 ? nw : old;
      }));
    };
    const ro = new ResizeObserver(read);
    ro.observe(el);
    setW(Math.round(el.clientWidth));
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [el]);
  return [ref, w];
}
