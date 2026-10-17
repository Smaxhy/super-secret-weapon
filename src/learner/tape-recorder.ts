/**
 * Tape recorder (v11.5): every trade on every followed coin (bonding curve + PumpSwap, adopted coins included) goes
 * to Postgres `TradeTape` — the replay engine's recording of the market (learner/replay.ts). Buffered in memory,
 * written in batches off the event loop, pruned hourly to `tape.retentionDays`. Nothing in Redis.
 */
import { getConfig } from '../config/runtime-config';
import type { AmmTradeEvent, PumpTradeEvent } from '../config/types';
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { ammPostTradePrice, bondingCurvePct, PUMP_TOKEN_DECIMALS } from '../lib/pumpfun';

const log = moduleLogger('tape');

export interface TapeRowIn {
  mint: string;
  t: Date;
  slot: number | null;
  wallet: string;
  buy: boolean;
  sol: number;
  tokens: number | null;
  px: number;
  pp: number | null;
  amm: boolean;
  curvePct: number | null;
}

export interface TapeStats {
  enabled: boolean;
  /** Trades recorded in the last full minute. */
  perMin: number;
  buffered: number;
  written: number;
  dropped: number;
  failed: number;
  /** Oldest row on disk (null = nothing yet / unknown). */
  oldestAt: string | null;
  daysOnDisk: number | null;
  rowsOnDisk: number | null;
}

export interface TapeConfig {
  enabled: boolean;
  retentionDays: number;
  flushSec: number;
  maxBatch: number;
  maxPerMin: number;
}

/** Pure: write the buffer now? (full batch, or the flush interval passed with something waiting). */
export function shouldFlush(buffered: number, lastFlushMs: number, now: number, c: Pick<TapeConfig, 'flushSec' | 'maxBatch'>): boolean {
  if (buffered <= 0) return false;
  return buffered >= c.maxBatch || now - lastFlushMs >= c.flushSec * 1000;
}

/** Pure: rows older than this are pruned. */
export function retentionCutoff(now: number, retentionDays: number): Date {
  return new Date(now - Math.max(1, retentionDays) * 86_400_000);
}

/** Pure: per-minute disk guard — the n-th trade of this minute (1-based) is kept only up to `maxPerMin`. */
export function withinMinuteCap(nThisMinute: number, maxPerMin: number): boolean {
  return maxPerMin <= 0 || nThisMinute <= maxPerMin;
}

export class TapeRecorder {
  private buf: TapeRowIn[] = [];
  private timer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private flushing = false;
  private lastFlush = Date.now();
  private minuteStart = 0;
  private minuteCount = 0;
  private lastMinute = 0;
  private written = 0;
  private dropped = 0;
  private failed = 0;
  private oldestAt: Date | null = null;
  private rowsOnDisk: number | null = null;

  private cfg(): TapeConfig {
    return (getConfig() as { tape?: TapeConfig }).tape ?? { enabled: false, retentionDays: 5, flushSec: 2, maxBatch: 5000, maxPerMin: 40_000 };
  }

  onCurveTrade(ev: PumpTradeEvent, slot = 0, now = Date.now()): void {
    const tok = Number(ev.tokenAmount) / 10 ** PUMP_TOKEN_DECIMALS;
    const sol = Number(ev.solAmount) / 1e9;
    const pp = ev.virtualTokenReserves > 0n ? Number(ev.virtualSolReserves) / 1e9 / (Number(ev.virtualTokenReserves) / 10 ** PUMP_TOKEN_DECIMALS) : null;
    this.push({
      mint: ev.mint,
      t: new Date(now),
      slot: slot || null,
      wallet: ev.user,
      buy: ev.isBuy,
      sol,
      tokens: tok,
      px: tok > 0 ? sol / tok : 0,
      pp: pp && Number.isFinite(pp) ? pp : null,
      amm: false,
      curvePct: ev.virtualTokenReserves > 0n ? Math.round(bondingCurvePct(ev.virtualTokenReserves) * 100) / 100 : null,
    }, now);
  }

  onAmmTrade(mint: string, ev: AmmTradeEvent, slot = 0, now = Date.now()): void {
    const tok = Number(ev.baseAmount) / 10 ** PUMP_TOKEN_DECIMALS;
    const sol = Number(ev.quoteAmount) / 1e9;
    const pp = ammPostTradePrice(ev);
    this.push({ mint, t: new Date(now), slot: slot || null, wallet: ev.user, buy: ev.isBuy, sol, tokens: tok, px: tok > 0 ? sol / tok : 0, pp: pp && pp > 0 ? pp : null, amm: true, curvePct: null }, now);
  }

  private push(row: TapeRowIn, now: number): void {
    const c = this.cfg();
    if (!c.enabled || !(row.px > 0)) return;
    const minute = Math.floor(now / 60_000);
    if (minute !== this.minuteStart) {
      this.lastMinute = this.minuteCount;
      this.minuteStart = minute;
      this.minuteCount = 0;
    }
    this.minuteCount++;
    if (!withinMinuteCap(this.minuteCount, c.maxPerMin)) {
      this.dropped++;
      return;
    }
    this.buf.push(row);
    if (this.buf.length >= c.maxBatch) void this.flush(now);
  }

  start(): void {
    const c = this.cfg();
    this.timer = setInterval(() => {
      if (shouldFlush(this.buf.length, this.lastFlush, Date.now(), this.cfg())) void this.flush();
    }, Math.max(500, Math.min(c.flushSec, 10) * 1000));
    this.pruneTimer = setInterval(() => void this.prune(), 60 * 60_000);
    setTimeout(() => void this.prune(), 90_000).unref?.();
    if (c.enabled) log.info({ retentionDays: c.retentionDays }, '🎞️ tape recorder on — every trade on every followed coin goes to TradeTape');
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.timer = null;
    this.pruneTimer = null;
    await this.flush();
  }

  /** Write what's buffered (one batch at a time; a failed batch is counted, never retried — the stream is live). */
  async flush(now = Date.now()): Promise<void> {
    if (this.flushing || !this.buf.length) return;
    this.flushing = true;
    const c = this.cfg();
    const take = this.buf.splice(0, c.maxBatch);
    this.lastFlush = now;
    try {
      const r = await prisma.tradeTape.createMany({ data: take });
      this.written += r.count;
    } catch (err) {
      this.failed += take.length;
      if (this.failed <= take.length || this.failed % 50_000 < take.length) log.warn({ err: (err as Error).message, rows: take.length }, 'tape write failed');
    } finally {
      this.flushing = false;
      // Never let a stuck database eat the heap: beyond 20 batches waiting, the oldest go.
      const cap = c.maxBatch * 20;
      if (this.buf.length > cap) {
        this.dropped += this.buf.length - cap;
        this.buf = this.buf.slice(this.buf.length - cap);
      }
    }
  }

  /** Drop rows past the retention window in bounded steps (an hour of tape at a time), then refresh the disk stats. */
  async prune(now = Date.now()): Promise<void> {
    const c = this.cfg();
    if (!c.enabled) return;
    try {
      const cutoff = retentionCutoff(now, c.retentionDays);
      for (let i = 0; i < 48; i++) {
        const oldest = await prisma.tradeTape.findFirst({ orderBy: { t: 'asc' }, select: { t: true } });
        if (!oldest || oldest.t >= cutoff) break;
        const upto = new Date(Math.min(cutoff.getTime(), oldest.t.getTime() + 3_600_000));
        await prisma.tradeTape.deleteMany({ where: { t: { lt: upto } } });
      }
      const oldest = await prisma.tradeTape.findFirst({ orderBy: { t: 'asc' }, select: { t: true } });
      this.oldestAt = oldest?.t ?? null;
      const n = await prisma.$queryRaw<Array<{ n: bigint | number }>>`SELECT reltuples::bigint AS n FROM pg_class WHERE relname = 'TradeTape'`.catch(() => []);
      this.rowsOnDisk = n[0] ? Math.max(0, Number(n[0].n)) : null;
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'tape prune failed');
    }
  }

  snapshot(now = Date.now()): TapeStats {
    const c = this.cfg();
    return {
      enabled: c.enabled,
      perMin: Math.floor(now / 60_000) === this.minuteStart ? this.lastMinute : 0,
      buffered: this.buf.length,
      written: this.written,
      dropped: this.dropped,
      failed: this.failed,
      oldestAt: this.oldestAt?.toISOString() ?? null,
      daysOnDisk: this.oldestAt ? Math.round(((now - this.oldestAt.getTime()) / 86_400_000) * 10) / 10 : null,
      rowsOnDisk: this.rowsOnDisk,
    };
  }
}
