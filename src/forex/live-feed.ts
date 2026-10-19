/**
 * v17.11 the live price the forex side uses: the freshest of the live streams — Pyth (only with a Pyth API key) and
 * Yahoo's streamer (free, no account). Same surface as one stream: `get(id)` (+ which stream it came from),
 * `flowing()`, `onTicks()`. Pure apart from the streams it wraps.
 */
import type { LiveTick, MinuteBar } from './pyth';
import { pythLive } from './pyth';
import { yahooLive } from './yahoo-live';

export interface LiveStream {
  readonly name: string;
  get(id: string, now?: number): { px: number; t: number; bars: MinuteBar[] } | null;
  flowing(now?: number): boolean;
  onTicks(fn: (ticks: LiveTick[]) => void): () => void;
}

export class LiveFeed {
  constructor(private readonly streams: readonly LiveStream[]) {}

  /** the newest live price of a pair across the streams (null when none is live) */
  get(id: string, now?: number): { px: number; t: number; bars: MinuteBar[]; source: string } | null {
    let best: { px: number; t: number; bars: MinuteBar[]; source: string } | null = null;
    for (const s of this.streams) {
      const p = s.get(id, now);
      if (p && (!best || p.t > best.t)) best = { ...p, source: s.name };
    }
    return best;
  }

  flowing(now?: number): boolean {
    return this.streams.some((s) => s.flowing(now));
  }

  onTicks(fn: (ticks: LiveTick[]) => void): () => void {
    const offs = this.streams.map((s) => s.onTicks(fn));
    return () => offs.forEach((off) => off());
  }
}

/** The one live feed the practice account and the dashboard push use. */
export const liveFeed = new LiveFeed([pythLive, yahooLive]);
