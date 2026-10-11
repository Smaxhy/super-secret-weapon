/**
 * Tape archiver — keeps the real trade-by-trade price path of every token we
 * looked at seriously, so strategies can be backtested on what actually
 * happened instead of on 7 coarse snapshots.
 *
 * Redis only holds the last 600 trades per token, so we copy the tape into
 * Postgres at the 5m, 15m and 1h snapshots and merge (de-duplicated) each
 * time. Only tokens that scored ≥ `storeAboveScore` at some checkpoint, or
 * that we traded, are archived — those are the ones whose paths teach us
 * anything about entries and exits.
 */
import { getConfig } from '../config/runtime-config';
import { moduleLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import type { LiveTokenView, TapeTrade } from '../scanner/live-state';
import type { ObservationSnapshot, SnapshotInterval } from '../config/types';

const log = moduleLogger('tape-archiver');
const ARCHIVE_AT: ReadonlySet<SnapshotInterval> = new Set(['M5', 'M15', 'H1']);

/** [tsMs, side(1=buy), solAmount, priceSol, walletIdx] */
export type TapeRow = [number, 0 | 1, number, number, number];

export function encodeTape(trades: TapeTrade[], wallets: string[] = []): { rows: TapeRow[]; wallets: string[] } {
  const idx = new Map(wallets.map((w, i) => [w, i]));
  const rows: TapeRow[] = trades.map((t) => {
    let i = idx.get(t.user);
    if (i === undefined) {
      i = wallets.length;
      wallets.push(t.user);
      idx.set(t.user, i);
    }
    return [t.tsMs, t.isBuy ? 1 : 0, +t.solAmount.toFixed(6), t.priceSol, i];
  });
  return { rows, wallets };
}

export function decodeTape(rows: TapeRow[], wallets: string[]): TapeTrade[] {
  return rows.map(([tsMs, side, solAmount, priceSol, w]) => ({ tsMs, isBuy: side === 1, solAmount, priceSol, user: wallets[w] ?? `w${w}` }));
}

/** Merge two tapes, dropping duplicates (same time, side, size and wallet). */
export function mergeTapes(a: TapeTrade[], b: TapeTrade[]): TapeTrade[] {
  const seen = new Set<string>();
  const out: TapeTrade[] = [];
  for (const t of [...a, ...b]) {
    const k = `${t.tsMs}|${t.isBuy ? 1 : 0}|${t.solAmount.toFixed(6)}|${t.user}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out.sort((x, y) => x.tsMs - y.tsMs);
}

export class TapeArchiver {
  archived = 0;

  onSnapshot = async (view: LiveTokenView, snap: ObservationSnapshot): Promise<void> => {
    if (!ARCHIVE_AT.has(snap.interval) || view.tape.length === 0) return;
    const token = await prisma.token.findUnique({ where: { mint: view.mint }, select: { combinedScore: true, positions: { select: { id: true }, take: 1 } } });
    if (!token) return;
    const interesting = (token.combinedScore ?? 0) >= getConfig().scoring.storeAboveScore || token.positions.length > 0;
    if (!interesting) return;

    const existing = await prisma.tokenTape.findUnique({ where: { mint: view.mint } });
    const previous = existing ? decodeTape(existing.tape as TapeRow[], existing.wallets as string[]) : [];
    const merged = mergeTapes(previous, view.tape);
    const { rows, wallets } = encodeTape(merged);
    const data = {
      startMs: BigInt(merged[0]!.tsMs),
      trades: merged.length,
      tape: rows as unknown as object,
      wallets: wallets as unknown as object,
      athPriceSol: Math.max(view.athPriceSol, existing?.athPriceSol ?? 0),
      complete: view.complete,
    };
    await prisma.tokenTape.upsert({ where: { mint: view.mint }, update: data, create: { mint: view.mint, ...data } });
    this.archived++;
    log.debug({ mint: view.mint, interval: snap.interval, trades: merged.length }, 'tape archived');
  };
}
