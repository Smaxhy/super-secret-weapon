/**
 * Diagnostic (read-only): coins that were held back ONLY by the score (or a Sniper-only check) — how far under the bar
 * they were, and what they actually did afterwards with the live exits and paper costs (shadow "near" trades + the
 * outcome tracker). Answers "would a lower bar have made money?" from the bot's own records, in seconds.
 *
 *   docker compose exec -T bot node dist/tools/score-gap.js [hours=48]
 */
import { redis, closeRedis } from '../lib/redis';

interface Row { strategy: string; score: number; bar: number; why: string; pnlPct: number; at: number; src: 'shadow' | 'outcome' }

const BANDS: Array<[number, number, string]> = [
  [0, 5, '0–5 under'],
  [5, 10, '5–10 under'],
  [10, 15, '10–15 under'],
  [15, 25, '15–25 under'],
  [25, 1e9, '25+ under'],
];

/** Pure: is this skip only about the score / a Sniper-only check (every hard rule passed)? */
export function scoreOnly(why: string): 'score' | 'sniper' | null {
  const w = why.toLowerCase();
  if (w.startsWith('score ') || w.includes('score under the bar')) return 'score';
  if (w.startsWith('sniper:')) return 'sniper';
  return null;
}

/** Pure: band table per strategy. */
export function scoreGapTable(rows: readonly Row[]): string {
  const out: string[] = [];
  const byStrat = new Map<string, Row[]>();
  for (const r of rows) byStrat.set(r.strategy, [...(byStrat.get(r.strategy) ?? []), r]);
  for (const [s, rs] of [...byStrat].sort((a, b) => b[1].length - a[1].length)) {
    const bars = rs.map((r) => r.bar).sort((a, b) => a - b);
    out.push(`${s}: ${rs.length} coins held back only by score · bar ≈ ${bars[Math.floor(bars.length / 2)]?.toFixed(0) ?? '?'}`);
    for (const [lo, hi, label] of BANDS) {
      const b = rs.filter((r) => r.bar - r.score >= lo && r.bar - r.score < hi);
      if (!b.length) continue;
      const avg = b.reduce((a, r) => a + r.pnlPct, 0) / b.length;
      const wins = b.filter((r) => r.pnlPct > 0).length;
      const sol = b.reduce((a, r) => a + r.pnlPct / 100, 0);
      out.push(`  ${label.padEnd(12)} n=${String(b.length).padStart(4)}  wins ${String(Math.round((wins / b.length) * 100)).padStart(3)}%  avg ${avg >= 0 ? '+' : ''}${avg.toFixed(1)}%  at 1 SOL each ${sol >= 0 ? '+' : ''}${sol.toFixed(2)} SOL`);
    }
  }
  return out.join('\n') || 'no score-only near misses recorded in this window';
}

async function main(): Promise<void> {
  const hours = Number(process.argv[2] ?? 48) || 48;
  const since = Date.now() - hours * 3_600_000;
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
  console.log(`Last ${hours} h — coins that passed every rule but were under the score bar, and what they did next (live exits, after costs):\n`);
  console.log(scoreGapTable(rows));
  if (sniper.length) {
    const avg = sniper.reduce((a, r) => a + r.pnlPct, 0) / sniper.length;
    console.log(`\nOver the bar but stopped by a Sniper-only check: n=${sniper.length}, avg ${avg >= 0 ? '+' : ''}${avg.toFixed(1)}%`);
    const reasons = new Map<string, number>();
    for (const r of sniper) { const k = r.why.replace(/[\d.]+/g, '#'); reasons.set(k, (reasons.get(k) ?? 0) + 1); }
    for (const [k, n] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 5)) console.log(`  ×${n}  ${k}`);
  }
}

if (require.main === module) {
  main().catch((e: Error) => { console.error(e.message); process.exitCode = 1; }).finally(() => void closeRedis());
}
