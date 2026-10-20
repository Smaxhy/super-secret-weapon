/**
 * v24 shadow book (owner: "there have been enough solid signals that it could have made money on, firing setups but not
 * executing; you didn't add a shadow trade feature on forex"): every signal of a chosen strategy that the bot account
 * did NOT take — the 2-checks rule, no winning record on the market, the judge, cooling off, caps, news, a stale feed,
 * the currency cap… — is written down with the lab's entry / stop / target and the reason. The lab trades the same
 * signal on paper with the same engine, so when that lab trade finishes the shadow gets its R. The summary says, per
 * hold-back reason, what the held-back trades would have made. Pure apart from the Redis list the lab keeps.
 */
import { classify, type ReasonKind } from './why';
import type { LabOpenTrade, SyncReport } from './practice';
import type { Trade } from './types';

export const SHADOW = {
  /** rows kept (newest first) */
  max: 1500,
  /** a shadow older than this with no result is dropped (the lab trade it mirrors is long gone) */
  keepDays: 45,
} as const;

export interface ShadowTrade {
  /** strategy:tf:pair:keyT — the lab trade's identity */
  key: string;
  strategy: string;
  tf: string;
  pair: string;
  side: 1 | -1;
  entry: number;
  stop: number;
  target: number | null;
  /** the lab trade's entry time */
  t: number;
  /** when the bot refused it */
  at: number;
  why: string;
  kind: ReasonKind;
  /** 'wait' = skipped only for now (it may still be taken while fresh), 'skip' = refused */
  mode: 'wait' | 'skip';
  /** the lab's result once that trade finished (same engine, same costs) */
  r?: number | null;
  exitT?: number | null;
  reason?: string | null;
}

/** a lab trade's identity = the bot's position ref: strategy:tf:pair:keyT (lab.ts `tradeKey`) */
const keyOf = (t: { strategy: string; tf: string; pair: string; entryT: number; keyT?: number }) => `${t.strategy}:${t.tf}:${t.pair}:${t.keyT ?? t.entryT}`;

/**
 * Add this sync's refusals to the book (one row per lab trade; a later refusal of the same trade only updates the
 * reason while it has no result). A trade the bot holds after all (`held`, by lab ref) is not a shadow. Pure.
 */
export function recordShadows(book: readonly ShadowTrade[], rep: SyncReport, labOpen: readonly LabOpenTrade[], held: ReadonlySet<string>, now = Date.now()): ShadowTrade[] {
  const byRef = new Map(labOpen.map((t) => [`${t.strategy}:${t.tf ?? ''}:${t.pair}`, t]));
  const out = book.map((s) => ({ ...s }));
  const idx = new Map(out.map((s, i) => [s.key, i]));
  const add = (x: SyncReport['skipped'][number], mode: 'wait' | 'skip') => {
    const t = byRef.get(`${x.strategy}:${x.tf}:${x.pair}`);
    if (!t || held.has(t.ref) || !Number.isFinite(t.entry ?? NaN)) return;
    const key = t.ref;
    const i = idx.get(key);
    if (i !== undefined) {
      const s = out[i]!;
      if (s.r == null) {
        s.why = x.why;
        s.kind = classify(x.why);
        s.mode = mode;
      }
      return;
    }
    idx.set(key, out.length);
    out.push({ key, strategy: t.strategy, tf: x.tf, pair: t.pair, side: t.side, entry: t.entry!, stop: t.stop, target: t.target, t: t.entryT, at: now, why: x.why, kind: classify(x.why), mode });
  };
  for (const x of rep.skipped) add(x, 'skip');
  for (const x of rep.waits) add(x, 'wait');
  // a shadow whose lab trade the bot took after all (the wait resolved) is struck
  const keep = out.filter((s) => !(s.r == null && held.has(s.key))).filter((s) => s.r != null || now - s.t < SHADOW.keepDays * 86_400_000);
  keep.sort((a, b) => b.t - a.t);
  return keep.slice(0, SHADOW.max);
}

/** Fill in results from the lab's finished paper trades (same identity). Pure. */
export function gradeShadows(book: readonly ShadowTrade[], closed: readonly Trade[]): ShadowTrade[] {
  const res = new Map<string, Trade>();
  for (const t of closed) if (t.reason !== 'open') res.set(keyOf(t), t);
  return book.map((s) => {
    if (s.r != null) return s;
    const t = res.get(s.key);
    return t ? { ...s, r: Math.round(t.r * 100) / 100, exitT: t.exitT, reason: t.reason } : s;
  });
}

export interface ShadowStat {
  n: number;
  done: number;
  wins: number;
  totalR: number;
  avgR: number | null;
  winPct: number | null;
  /** what those trades would have made at the bot's base risk */
  usd: number;
}
export interface ShadowSummary {
  at: number;
  total: ShadowStat;
  byKind: Array<{ kind: ReasonKind; example: string } & ShadowStat>;
  byStrategy: Array<{ key: string } & ShadowStat>;
  /** still running (the lab trade hasn't finished): R so far at the live price */
  open: Array<Pick<ShadowTrade, 'key' | 'strategy' | 'tf' | 'pair' | 'side' | 'entry' | 'stop' | 'target' | 't' | 'why' | 'kind'> & { rNow: number | null }>;
  /** newest finished ones */
  recent: ShadowTrade[];
  riskPct: number;
}

const emptyStat = (): ShadowStat => ({ n: 0, done: 0, wins: 0, totalR: 0, avgR: null, winPct: null, usd: 0 });
function fold(st: ShadowStat, s: ShadowTrade, usdPerR: number): void {
  st.n++;
  if (s.r == null) return;
  st.done++;
  if (s.r > 0) st.wins++;
  st.totalR += s.r;
  st.avgR = st.totalR / st.done;
  st.winPct = (100 * st.wins) / st.done;
  st.usd = st.totalR * usdPerR;
}

/** Per reason / strategy: what the held-back trades did. `riskPct` × `equityUsd` = the money one R is worth. Pure. */
export function shadowSummary(book: readonly ShadowTrade[], o: { riskPct: number; equityUsd: number; mids?: Record<string, number>; now?: number; days?: number }): ShadowSummary {
  const now = o.now ?? Date.now();
  const rows = book.filter((s) => now - s.t <= (o.days ?? 30) * 86_400_000);
  const usdPerR = (o.riskPct / 100) * o.equityUsd;
  const total = emptyStat();
  const kinds = new Map<ReasonKind, { kind: ReasonKind; example: string } & ShadowStat>();
  const strats = new Map<string, { key: string } & ShadowStat>();
  for (const s of rows) {
    fold(total, s, usdPerR);
    let k = kinds.get(s.kind);
    if (!k) kinds.set(s.kind, (k = { kind: s.kind, example: s.why, ...emptyStat() }));
    fold(k, s, usdPerR);
    const sk = `${s.strategy}:${s.tf}`;
    let st = strats.get(sk);
    if (!st) strats.set(sk, (st = { key: sk, ...emptyStat() }));
    fold(st, s, usdPerR);
  }
  const open = rows
    .filter((s) => s.r == null)
    .map((s) => {
      const px = o.mids?.[s.pair];
      const risk = Math.abs(s.entry - s.stop);
      const rNow = px && risk > 0 ? Math.round((((px - s.entry) * s.side) / risk) * 100) / 100 : null;
      return { key: s.key, strategy: s.strategy, tf: s.tf, pair: s.pair, side: s.side, entry: s.entry, stop: s.stop, target: s.target, t: s.t, why: s.why, kind: s.kind, rNow };
    });
  const recent = rows.filter((s) => s.r != null).sort((a, b) => (b.exitT ?? 0) - (a.exitT ?? 0)).slice(0, 40);
  return {
    at: now,
    total,
    byKind: [...kinds.values()].sort((a, b) => b.n - a.n),
    byStrategy: [...strats.values()].sort((a, b) => b.totalR - a.totalR),
    open,
    recent,
    riskPct: o.riskPct,
  };
}
