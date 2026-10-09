/**
 * Open positions with live prices.
 *
 * Loads /api/positions (full details, refreshed every 10s and after each
 * trade) and overlays the WebSocket 'positions' event that the bot sends
 * every ~2 seconds, so the multiple, P&L and market cap tick in real time.
 * Used by the Positions page and the Overview preview.
 */
import { useCallback, useEffect, useState } from 'react';
import type { LivePositionUpdate, OpenPosition } from '../lib/types';
import { useApi } from './useApi';
import { useBotEvents, type BotEvent } from './useWebSocket';

/** A position with live numbers merged in, plus a few handy derived values. */
export interface LivePosition extends OpenPosition {
  /** The latest WebSocket update for this position (undefined until the first one arrives). */
  live?: LivePositionUpdate & { at: number };
  /** Market cap now, in SOL and USD (live when we have a fresh price). */
  mcNowSol: number | null;
  mcNowUsd: number | null;
  /** Market cap at our buy, in USD (falls back to today's SOL price for older positions). */
  mcEntryUsd: number | null;
  /** % change in market cap since our buy. */
  mcChangePct: number | null;
}

/** Turn the API row + the latest live tick into one object the UI can show. */
export function mergeLive(base: OpenPosition, u?: LivePositionUpdate & { at: number }): LivePosition {
  const supply = base.totalSupplyTokens || 1_000_000_000;
  const p: OpenPosition = u
    ? {
        ...base,
        currentPriceSol: u.priceSol,
        multiple: u.multiple,
        unrealizedPnlSol: u.unrealizedPnlSol,
        peakPriceSol: Math.max(base.peakPriceSol, u.peakMultiple * base.entryPriceSol),
        health: base.health ? { ...base.health, holders: u.holders } : base.health,
      }
    : base;
  // Market cap = price per token × number of tokens.
  const mcNowSol = u ? u.priceSol * supply : (base.currentMarketCapSol ?? (base.currentPriceSol !== null ? base.currentPriceSol * supply : null));
  const mcNowUsd = mcNowSol !== null && base.solUsd ? mcNowSol * base.solUsd : u ? null : base.currentMarketCapUsd;
  const entrySol = base.entryMarketCapSol || base.entryPriceSol * supply;
  const mcEntryUsd = base.entryMarketCapUsd ?? (base.solUsd ? entrySol * base.solUsd : null);
  const mcChangePct = mcNowSol !== null && entrySol > 0 ? (mcNowSol / entrySol - 1) * 100 : null;
  return { ...p, entryMarketCapSol: entrySol, live: u, mcNowSol, mcNowUsd, mcEntryUsd, mcChangePct };
}

/** A live tick older than this is ignored (the pages also stop showing the 'live' dot then). */
const LIVE_FRESH_MS = 4_000;

export function useLivePositions() {
  const { data, error, loading, reload } = useApi<OpenPosition[]>('/api/positions', 10_000, ['trade']);
  const [live, setLive] = useState<Record<string, LivePositionUpdate & { at: number }>>({});
  const onEvent = useCallback((e: BotEvent) => {
    if (e.type !== 'positions') return;
    const updates = (e.data as { updates?: LivePositionUpdate[] }).updates;
    if (!Array.isArray(updates)) return;
    const now = Date.now();
    const next: Record<string, LivePositionUpdate & { at: number }> = {};
    for (const u of updates) next[u.id] = { ...u, at: now };
    setLive((prev) => ({ ...prev, ...next }));
  }, []);
  useBotEvents(onEvent);
  // Remember when the last /api/positions answer arrived, so a newer API row beats an older tick.
  const [loadedAt, setLoadedAt] = useState(0);
  useEffect(() => {
    if (data) setLoadedAt(Date.now());
  }, [data]);
  // Only overlay a live tick while it is fresh and newer than the API data. If the WebSocket
  // drops, the numbers fall back to the 10-second API poll instead of freezing on an old tick.
  const now = Date.now();
  const freshTick = (id: string) => {
    const u = live[id];
    return u && now - u.at < LIVE_FRESH_MS && u.at >= loadedAt ? u : undefined;
  };
  const positions = data?.map((b) => mergeLive(b, freshTick(b.id))) ?? null;
  return { positions, error, loading, reload };
}
