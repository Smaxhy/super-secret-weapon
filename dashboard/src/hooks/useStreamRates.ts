/**
 * Live stream speed (trades and launches per minute) from the bot's 5-second 'stats' pulse, which carries the
 * scanner's cumulative counters. Needs ~10 s of pulses before it shows a number.
 */
import { useCallback, useRef, useState } from 'react';
import { useBotEvents, type BotEvent } from './useWebSocket';

export interface StreamRates {
  tradesPerMin: number | null;
  launchesPerMin: number | null;
}

export function useStreamRates(): StreamRates {
  const samples = useRef<Array<{ t: number; trades: number; launches: number }>>([]);
  const [rates, setRates] = useState<StreamRates>({ tradesPerMin: null, launchesPerMin: null });
  const onEvent = useCallback((e: BotEvent) => {
    if (e.type !== 'stats' || typeof e.data.trades !== 'number') return;
    const now = Date.now();
    const trades = e.data.trades;
    const launches = typeof e.data.launches === 'number' ? e.data.launches : 0;
    const arr = samples.current;
    const last = arr[arr.length - 1];
    if (last && (trades < last.trades || launches < last.launches)) arr.length = 0; // bot restarted: counters reset
    arr.push({ t: now, trades, launches });
    while (arr.length > 2 && now - arr[0]!.t > 65_000) arr.shift();
    const first = arr[0]!;
    const span = now - first.t;
    if (arr.length >= 2 && span >= 10_000) {
      setRates({
        tradesPerMin: Math.max(0, Math.round(((trades - first.trades) / span) * 60_000)),
        launchesPerMin: Math.max(0, Math.round(((launches - first.launches) / span) * 600_000) / 10),
      });
    }
  }, []);
  useBotEvents(onEvent);
  return rates;
}
