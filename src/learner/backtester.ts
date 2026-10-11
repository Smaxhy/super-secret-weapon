/**
 * Backtester (from the owner's "big update", Oct 11, rebuilt on the current bot): replays the REAL trade tape of every
 * archived paper trade (tape-archiver.ts) through the bot's own exit engine (VirtualBook → decideExit, same costs as
 * paper fills) — once with the live exit settings and once per exit-lab variant — and compares them with what the
 * trade really made. Same entries, different exits: "would other exit settings have done better on these exact
 * price paths?". Free (no AI, no RPC): reads Postgres only.
 *
 * Approximations: holder / dev / bundle rug signals and KOL / risk inputs aren't on the tape (neutral in the replay);
 * the entry is the tape price at the moment of the real buy.
 */
import type { StrategyName } from '../config/types';
import { getConfig } from '../config/runtime-config';
import { prisma } from '../lib/prisma';
import type { CrowdTrade } from '../scanner/crowd-tracker';
import { variantRules, type LabVariant } from './strategy-lab';
import { decodeTape, type TapeRow } from './tape-archiver';
import { VirtualBook, type VirtualResult } from './virtual-book';

export interface BacktestTrade {
  id: string;
  mint: string;
  symbol: string;
  strategy: StrategyName;
  openedAtMs: number;
  onAmm: boolean;
  actualPnlPct: number;
}

export interface VariantSummary {
  id: string;
  name: string;
  ownerOnly: boolean;
  n: number;
  avgPnlPct: number;
  medianPnlPct: number;
  winRatePct: number;
  /** Average vs the real trades (same entries). */
  vsActualPct: number;
}

export interface BacktestReport {
  at: string;
  days: number;
  trades: number;
  tapes: number;
  actual: { avgPnlPct: number; winRatePct: number } | null;
  variants: VariantSummary[];
  note: string;
}

const r1 = (x: number) => Math.round(x * 10) / 10;

/** Pure-ish: replay one coin's tape for the given trades × variants. Returns results keyed `${tradeId}:${variantId}`. */
export function replayTape(mint: string, tape: readonly CrowdTrade[], trades: readonly BacktestTrade[], variants: ReadonlyArray<Pick<LabVariant, 'id' | 'exit' | 'ownerOnly'>>): Map<string, VirtualResult> {
  const out = new Map<string, VirtualResult>();
  if (!tape.length || !trades.length) return out;
  // Trades seen so far (grows as the replay moves on — no copying).
  const visible: CrowdTrade[] = [];
  const crowd = { trades: () => visible };
  const book = new VirtualBook(
    crowd as never,
    (tag, live) => {
      const v = variants.find((x) => x.id === tag.variant);
      return v ? (v.id === 'L' ? live : variantRules(live, v)) : null;
    },
    (r) => out.set(r.key, r),
    () => 10_000,
  );
  const pending = [...trades].sort((a, b) => a.openedAtMs - b.openedAtMs);
  let lastStep = tape[0]!.t;
  for (let i = 0; i < tape.length; i++) {
    const t = tape[i]!;
    // Quiet stretches: step every second so time stops / stale exits fire on time.
    if (book.size) for (let s = lastStep + 1_000; s < t.t; s += 1_000) book.stepAll(s);
    lastStep = t.t;
    visible.push(t);
    while (pending.length && pending[0]!.openedAtMs <= t.t) {
      const p = pending.shift()!;
      const price = t.pp && t.pp > 0 ? t.pp : t.px;
      for (const v of variants) book.add({ key: `${p.id}:${v.id}`, mint: p.mint, symbol: p.symbol, strategy: p.strategy, onAmm: p.onAmm, priceSol: price, tag: { variant: v.id } }, t.t);
    }
    book.onTrade(mint, t.t);
    book.stepAll(t.t);
  }
  book.closeAll('tape ended', lastStep + 1_000);
  return out;
}

export function summarize(trades: readonly BacktestTrade[], results: Map<string, VirtualResult>, variants: ReadonlyArray<Pick<LabVariant, 'id' | 'name' | 'ownerOnly'>>): VariantSummary[] {
  return variants.map((v) => {
    const pairs = trades.flatMap((t) => {
      const r = results.get(`${t.id}:${v.id}`);
      return r ? [{ sim: r.pnlPct, real: t.actualPnlPct }] : [];
    });
    const xs = pairs.map((p) => p.sim).sort((a, b) => a - b);
    const avg = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
    const real = pairs.length ? pairs.reduce((a, p) => a + p.real, 0) / pairs.length : 0;
    return {
      id: v.id,
      name: v.name,
      ownerOnly: !!v.ownerOnly,
      n: xs.length,
      avgPnlPct: r1(avg),
      medianPnlPct: r1(xs.length ? xs[Math.floor(xs.length / 2)]! : 0),
      winRatePct: xs.length ? Math.round((xs.filter((x) => x > 0).length / xs.length) * 100) : 0,
      vsActualPct: r1(avg - real),
    };
  });
}

/** Replay the archived paper trades of the last `days` days with the live exits + every exit-lab variant. */
export async function runBacktest(days = 7, now = Date.now()): Promise<BacktestReport> {
  const since = new Date(now - days * 86_400_000);
  const ps = await prisma.position.findMany({
    where: { mode: 'PAPER', status: 'CLOSED', openedAt: { gte: since } },
    select: { id: true, mint: true, strategy: true, openedAt: true, sizeSol: true, realizedPnlSol: true, token: { select: { symbol: true, completedAt: true } } },
    orderBy: { openedAt: 'asc' },
    take: 2_000,
  });
  const lab = getConfig().lab;
  const variants: Array<Pick<LabVariant, 'id' | 'name' | 'exit' | 'ownerOnly'>> = [{ id: 'L', name: 'Live exit settings', exit: {} }, ...((lab?.variants ?? []) as LabVariant[]).filter((v) => v.id !== 'L')];
  const byMint = new Map<string, BacktestTrade[]>();
  for (const p of ps) {
    if (!(p.sizeSol > 0)) continue;
    const t: BacktestTrade = {
      id: p.id,
      mint: p.mint,
      symbol: p.token?.symbol ?? '',
      strategy: p.strategy as StrategyName,
      openedAtMs: p.openedAt.getTime(),
      onAmm: p.strategy === 'MIGRATION_MOMENTUM' || p.strategy === 'SWING' || (!!p.token?.completedAt && p.token.completedAt <= p.openedAt),
      actualPnlPct: (p.realizedPnlSol / p.sizeSol) * 100,
    };
    byMint.set(p.mint, [...(byMint.get(p.mint) ?? []), t]);
  }
  const all: BacktestTrade[] = [];
  const results = new Map<string, VirtualResult>();
  let tapes = 0;
  for (const [mint, trades] of byMint) {
    const row = await prisma.tokenTape.findUnique({ where: { mint } });
    if (!row) continue;
    const tape = decodeTape(row.tape as TapeRow[], row.wallets as string[]);
    // Only trades the tape actually covers.
    const covered = trades.filter((t) => tape.length && t.openedAtMs >= tape[0]!.t && t.openedAtMs <= tape[tape.length - 1]!.t);
    if (!covered.length) continue;
    tapes++;
    for (const [k, v] of replayTape(mint, tape, covered, variants)) results.set(k, v);
    all.push(...covered);
    await new Promise((r) => setImmediate(r));
  }
  const actual = all.length ? { avgPnlPct: r1(all.reduce((a, t) => a + t.actualPnlPct, 0) / all.length), winRatePct: Math.round((all.filter((t) => t.actualPnlPct > 0).length / all.length) * 100) } : null;
  return {
    at: new Date(now).toISOString(),
    days,
    trades: all.length,
    tapes,
    actual,
    variants: summarize(all, results, variants),
    note: all.length < 30 ? 'fewer than 30 replayed trades — treat as a hint, not proof' : 'same entries, different exits, replayed on the real trade tapes',
  };
}
