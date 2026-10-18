/** TradingView's free Advanced Chart widget (live candles, indicators, drawing tools). Display only. */
import { useEffect, useRef } from 'react';

export const tvSymbol = (id: string) => (id === 'XAUUSD' ? 'OANDA:XAUUSD' : id === 'XAGUSD' ? 'OANDA:XAGUSD' : `OANDA:${id}`);

export function TvChart({ pair, interval = '5', height = 460 }: { pair: string; interval?: string; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = '';
    const inner = document.createElement('div');
    inner.className = 'tradingview-widget-container__widget';
    inner.style.height = '100%';
    el.appendChild(inner);
    const dark = document.documentElement.classList.contains('dark') || window.matchMedia('(prefers-color-scheme: dark)').matches;
    const s = document.createElement('script');
    s.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
    s.async = true;
    s.type = 'text/javascript';
    s.innerHTML = JSON.stringify({
      autosize: true,
      symbol: tvSymbol(pair),
      interval,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Etc/UTC',
      theme: dark ? 'dark' : 'light',
      style: '1',
      locale: 'en',
      allow_symbol_change: false,
      hide_side_toolbar: false,
      withdateranges: true,
      details: false,
      calendar: false,
      support_host: 'https://www.tradingview.com',
    });
    el.appendChild(s);
    return () => {
      el.innerHTML = '';
    };
  }, [pair, interval]);
  return <div ref={ref} className="tradingview-widget-container overflow-hidden rounded-xl border border-line" style={{ height }} />;
}
