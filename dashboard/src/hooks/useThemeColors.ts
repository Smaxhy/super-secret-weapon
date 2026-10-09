/**
 * Recharts draws SVG attributes, which can't read CSS variables, so we read
 * the resolved token values and re-read them when the theme changes.
 */
import { useEffect, useState } from 'react';

const NAMES = ['series-1', 'pos', 'neg', 'grid', 'axis', 'muted', 'ink', 'ink-2', 'surface', 'border', 'good', 'warning', 'critical', 'accent'] as const;
export type ThemeColors = Record<(typeof NAMES)[number], string>;

function read(): ThemeColors {
  const cs = getComputedStyle(document.documentElement);
  return Object.fromEntries(NAMES.map((n) => [n, cs.getPropertyValue(`--${n}`).trim()])) as ThemeColors;
}

export function useThemeColors(): ThemeColors {
  const [c, setC] = useState(read);
  useEffect(() => {
    const update = () => setC(read());
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', update);
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      mq.removeEventListener('change', update);
      mo.disconnect();
    };
  }, []);
  return c;
}
