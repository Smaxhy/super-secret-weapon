/**
 * Diagnostic (read-only): coins that were held back ONLY by the score (or a Sniper-only check) — how far under the bar
 * they were, and what they actually did afterwards with the live exits and paper costs (shadow "near" trades + the
 * outcome tracker). Answers "would a lower bar have made money?" from the bot's own records, in seconds.
 *
 *   docker compose exec -T bot node dist/tools/score-gap.js [hours=48]
 *   GET /api/score-gap?hours=48  → Performance → Mistakes card "Coins the score held back"
 */
import { redis, closeRedis } from '../lib/redis';

export interface Row { strategy: string; score: number; bar: number; why: string; pnlPct: number; at: number; src: 'shadow' | 'outcome' }
export interface Band { label: string; n: number; winPct: number; avgPct: number; sol: number }
export interface StrategyGap { strategy: string; n: number; bar: number | null; bands: Band[]; verdict: 'too_high' | 'right' | 'unclear'; verdictText: string }
export interface ScoreGapReport {
  hours: number;
  at: number;
  strategies: StrategyGap[];
  sniper: { n: number; avgPct: number; reasons: Array<{ why: string; n: number }> } | null;
}

const BANDS: Array<[number, number, string]> = [
  [0, 5, '0–5 under'],
  [5, 10, '5–10 under'],
  [10, 15, '10–15 under'],
  [15, 25, '15–25 under'],
  [25, 1e9, '25+ under'],
];
/** Coins within this many points of the bar decide the verdict; at least this many are needed. */
const NEAR_PTS = 10;
const MIN_NEAR = 10;

/** Pure: is this skip only about the score / a Sniper-only check (every hard rule passed)? */
export function scoreOnly(why: string): 'score' | 'sniper' | null {
  const w = why.toLowerCase();
  if (w.startsWith('score ') || w.includes('score under the bar')) return 'score';
  if (w.startsWith('sniper:')) return 'sniper';
  return null;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

function band(rs: readonly Row[], label: string): Band {
  const avg = rs.reduce((a, r) => a + r.pnlPct, 0) / rs.length;
  return {
    label,
    n: rs.length,
    winPct: Math.round((rs.filter((r) => r.pnlPct > 0).length / rs.length) * 100),
    avgPct: round1(avg),
    sol: Math.round(rs.reduce((a, r) => a + r.pnlPct / 100, 0) * 100) / 100,
  };
}

/** Pure: per strategy, the bands + a plain-words verdict from the coins just under the bar. */
export function scoreGapStrategies(rows: readonly Row[]): StrategyGap[] {
  const byStrat = new Map<string, Row[]>();
  for (const r of rows) byStrat.set(r.strategy, [...(byStrat.get(r.strategy) ?? []), r]);
  return [...byStrat]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([strategy, rs]) => {
      const bars = rs.map((r) => r.bar).sort((a, b) => a - b);
      const bands = BANDS.flatMap(([lo, hi, label]) => {
        const b = rs.filter((r) => r.bar - r.score >= lo && r.bar - r.score < hi);
        return b.length ? [band(b, label)] : [];
      });
      const near = rs.filter((r) => r.bar - r.score < NEAR_PTS);
      let verdict: StrategyGap['verdict'] = 'unclear';
      let verdictText = `Only ${near.length} coins within ${NEAR_PTS} points of the bar — not enough to judge yet (need ${MIN_NEAR}).`;
      if (near.length >= MIN_NEAR) {
        const nb = band(near, 'near');
        if (nb.avgPct > 0) {
          verdict = 'too_high';
          verdictText = `Bar looks too high: coins just under it made ${nb.avgPct >= 0 ? '+' : ''}${nb.avgPct}% on average (${nb.winPct}% won). Lowering it would have bought them.`;
        } else {
          verdict = 'right';
          verdictText = `Bar is doing its job: coins just under it lost ${nb.avgPct}% on average. The problem is which coins reach the score, not the bar.`;
        }
      }
      return { strategy, n: rs.length, bar: bars.length ? round1(bars[Math.floor(bars.length / 2)]!) : null, bands, verdict, verdictText };
    });
}

/** Pure: band table per strategy (CLI output). */
export function scoreGapTable(rows: readonly Row[]): string {
  const out: string[] = [];
  for (const s of scoreGapStrategies(rows)) {
    out.push(`${s.strategy}: ${s.n} coins held back only by score · bar ≈ ${s.bar?.toFixed(0) ?? '?'}`);
    for (const b of s.bands) {
      out.push(`  ${b.label.padEnd(12)} n=${String(b.n).padStart(4)}  wins ${String(b.winPct).padStart(3)}%  avg ${b.avgPct >= 0 ? '+' : ''}${b.avgPct.toFixed(1)}%  at 1 SOL each ${b.sol >= 0 ? '+' : ''}${b.sol.toFixed(2)} SOL`);
    }
    out.push(`  → ${s.verdictText}`);
  }
  return out.join('\n') || 'no score-only near misses recorded in this window';
}

/** Reads shadow:res + outcome:res and builds the report (read-only). */
export async function scoreGapReport(hours = 48, now = Date.now()): Promise<ScoreGapReport> {
  const since = now - hours * 3_600_000;
  const parse = (s: string): Record<string, unknown> | null => { try { return JSON.parse(s) as Record<string, unknown>; } catch { return null; } };
  const [shadow, outcome] = await Promise.all([redis.lrange('shadow:res', 0, -1), redis.lrange('outcome:res', 0, -1)]);
  const rows: Row[] = [];
  const sniper: Row[] = [];
  for (const [src, list] of [['shadow', shadow], ['outcome', outcome]] as const) {
    for (const raw of list) {
      const o = parse(raw);
      if (!o || typeof o.score !== 'number' || typeof o.bar !== 'number' || typeof o.pnlPct !== 'number') continue;
      const at = Number(o.closedAtMs ?? o.atMs ?? 0);
      if (at && at < since) continue;
      const kind = scoreOnly(String(o.why ?? ''));
      const row: Row = { strategy: String(o.strategy), score: o.score, bar: o.bar, why: String(o.why), pnlPct: o.pnlPct, at, src };
      if (kind === 'score') rows.push(row);
      else if (kind === 'sniper') sniper.push(row);
    }
  }
  const reasons = new Map<string, number>();
  for (const r of sniper) { const k = r.why.replace(/[\d.]+/g, '#'); reasons.set(k, (reasons.get(k) ?? 0) + 1); }
  return {
    hours,
    at: now,
    strategies: scoreGapStrategies(rows),
    sniper: sniper.length
      ? { n: sniper.length, avgPct: round1(sniper.reduce((a, r) => a + r.pnlPct, 0) / sniper.length), reasons: [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([why, n]) => ({ why, n })) }
      : null,
  };
}

async function main(): Promise<void> {
  const hours = Number(process.argv[2] ?? 48) || 48;
  const rep = await scoreGapReport(hours);
  console.log(`Last ${hours} h — coins that passed every rule but were under the score bar, and what they did next (live exits, after costs):\n`);
  const lines: string[] = [];
  for (const s of rep.strategies) {
    lines.push(`${s.strategy}: ${s.n} coins held back only by score · bar ≈ ${s.bar?.toFixed(0) ?? '?'}`);
    for (const b of s.bands) lines.push(`  ${b.label.padEnd(12)} n=${String(b.n).padStart(4)}  wins ${String(b.winPct).padStart(3)}%  avg ${b.avgPct >= 0 ? '+' : ''}${b.avgPct.toFixed(1)}%  at 1 SOL each ${b.sol >= 0 ? '+' : ''}${b.sol.toFixed(2)} SOL`);
    lines.push(`  → ${s.verdictText}`);
  }
  console.log(lines.join('\n') || 'no score-only near misses recorded in this window');
  if (rep.sniper) {
    console.log(`\nOver the bar but stopped by a Sniper-only check: n=${rep.sniper.n}, avg ${rep.sniper.avgPct >= 0 ? '+' : ''}${rep.sniper.avgPct.toFixed(1)}%`);
    for (const r of rep.sniper.reasons) console.log(`  ×${r.n}  ${r.why}`);
  }
}

if (require.main === module) {
  main().catch((e: Error) => { console.error(e.message); process.exitCode = 1; }).finally(() => void closeRedis());
}
