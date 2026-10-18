/**
 * Deployer study (v11.19): does a creator's past predict the next launch — on OUR data? The Oct 18 2026 research found
 * no public study measuring this (the "second launch of the day dies 64–78%" and "quiet proven dev 12% vs 1.7%" claims
 * the deployer book was built on have no traceable source), while one vendor reports a small set of repeat graduators
 * bonding ~70% of the time vs 1–2% base. This walks every launch in the Token table in time order and, for each coin,
 * looks ONLY at what its creator had done BEFORE that moment (no peeking), then asks: did this coin graduate?
 *
 * Bands: prior graduations (0 / 1 / 2 / 3+), prior launches, launched again within 24 h or not, graduated before and
 * quiet ≥ 7 days or not, and the live "elite" definition (deployers.elite) vs everyone else. Coins younger than 2 h are
 * left out (they may still graduate). Zero RPC: Postgres only. Result Redis `dstudy:last`; Money tab card.
 */
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';

export const DSTUDY_LAST = 'dstudy:last';

export interface Launch {
  creator: string;
  createdAtMs: number;
  graduated: boolean;
}

export interface StudyBand {
  label: string;
  launches: number;
  graduated: number;
  /** % graduated */
  pct: number;
  /** lift vs the base rate (×) */
  lift: number;
}

export interface DeployerStudy {
  at: number;
  days: number;
  tokens: number;
  creators: number;
  base: StudyBand;
  byPriorGrads: StudyBand[];
  byPriorLaunches: StudyBand[];
  repeat24h: StudyBand[];
  quietAfterGrad: StudyBand[];
  elite: StudyBand[];
  verdict: string;
  durationMs: number;
}

const DAY = 86_400_000;
const r2 = (x: number) => Math.round(x * 100) / 100;

function band(label: string, rs: Array<{ g: boolean }>, basePct: number): StudyBand {
  const g = rs.filter((r) => r.g).length;
  const pct = rs.length ? (g / rs.length) * 100 : 0;
  return { label, launches: rs.length, graduated: g, pct: r2(pct), lift: basePct > 0 ? r2(pct / basePct) : 0 };
}

/** Pure: the whole study from launches (any order). */
export function studyFromLaunches(launches: readonly Launch[], elite: { minGraduated: number; minBondRatePct: number }, opts: { days?: number; now?: number } = {}): DeployerStudy {
  const t0 = Date.now();
  const rows = [...launches].sort((a, b) => a.createdAtMs - b.createdAtMs);
  const state = new Map<string, { l: number; g: number; lastT: number; lastGradT: number | null }>();
  type Tag = { g: boolean; priorG: number; priorL: number; within24h: boolean | null; quiet: boolean | null; elite: boolean };
  const tags: Tag[] = [];
  for (const r of rows) {
    const s = state.get(r.creator) ?? { l: 0, g: 0, lastT: 0, lastGradT: null };
    const rate = s.l > 0 ? (s.g / s.l) * 100 : 0;
    tags.push({
      g: r.graduated,
      priorG: s.g,
      priorL: s.l,
      within24h: s.l > 0 ? r.createdAtMs - s.lastT <= DAY : null,
      quiet: s.g > 0 ? r.createdAtMs - s.lastT >= 7 * DAY : null,
      elite: s.g >= elite.minGraduated && rate >= elite.minBondRatePct,
    });
    s.l++;
    if (r.graduated) {
      s.g++;
      s.lastGradT = r.createdAtMs;
    }
    s.lastT = r.createdAtMs;
    state.set(r.creator, s);
  }
  const base = band('every launch', tags, 0);
  const bp = base.pct;
  base.lift = 1;
  const byPriorGrads = [
    band('creator had 0 graduations before', tags.filter((t) => t.priorG === 0), bp),
    band('1 graduation before', tags.filter((t) => t.priorG === 1), bp),
    band('2 graduations before', tags.filter((t) => t.priorG === 2), bp),
    band('3+ graduations before', tags.filter((t) => t.priorG >= 3), bp),
  ];
  const byPriorLaunches = [
    band('first launch', tags.filter((t) => t.priorL === 0), bp),
    band('2nd–4th launch', tags.filter((t) => t.priorL >= 1 && t.priorL <= 3), bp),
    band('5th–9th launch', tags.filter((t) => t.priorL >= 4 && t.priorL <= 8), bp),
    band('10th+ launch', tags.filter((t) => t.priorL >= 9), bp),
  ];
  const repeat24h = [
    band('launched again within 24 h', tags.filter((t) => t.within24h === true), bp),
    band('no launch in the 24 h before', tags.filter((t) => t.within24h === false), bp),
  ];
  const quietAfterGrad = [
    band('graduated before, quiet 7+ days', tags.filter((t) => t.quiet === true), bp),
    band('graduated before, launched within 7 days', tags.filter((t) => t.quiet === false), bp),
  ];
  const eliteBands = [band(`elite dev (${elite.minGraduated}+ graduations, ${elite.minBondRatePct}%+ bond rate)`, tags.filter((t) => t.elite), bp), band('everyone else', tags.filter((t) => !t.elite), bp)];
  const el = eliteBands[0]!;
  const rep = repeat24h[0]!;
  const parts: string[] = [];
  if (el.launches >= 20) parts.push(el.lift >= 3 ? `Elite devs graduate ${el.pct}% vs ${bp}% base (${el.lift}×) — a real signal on our data.` : `Elite devs graduate ${el.pct}% vs ${bp}% base (${el.lift}×) — weak on our data.`);
  else parts.push(`Only ${el.launches} launches from elite devs in this window — not enough to judge the elite path yet.`);
  if (rep.launches >= 50) parts.push(rep.lift < 0.7 ? `A second launch within 24 h graduates ${rep.pct}% (${rep.lift}× base) — the no-repeat rule is justified.` : `A second launch within 24 h graduates ${rep.pct}% (${rep.lift}× base) — the no-repeat rule is NOT supported by our data.`);
  return {
    at: opts.now ?? Date.now(),
    days: opts.days ?? 0,
    tokens: rows.length,
    creators: state.size,
    base,
    byPriorGrads,
    byPriorLaunches,
    repeat24h,
    quietAfterGrad,
    elite: eliteBands,
    verdict: parts.join(' ') || 'No launches in the window.',
    durationMs: Date.now() - t0,
  };
}

let running: Promise<DeployerStudy> | null = null;

/** Run the study over the last `days` days of the Token table (paged, yields; one at a time). */
export function runDeployerStudy(days: number, elite: { minGraduated: number; minBondRatePct: number }, now = Date.now()): Promise<DeployerStudy> {
  if (running) return running;
  running = (async () => {
    const t0 = Date.now();
    const since = new Date(now - days * DAY);
    const until = new Date(now - 2 * 3_600_000);
    const launches: Launch[] = [];
    let cursor: Date = since;
    for (let page = 0; page < 2_000; page++) {
      const rows = await prisma.token.findMany({
        where: { createdAt: { gt: cursor, lte: until } },
        select: { creator: true, createdAt: true, completedAt: true },
        orderBy: { createdAt: 'asc' },
        take: 5_000,
      });
      if (!rows.length) break;
      for (const r of rows) if (r.creator) launches.push({ creator: r.creator, createdAtMs: r.createdAt.getTime(), graduated: r.completedAt !== null });
      cursor = rows[rows.length - 1]!.createdAt;
      await new Promise((r) => setImmediate(r));
      if (rows.length < 5_000) break;
    }
    const study = studyFromLaunches(launches, elite, { days, now });
    study.durationMs = Date.now() - t0;
    await redis.set(DSTUDY_LAST, JSON.stringify(study)).catch(() => undefined);
    return study;
  })().finally(() => (running = null));
  return running;
}

export function deployerStudyRunning(): boolean {
  return running !== null;
}

export async function lastDeployerStudy(): Promise<DeployerStudy | null> {
  const raw = await redis.get(DSTUDY_LAST).catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DeployerStudy;
  } catch {
    return null;
  }
}
