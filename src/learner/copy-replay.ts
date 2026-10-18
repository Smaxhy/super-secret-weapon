/**
 * Copy replay (v11.18, owner: "do anything to make it profitable"): the Money tab showed no KIND of coin pays — so test
 * the other axis: WHO is buying. Walks the recorded tape (TradeTape, every trade with its wallet) forward in time and
 * keeps every wallet's realised record (cost basis per coin, like wallet-pnl). The moment a wallet's record so far
 * qualifies as a winner (`qualify`: ≥ minSells sells, win rate, profit factor, realised SOL, not a repeat-size bot) its
 * NEXT buys are copied: we buy right after it at the pool price it left (+ slippage + fees, `sizeSol` each), sell the
 * same share when it sells (mirror, one trade later), or at the hard stop / max hold / tape end. Qualification uses only
 * trades BEFORE the copy, so every copy result is out of sample — no peeking.
 *
 * Also copies the owner's TRACKED wallets (KOL / COPY rows) from the first trade, as a separate kind, so "are my picks
 * worth copying?" gets the same honest answer. Per wallet the report splits its copy results into first / second half
 * (`consistent` = both halves positive) so a wallet isn't trusted on one lucky coin.
 *
 *   npm run copy-replay -- --from 2026-10-14 --to 2026-10-19 [--size 0.5]       (VPS: docker compose exec bot node dist/learner/copy-replay.js …)
 *   GET /api/copy-replay · POST /api/copy-replay/run  → Performance → Money card "Who's actually making money"
 */
import { prisma } from '../lib/prisma';
import { redis, closeRedis } from '../lib/redis';
import type { TapeRow } from './replay';

export const COPYREP_LAST = 'copyrep:last';
export const COPYREP_IDS = 'copyrep:ids';
export const copyRepKey = (id: string) => `copyrep:res:${id}`;

export interface CopyReplayConfig {
  /** Our size per copied buy, SOL. */
  sizeSol: number;
  /** A wallet qualifies as a winner when its record SO FAR has … */
  minSells: number;
  minWinRate: number;
  minPf: number;
  minRealizedSol: number;
  /** … and ≤ this share of repeat-size buys (bots), judged from `botMinBuys` buys on. */
  maxRepeatSharePct: number;
  botMinBuys: number;
  /** Ignore trades under this (dust / bot pings). */
  minTradeSol: number;
  /** Only copy buys at least this big (a winner's 0.01 SOL probe isn't a signal). */
  minCopyBuySol: number;
  /** Buys within this many seconds of the coin's first trade are sniper buys: not learnable, not copied. */
  sniperSec: number;
  maxOpenPerWallet: number;
  maxOpenTotal: number;
  hardStopPct: number;
  maxHoldMin: number;
  /** Costs (paper): pool fee each way, slippage each way, tx fees. */
  feePct: number;
  slippagePct: number;
  buyTxSol: number;
  sellTxSol: number;
  /** Wallet records kept in memory (LRU by last trade); per-coin positions older than this are forgotten. */
  maxWallets: number;
  positionTtlMin: number;
}

export const DEFAULT_COPY_CFG: CopyReplayConfig = {
  sizeSol: 0.5,
  minSells: 6,
  minWinRate: 0.55,
  minPf: 1.3,
  minRealizedSol: 0.5,
  maxRepeatSharePct: 60,
  botMinBuys: 10,
  minTradeSol: 0.02,
  minCopyBuySol: 0.1,
  sniperSec: 15,
  maxOpenPerWallet: 3,
  maxOpenTotal: 60,
  hardStopPct: 35,
  maxHoldMin: 360,
  feePct: 1.25,
  slippagePct: 0.8,
  buyTxSol: 0.0011,
  sellTxSol: 0.006,
  maxWallets: 300_000,
  positionTtlMin: 24 * 60,
};

/** One wallet's record so far (walk-forward). */
export interface WalletStat {
  sells: number;
  wins: number;
  grossWin: number;
  grossLoss: number;
  realized: number;
  buys: number;
  /** Repeat-size buys (same size as an earlier buy of this wallet, 3 decimals). */
  repeats: number;
  sizes: Map<string, number>;
  lastT: number;
  qualifiedAt: number | null;
  /** Open cost basis per coin. */
  pos: Map<string, { cost: number; tok: number; t: number }>;
}

export interface CopyTrade {
  wallet: string;
  kind: 'proven' | 'tracked';
  mint: string;
  openT: number;
  closeT: number;
  /** % of what we paid, after every cost. */
  pnlPct: number;
  pnlSol: number;
  peakX: number;
  holdSec: number;
  reason: string;
}

export interface WalletReport {
  wallet: string;
  kind: 'proven' | 'tracked';
  label: string | null;
  qualifiedAt: number | null;
  n: number;
  winPct: number;
  avgPct: number;
  medianPct: number;
  totalSol: number;
  profitFactor: number | null;
  medianHoldMin: number;
  firstHalfSol: number;
  secondHalfSol: number;
  consistent: boolean;
  /** Its own record at the end (realised SOL, win rate) — what it made for itself. */
  own: { sells: number; winRate: number; realized: number } | null;
}

export interface Agg { n: number; winPct: number; avgPct: number; medianPct: number; totalSol: number; profitFactor: number | null }

export interface CopyReport {
  id: string;
  from: string;
  to: string;
  rows: number;
  wallets: number;
  qualified: number;
  sizeSol: number;
  overall: Agg;
  byKind: Array<Agg & { kind: 'proven' | 'tracked'; wallets: number }>;
  byExit: Array<{ reason: string; n: number; totalSol: number; avgPct: number }>;
  /** Cumulative SOL by UTC day (the curve). */
  byDay: Array<{ day: string; n: number; sol: number; cumSol: number }>;
  wallets_: WalletReport[];
  copyable: WalletReport[];
  verdict: string;
  durationMs: number;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function agg(xs: readonly CopyTrade[]): Agg {
  const p = xs.map((t) => t.pnlPct).sort((a, b) => a - b);
  const n = p.length;
  const gw = xs.reduce((a, t) => a + Math.max(0, t.pnlSol), 0);
  const gl = xs.reduce((a, t) => a + Math.max(0, -t.pnlSol), 0);
  return {
    n,
    winPct: n ? Math.round((p.filter((x) => x > 0).length / n) * 100) : 0,
    avgPct: r1(n ? p.reduce((a, b) => a + b, 0) / n : 0),
    medianPct: r1(n ? p[Math.floor(n / 2)]! : 0),
    totalSol: r3(xs.reduce((a, t) => a + t.pnlSol, 0)),
    profitFactor: gl > 0 ? r2(gw / gl) : gw > 0 ? null : 0,
  };
}

/** Pure: does this record (so far) qualify as a winner worth copying? */
export function qualify(s: Pick<WalletStat, 'sells' | 'wins' | 'grossWin' | 'grossLoss' | 'realized' | 'buys' | 'repeats'>, c: CopyReplayConfig): boolean {
  if (s.sells < c.minSells) return false;
  if (s.wins / s.sells < c.minWinRate) return false;
  const pf = s.grossLoss > 0 ? s.grossWin / s.grossLoss : s.grossWin > 0 ? Infinity : 0;
  if (pf < c.minPf) return false;
  if (s.realized < c.minRealizedSol) return false;
  if (s.buys >= c.botMinBuys && (s.repeats / s.buys) * 100 > c.maxRepeatSharePct) return false;
  return true;
}

interface OpenCopy {
  wallet: string;
  kind: 'proven' | 'tracked';
  mint: string;
  openT: number;
  /** Tokens we hold and what they cost (SOL, incl. fees). */
  tok: number;
  cost: number;
  /** Share of the position still open (1 → 0). */
  left: number;
  /** SOL banked so far from partial mirror sells. */
  banked: number;
  peak: number;
  entryPx: number;
}

export class CopyReplay {
  readonly stats = new Map<string, WalletStat>();
  private readonly coinFirstT = new Map<string, number>();
  private readonly lastPx = new Map<string, number>();
  /** Open copies by mint → list (checked on every trade of that coin). */
  private readonly open = new Map<string, OpenCopy[]>();
  private openCount = 0;
  readonly trades: CopyTrade[] = [];
  rows = 0;
  private lastT = 0;
  private lastSweep = 0;

  constructor(
    private readonly cfg: CopyReplayConfig = DEFAULT_COPY_CFG,
    /** Owner's tracked wallets (address → label): copied from their first buy, kind 'tracked'. */
    private readonly tracked: ReadonlyMap<string, string | null> = new Map(),
  ) {}

  private stat(w: string, t: number): WalletStat {
    let s = this.stats.get(w);
    if (s) {
      // LRU: re-insert so the oldest stays first
      this.stats.delete(w);
    } else {
      s = { sells: 0, wins: 0, grossWin: 0, grossLoss: 0, realized: 0, buys: 0, repeats: 0, sizes: new Map(), lastT: t, qualifiedAt: null, pos: new Map() };
      if (this.stats.size >= this.cfg.maxWallets) {
        const oldest = this.stats.keys().next().value;
        if (oldest !== undefined) this.stats.delete(oldest);
      }
    }
    s.lastT = t;
    this.stats.set(w, s);
    return s;
  }

  feed(rows: readonly TapeRow[]): void {
    const c = this.cfg;
    for (const r of rows) {
      this.rows++;
      this.lastT = r.t;
      const px = r.pp && r.pp > 0 ? r.pp : r.px;
      if (!(px > 0)) continue;
      if (!this.coinFirstT.has(r.mint)) this.coinFirstT.set(r.mint, r.t);
      this.lastPx.set(r.mint, px);
      // 1. open copies in this coin: stop / max hold on every trade
      const opens = this.open.get(r.mint);
      if (opens?.length) this.mark(r.mint, px, r.t, opens);
      if (r.sol < c.minTradeSol) continue;
      const sniper = r.t - (this.coinFirstT.get(r.mint) ?? r.t) < c.sniperSec * 1000;
      const s = this.stat(r.w, r.t);
      if (r.buy) {
        s.buys++;
        const key = r.sol.toFixed(3);
        const seen = s.sizes.get(key) ?? 0;
        if (seen > 0) s.repeats++;
        if (s.sizes.size < 50 || seen) s.sizes.set(key, seen + 1);
        if (!sniper && r.tok > 0) {
          const p = s.pos.get(r.mint);
          if (p) {
            p.cost += r.sol;
            p.tok += r.tok;
          } else s.pos.set(r.mint, { cost: r.sol, tok: r.tok, t: r.t });
        }
        // 2. copy the buy? (qualified winner, or a tracked wallet)
        const trackedW = this.tracked.has(r.w);
        if (!sniper && r.sol >= c.minCopyBuySol && (trackedW || s.qualifiedAt !== null)) this.openCopy(r, px, trackedW ? 'tracked' : 'proven');
        if (!trackedW && s.qualifiedAt === null && qualify(s, c)) s.qualifiedAt = r.t;
      } else {
        // sell: realise against the cost basis
        const p = s.pos.get(r.mint);
        if (p && p.tok > 0 && r.tok > 0) {
          const share = Math.min(1, r.tok / p.tok);
          const cost = p.cost * share;
          const pnl = r.sol - cost;
          s.sells++;
          if (pnl > 0) {
            s.wins++;
            s.grossWin += pnl;
          } else s.grossLoss += -pnl;
          s.realized += pnl;
          p.cost -= cost;
          p.tok -= r.tok;
          if (p.tok <= 1e-9 || share >= 0.999) s.pos.delete(r.mint);
          if (s.qualifiedAt === null && !this.tracked.has(r.w) && qualify(s, c)) s.qualifiedAt = r.t;
          // 3. mirror: we sell the same share of our copy
          const ours = this.open.get(r.mint)?.filter((o) => o.wallet === r.w);
          if (ours?.length) for (const o of ours) this.mirror(o, share, px, r.t);
        }
      }
      if (r.t - this.lastSweep > 10 * 60_000) this.sweep(r.t);
    }
  }

  private openCopy(r: TapeRow, px: number, kind: 'proven' | 'tracked'): void {
    const c = this.cfg;
    const list = this.open.get(r.mint) ?? [];
    if (list.some((o) => o.wallet === r.w)) return;
    if (this.openCount >= c.maxOpenTotal) return;
    let mine = 0;
    for (const l of this.open.values()) for (const o of l) if (o.wallet === r.w) mine++;
    if (mine >= c.maxOpenPerWallet) return;
    const entryPx = px * (1 + c.slippagePct / 100);
    const spend = c.sizeSol;
    const tok = (spend * (1 - c.feePct / 100) - c.buyTxSol) / entryPx;
    list.push({ wallet: r.w, kind, mint: r.mint, openT: r.t, tok, cost: spend, left: 1, banked: 0, peak: px, entryPx });
    this.open.set(r.mint, list);
    this.openCount++;
  }

  /** SOL we get for `share` of our tokens at pool price `px`. */
  private proceeds(o: OpenCopy, share: number, px: number): number {
    const c = this.cfg;
    const gross = o.tok * share * px * (1 - c.slippagePct / 100) * (1 - c.feePct / 100);
    return Math.max(0, gross - c.sellTxSol);
  }

  private mirror(o: OpenCopy, share: number, px: number, t: number): void {
    const sell = Math.min(o.left, share >= 0.9 ? o.left : o.left * share);
    o.banked += this.proceeds(o, sell, px);
    o.left -= sell;
    if (o.left <= 0.1) {
      o.banked += o.left > 0 ? this.proceeds(o, o.left, px) : 0;
      o.left = 0;
      this.close(o, t, px, 'mirror sell');
    }
  }

  private mark(mint: string, px: number, t: number, opens: OpenCopy[]): void {
    const c = this.cfg;
    for (const o of [...opens]) {
      if (px > o.peak) o.peak = px;
      const x = px / o.entryPx;
      if (x <= 1 - c.hardStopPct / 100) this.closeAll(o, t, px, 'hard stop');
      else if (t - o.openT >= c.maxHoldMin * 60_000) this.closeAll(o, t, px, 'max hold');
    }
    if (!this.open.get(mint)?.length) this.open.delete(mint);
  }

  private closeAll(o: OpenCopy, t: number, px: number, reason: string): void {
    if (o.left > 0) o.banked += this.proceeds(o, o.left, px);
    o.left = 0;
    this.close(o, t, px, reason);
  }

  private close(o: OpenCopy, t: number, _px: number, reason: string): void {
    const list = this.open.get(o.mint);
    if (list) {
      const i = list.indexOf(o);
      if (i >= 0) list.splice(i, 1);
      if (!list.length) this.open.delete(o.mint);
    }
    this.openCount--;
    const pnlSol = o.banked - o.cost;
    this.trades.push({ wallet: o.wallet, kind: o.kind, mint: o.mint, openT: o.openT, closeT: t, pnlPct: r1((pnlSol / o.cost) * 100), pnlSol: r3(pnlSol), peakX: r2(o.peak / o.entryPx), holdSec: Math.round((t - o.openT) / 1000), reason });
  }

  /** Forget stale per-coin cost bases (memory). */
  private sweep(now: number): void {
    this.lastSweep = now;
    const ttl = this.cfg.positionTtlMin * 60_000;
    for (const s of this.stats.values()) {
      if (!s.pos.size) continue;
      for (const [m, p] of s.pos) if (now - p.t > ttl) s.pos.delete(m);
    }
  }

  finish(id: string, from: number, to: number, startedAt: number): CopyReport {
    // close what's still open at the last known price
    for (const list of [...this.open.values()]) for (const o of [...list]) this.closeAll(o, this.lastT, this.lastPx.get(o.mint) ?? o.entryPx, 'tape ended');
    const ts = this.trades;
    const byWallet = new Map<string, CopyTrade[]>();
    for (const t of ts) byWallet.set(t.wallet, [...(byWallet.get(t.wallet) ?? []), t]);
    const wallets: WalletReport[] = [...byWallet].map(([w, xs]) => {
      const a = agg(xs);
      const half = Math.floor(xs.length / 2);
      const first = r3(xs.slice(0, half).reduce((s, t) => s + t.pnlSol, 0));
      const second = r3(xs.slice(half).reduce((s, t) => s + t.pnlSol, 0));
      const holds = xs.map((t) => t.holdSec).sort((x, y) => x - y);
      const st = this.stats.get(w);
      return {
        wallet: w,
        kind: xs[0]!.kind,
        label: this.tracked.get(w) ?? null,
        qualifiedAt: st?.qualifiedAt ?? null,
        ...a,
        medianHoldMin: r1((holds[Math.floor(holds.length / 2)] ?? 0) / 60),
        firstHalfSol: first,
        secondHalfSol: second,
        consistent: xs.length >= 6 && first > 0 && second > 0,
        own: st ? { sells: st.sells, winRate: st.sells ? r2(st.wins / st.sells) : 0, realized: r2(st.realized) } : null,
      };
    });
    wallets.sort((a, b) => b.totalSol - a.totalSol);
    const copyable = wallets.filter((w) => w.n >= 5 && w.avgPct > 0 && (w.profitFactor === null || w.profitFactor >= 1.3) && w.consistent);
    const kinds: Array<'proven' | 'tracked'> = ['proven', 'tracked'];
    const byKind = kinds.map((k) => ({ kind: k, wallets: wallets.filter((w) => w.kind === k).length, ...agg(ts.filter((t) => t.kind === k)) })).filter((k) => k.n > 0);
    const exits = new Map<string, CopyTrade[]>();
    for (const t of ts) exits.set(t.reason, [...(exits.get(t.reason) ?? []), t]);
    const byExit = [...exits].map(([reason, xs]) => ({ reason, n: xs.length, totalSol: r3(xs.reduce((a, t) => a + t.pnlSol, 0)), avgPct: r1(xs.reduce((a, t) => a + t.pnlPct, 0) / xs.length) })).sort((a, b) => b.n - a.n);
    const days = new Map<string, { n: number; sol: number }>();
    for (const t of [...ts].sort((a, b) => a.closeT - b.closeT)) {
      const d = new Date(t.closeT).toISOString().slice(0, 10);
      const x = days.get(d) ?? { n: 0, sol: 0 };
      x.n++;
      x.sol += t.pnlSol;
      days.set(d, x);
    }
    let cum = 0;
    const byDay = [...days].map(([day, x]) => { cum += x.sol; return { day, n: x.n, sol: r3(x.sol), cumSol: r3(cum) }; });
    const overall = agg(ts);
    const qualified = [...this.stats.values()].filter((s) => s.qualifiedAt !== null).length;
    const proven = byKind.find((k) => k.kind === 'proven');
    const verdict = !ts.length
      ? 'No wallet qualified as a winner on this tape — nothing to copy yet.'
      : copyable.length
        ? `${copyable.length} wallet${copyable.length === 1 ? '' : 's'} paid to copy in BOTH halves of their copies (${r2(copyable.reduce((a, w) => a + w.totalSol, 0))} SOL together at ${this.cfg.sizeSol} SOL a trade). Copying every qualified winner blindly made ${proven ? `${proven.totalSol >= 0 ? '+' : ''}${proven.totalSol} SOL over ${proven.n} copies` : 'nothing'}.`
        : `Copying winners did not pay here: ${overall.n} copies, ${overall.winPct}% won, ${overall.totalSol >= 0 ? '+' : ''}${overall.totalSol} SOL. Winners' edge is in being FIRST — by the time we buy after them the move is priced in, or they sell into us.`;
    return {
      id,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      rows: this.rows,
      wallets: this.stats.size,
      qualified,
      sizeSol: this.cfg.sizeSol,
      overall,
      byKind,
      byExit,
      byDay,
      wallets_: wallets.slice(0, 40),
      copyable,
      verdict,
      durationMs: Date.now() - startedAt,
    };
  }
}

const SLICE_MS = 5 * 60_000;

/** Stream the tape through the engine (the CLI / child process). */
export async function runCopyReplay(a: { from: number; to: number; id: string; sizeSol?: number }, onProgress?: (m: string) => void): Promise<CopyReport> {
  const t0 = Date.now();
  const cfg = { ...DEFAULT_COPY_CFG, ...(a.sizeSol ? { sizeSol: a.sizeSol } : {}) };
  const tracked = new Map<string, string | null>();
  for (const w of await prisma.trackedWallet.findMany({ where: { active: true }, select: { address: true, label: true } }).catch(() => [])) tracked.set(w.address, w.label);
  const engine = new CopyReplay(cfg, tracked);
  let slices = 0;
  for (let s = a.from; s < a.to; s += SLICE_MS) {
    const e = Math.min(a.to, s + SLICE_MS);
    const rows = await prisma.tradeTape.findMany({ where: { t: { gte: new Date(s), lt: new Date(e) } }, orderBy: [{ t: 'asc' }, { id: 'asc' }], select: { mint: true, t: true, wallet: true, buy: true, sol: true, tokens: true, px: true, pp: true, amm: true, curvePct: true } });
    engine.feed(rows.map((r) => ({ mint: r.mint, t: r.t.getTime(), w: r.wallet, buy: r.buy, sol: r.sol, tok: r.tokens ?? 0, px: r.px, ...(r.pp ? { pp: r.pp } : {}), amm: r.amm, curvePct: r.curvePct })));
    slices++;
    if (slices % 12 === 0) onProgress?.(`${new Date(e).toISOString().slice(0, 16)} — ${engine.trades.length} copies so far, ${[...engine.stats.values()].filter((x) => x.qualifiedAt !== null).length} winners found`);
    await new Promise((r) => setImmediate(r));
  }
  const report = engine.finish(a.id, a.from, a.to, t0);
  await redis.set(copyRepKey(report.id), JSON.stringify(report), 'EX', 30 * 86_400).catch(() => undefined);
  await redis.set(COPYREP_LAST, JSON.stringify(report)).catch(() => undefined);
  await redis.lpush(COPYREP_IDS, report.id).catch(() => undefined);
  await redis.ltrim(COPYREP_IDS, 0, 19).catch(() => undefined);
  return report;
}

export function formatCopyReport(r: CopyReport): string {
  const sign = (x: number) => `${x >= 0 ? '+' : ''}${x}`;
  const out = [`Copy replay ${r.from.slice(0, 16)} → ${r.to.slice(0, 16)}: ${r.rows.toLocaleString()} trades, ${r.wallets.toLocaleString()} wallets, ${r.qualified} qualified winners, ${(r.durationMs / 1000).toFixed(0)} s`];
  out.push(`  ${r.overall.n} copies · ${r.overall.winPct}% wins · ${sign(r.overall.totalSol)} SOL at ${r.sizeSol} SOL each · avg ${sign(r.overall.avgPct)}% · median ${sign(r.overall.medianPct)}% · PF ${r.overall.profitFactor ?? '—'}`);
  for (const k of r.byKind) out.push(`  ${k.kind.padEnd(8)} wallets ${String(k.wallets).padStart(4)}  n=${String(k.n).padStart(5)}  wins ${String(k.winPct).padStart(3)}%  ${sign(k.totalSol).padStart(9)} SOL  avg ${sign(k.avgPct)}%`);
  for (const e of r.byExit) out.push(`  exit ${e.reason.padEnd(12)} n=${String(e.n).padStart(5)}  ${sign(e.totalSol).padStart(9)} SOL  avg ${sign(e.avgPct)}%`);
  for (const w of r.wallets_.slice(0, 15)) out.push(`  ${w.wallet.slice(0, 8)}… ${w.kind.padEnd(7)} n=${String(w.n).padStart(3)} wins ${String(w.winPct).padStart(3)}% ${sign(w.totalSol).padStart(8)} SOL  halves ${sign(w.firstHalfSol)} / ${sign(w.secondHalfSol)}${w.consistent ? '  ✓' : ''}`);
  out.push(`  ${r.verdict}`);
  return out.join('\n');
}

function parseArgs(argv: string[]): { from: number; to: number; id: string; sizeSol?: number } {
  const get = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
  const now = Date.now();
  const day = (s: string | undefined, def: number) => { if (!s) return def; const d = Date.parse(s); return Number.isFinite(d) ? d : def; };
  const to = day(get('to'), now);
  const from = day(get('from'), to - 5 * 86_400_000);
  const size = Number(get('size'));
  return { from, to, id: get('id') ?? `${new Date(now).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`, ...(Number.isFinite(size) && size > 0 ? { sizeSol: size } : {}) };
}

if (require.main === module) {
  const a = parseArgs(process.argv.slice(2));
  runCopyReplay(a, (m) => console.log(`  … ${m}`))
    .then((r) => console.log(formatCopyReport(r)))
    .catch((e: Error) => { console.error(e.message); process.exitCode = 1; })
    .finally(async () => { await prisma.$disconnect().catch(() => undefined); await closeRedis(); });
}
