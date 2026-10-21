/**
 * v17.11 the live price the forex side uses: the freshest of the live streams — Pyth (only with a Pyth API key) and
 * Yahoo's streamer (free, no account). Same surface as one stream: `get(id)` (+ which stream it came from),
 * `flowing()`, `onTicks()`. Pure apart from the streams it wraps.
 */
import type { LiveTick, MinuteBar } from './pyth';
import { pythLive } from './pyth';
import { yahooLive } from './yahoo-live';
import { coinbaseLive } from './coinbase';
import { hyperliquidLive } from './hyperliquid';

export interface LiveStream {
  readonly name: string;
  get(id: string, now?: number): { px: number; t: number; bars: MinuteBar[] } | null;
  flowing(now?: number): boolean;
  onTicks(fn: (ticks: LiveTick[]) => void): () => void;
}

export class LiveFeed {
  /** v26: `backups` are only asked when none of the main streams has a live price for that market (a venue's own feed
   * whose prices differ a little from the ones the lab was graded on, e.g. Hyperliquid perps vs Coinbase spot) */
  constructor(private readonly streams: readonly LiveStream[], private readonly backups: readonly LiveStream[] = []) {}

  /** the newest live price of a pair across the main streams, else across the backups (null when none is live) */
  get(id: string, now?: number): { px: number; t: number; bars: MinuteBar[]; source: string } | null {
    for (const group of [this.streams, this.backups]) {
      let best: { px: number; t: number; bars: MinuteBar[]; source: string } | null = null;
      for (const s of group) {
        const p = s.get(id, now);
        if (p && (!best || p.t > best.t)) best = { ...p, source: s.name };
      }
      if (best) return best;
    }
    return null;
  }

  flowing(now?: number): boolean {
    return this.streams.some((s) => s.flowing(now)) || this.backups.some((s) => s.flowing(now));
  }

  /** ticks of the main streams; a backup's only for markets no main stream is pricing right now */
  onTicks(fn: (ticks: LiveTick[]) => void): () => void {
    const offs = this.streams.map((s) => s.onTicks(fn));
    for (const b of this.backups) {
      offs.push(
        b.onTicks((ticks) => {
          const mine = ticks.filter((t) => !this.streams.some((s) => s.get(t.id)));
          if (mine.length) fn(mine);
        }),
      );
    }
    return () => offs.forEach((off) => off());
  }
}

/** The one live feed the practice account and the dashboard push use. */
export const liveFeed = new LiveFeed([pythLive, yahooLive, coinbaseLive], [hyperliquidLive]);
