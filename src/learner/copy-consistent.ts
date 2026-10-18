/**
 * Consistent-only copy trading (v15.4, owner: "about wallet copy trading I want only the consistent wallets to be
 * copied"). A COPY wallet's buy is copied only when the latest copy test (`copyrep:last`, the copy replay — re-run
 * every night on the last days of tape, method-only) found its copies profitable in BOTH halves of the test, on 6+
 * copies (`WalletReport.consistent`). Otherwise its buys only count as a KOL signal. Also: a nightly re-run.
 */
import type Redis from 'ioredis';
import { moduleLogger } from '../lib/logger';
import { COPYREP_LAST, type CopyReport, type WalletReport } from './copy-replay';
import { startCopyReplay } from './copy-replay-runner';

const log = moduleLogger('copy-consistent');

/** Copy this wallet's buy? Pure. */
export function copyDecision(report: Pick<CopyReport, 'wallets_' | 'to'> | null, wallet: string): { ok: boolean; why: string } {
  if (!report) return { ok: false, why: 'no copy test yet (it runs every night)' };
  const w: WalletReport | undefined = report.wallets_.find((x) => x.wallet === wallet);
  if (!w) return { ok: false, why: 'no copies of it in the latest copy test yet' };
  const sol = (x: number) => `${x >= 0 ? '+' : ''}${x} SOL`;
  if (!w.consistent) return { ok: false, why: `not consistent in the latest copy test: ${w.n} copies, halves ${sol(w.firstHalfSol)} / ${sol(w.secondHalfSol)}` };
  return { ok: true, why: `consistent in the latest copy test: ${w.n} copies, ${sol(w.totalSol)}, both halves positive` };
}

let cache: { at: number; report: CopyReport | null } | null = null;

/** The latest copy test (cached 5 minutes). */
export async function latestCopyReport(redis: Redis, now = Date.now()): Promise<CopyReport | null> {
  if (cache && now - cache.at < 5 * 60_000) return cache.report;
  let report: CopyReport | null = null;
  try {
    const raw = await redis.get(COPYREP_LAST);
    report = raw ? (JSON.parse(raw) as CopyReport) : null;
  } catch {
    report = null;
  }
  cache = { at: now, report };
  return report;
}

/** Forget the cached report (after a new test finished). */
export const resetCopyReportCache = () => {
  cache = null;
};

/**
 * Nightly copy test: at `hourUtc` once a day, the last `days` of tape in method-only mode (child process), so the
 * consistent list follows what the wallets do now. Never two at once (the runner refuses).
 */
export function startNightlyCopyTest(redis: Redis, cfg: () => { enabled: boolean; hourUtc: number; days: number }): NodeJS.Timeout {
  return setInterval(() => {
    void (async () => {
      const c = cfg();
      const now = new Date();
      if (!c.enabled || now.getUTCHours() !== c.hourUtc) return;
      const key = `copyrep:nightly:${now.toISOString().slice(0, 10)}`;
      if (!(await redis.set(key, '1', 'EX', 2 * 86_400, 'NX').catch(() => null))) return;
      const r = startCopyReplay({ from: new Date(now.getTime() - c.days * 86_400_000).toISOString(), to: now.toISOString(), method: true });
      resetCopyReportCache();
      log.info({ ok: r.ok, error: r.error }, 'nightly copy test');
    })().catch(() => undefined);
  }, 10 * 60_000);
}
