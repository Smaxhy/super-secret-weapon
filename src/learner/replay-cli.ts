/**
 * Replay CLI (v11.5) — runs in its own process (never inside the bot):
 *   npm run replay -- --from 2026-10-17 --to 2026-10-18 [--policy live|sniper] [--set exit.stopLoss.maxPct=10 …]
 *   on the VPS: docker compose exec bot node dist/learner/replay-cli.js --from … --to …
 * Streams TradeTape in 5-minute slices through learner/replay.ts, prints a table, stores the report in Redis
 * (`replay:last`, `replay:res:<id>`, `replay:ids` ≤ 20) so the dashboard can show it.
 */
import { overrideConfig, refreshConfig } from '../config/runtime-config';
import { setPath } from '../config/editable';
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { getSolUsd } from '../lib/sol-price';
import { policyByName, Replay, type ReplayReport, type StoredEval, type TapeRow, type TapeToken } from './replay';
import { seedBook, WalletBook, WBOOK_KEY } from './wallet-book';

export const REPLAY_LAST = 'replay:last';
export const REPLAY_IDS = 'replay:ids';
export const replayResKey = (id: string) => `replay:res:${id}`;
const SLICE_MS = 5 * 60_000;

export interface ReplayArgs {
  from: number;
  to: number;
  policy: string;
  set: Record<string, unknown>;
  solUsd: number | null;
  id: string;
}

/** Pure: `--set a.b=1 --set c=true` → { a: { b: 1 }, c: true } (numbers / booleans / JSON parsed, else text). */
export function parseSets(pairs: readonly string[]): Record<string, unknown> {
  let out: Record<string, unknown> = {};
  for (const p of pairs) {
    const i = p.indexOf('=');
    if (i <= 0) continue;
    const key = p.slice(0, i).trim();
    const raw = p.slice(i + 1).trim();
    let value: unknown = raw;
    if (raw === 'true' || raw === 'false') value = raw === 'true';
    else if (raw !== '' && Number.isFinite(Number(raw))) value = Number(raw);
    else if (raw.startsWith('[') || raw.startsWith('{')) {
      try {
        value = JSON.parse(raw);
      } catch {
        value = raw;
      }
    }
    out = setPath(out, key.split('.'), value);
  }
  return out;
}

export function parseArgs(argv: readonly string[], now = Date.now()): ReplayArgs {
  const get = (k: string): string[] => {
    const xs: string[] = [];
    for (let i = 0; i < argv.length; i++) if (argv[i] === `--${k}` && argv[i + 1] !== undefined) xs.push(argv[++i]!);
    return xs;
  };
  const day = (s: string | undefined, def: number) => {
    if (!s) return def;
    const d = Date.parse(s);
    return Number.isFinite(d) ? d : def;
  };
  const to = day(get('to')[0], now);
  const from = day(get('from')[0], to - 86_400_000);
  const sol = Number(get('sol-usd')[0]);
  return { from, to, policy: get('policy')[0] ?? 'live', set: parseSets(get('set')), solUsd: Number.isFinite(sol) && sol > 0 ? sol : null, id: get('id')[0] ?? `${new Date(now).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}` };
}

export async function runReplay(a: ReplayArgs, onProgress?: (msg: string) => void): Promise<ReplayReport> {
  await refreshConfig();
  const policy = policyByName(a.policy);
  if (policy.overrides) overrideConfig(policy.overrides);
  if (Object.keys(a.set).length) overrideConfig(a.set);
  policy.overrides = { ...(policy.overrides ?? {}), ...a.set };
  const solUsd = a.solUsd ?? (await getSolUsd().catch(() => null)) ?? 150;

  const evals = new Map<string, StoredEval[]>();
  const evRows = await prisma.evaluation.findMany({
    where: { createdAt: { gte: new Date(a.from - 180_000), lte: new Date(a.to + 60_000) } },
    select: { mint: true, createdAt: true, combinedScore: true, safetyScore: true, decision: true },
  });
  for (const e of evRows) evals.set(e.mint, [...(evals.get(e.mint) ?? []), { tMs: e.createdAt.getTime(), score: e.combinedScore, safetyScore: e.safetyScore, hardFail: e.decision === 'REJECT' }]);

  const tokens = new Map<string, TapeToken>();
  // v11.6: the wallet book, seeded from the live records (read only — the replay never writes them back).
  const book = new WalletBook(null);
  seedBook(book, await redis.hgetall(WBOOK_KEY).catch(() => ({}) as Record<string, string>));
  const engine = new Replay({ policy, tokens, evals, solUsd, from: a.from, to: a.to, book });
  let slices = 0;
  for (let t0 = a.from; t0 < a.to; t0 += SLICE_MS) {
    const t1 = Math.min(a.to, t0 + SLICE_MS);
    const rows = await prisma.tradeTape.findMany({ where: { t: { gte: new Date(t0), lt: new Date(t1) } }, orderBy: [{ t: 'asc' }, { id: 'asc' }] });
    const missing = [...new Set(rows.map((r) => r.mint))].filter((m) => !tokens.has(m));
    for (let i = 0; i < missing.length; i += 500) {
      const ts = await prisma.token.findMany({ where: { mint: { in: missing.slice(i, i + 500) } }, select: { mint: true, name: true, symbol: true, creator: true, createdAt: true, completedAt: true } });
      for (const x of ts) tokens.set(x.mint, { mint: x.mint, name: x.name, symbol: x.symbol, creator: x.creator, createdAtMs: x.createdAt.getTime(), completedAtMs: x.completedAt?.getTime() ?? null });
    }
    const tape: TapeRow[] = rows.map((r) => ({ mint: r.mint, t: r.t.getTime(), w: r.wallet, buy: r.buy, sol: r.sol, tok: r.tokens ?? 0, px: r.px, ...(r.pp ? { pp: r.pp } : {}), ...(r.slot ? { s: r.slot } : {}), amm: r.amm, curvePct: r.curvePct }));
    engine.feed(tape);
    slices++;
    if (slices % 12 === 0) onProgress?.(`${new Date(t1).toISOString().slice(0, 16)} — ${rows.length} trades in the last slice`);
    await new Promise((r) => setImmediate(r));
  }
  const report = engine.finish(a.id);
  await redis.set(replayResKey(report.id), JSON.stringify(report), 'EX', 30 * 86_400).catch(() => undefined);
  await redis.set(REPLAY_LAST, JSON.stringify(report)).catch(() => undefined);
  await redis.lpush(REPLAY_IDS, report.id).catch(() => undefined);
  await redis.ltrim(REPLAY_IDS, 0, 19).catch(() => undefined);
  return report;
}

export function formatReport(r: ReplayReport): string {
  const lines: string[] = [];
  const sign = (x: number) => `${x >= 0 ? '+' : ''}${x}`;
  lines.push(`Replay ${r.policy} ${r.from.slice(0, 16)} → ${r.to.slice(0, 16)}: ${r.rows} trades on ${r.coins} coins, ${r.evaluated} checks, ${r.signals} buy signals`);
  lines.push(`  ${r.trades} trades · ${r.winRatePct}% wins · ${sign(r.totalSol)} SOL at ${r.sizeSol} SOL each · avg ${sign(r.avgPct)}% · median ${sign(r.medianPct)}% · profit factor ${r.profitFactor ?? '—'} · ${(r.durationMs / 1000).toFixed(1)} s`);
  for (const s of r.byStrategy) lines.push(`  ${s.strategy.padEnd(20)} n=${String(s.n).padStart(4)}  wins ${String(s.winRatePct).padStart(3)}%  ${sign(s.totalSol).padStart(8)} SOL  avg ${sign(s.avgPct)}%`);
  for (const e of r.byExit) lines.push(`  exit ${e.reason.padEnd(18)} n=${String(e.n).padStart(4)}  ${sign(e.totalSol).padStart(8)} SOL  avg ${sign(e.avgPct)}%`);
  for (const s of r.skips) lines.push(`  skip ×${String(s.count).padStart(6)}  ${s.reason}`);
  lines.push(`  ${r.note}`);
  return lines.join('\n');
}

if (require.main === module) {
  const a = parseArgs(process.argv.slice(2));
  runReplay(a, (m) => console.log(`  … ${m}`))
    .then(async (r) => {
      console.log(formatReport(r));
      await prisma.$disconnect();
      redis.disconnect();
      process.exit(0);
    })
    .catch(async (err: Error) => {
      console.error(`replay failed: ${err.message}`);
      await prisma.$disconnect().catch(() => undefined);
      redis.disconnect();
      process.exit(1);
    });
}
