/**
 * RugCheck.xyz API — external token safety scores.
 *
 * Free tier, no auth needed: GET /v2/tokens/{mint}/report/summary
 * Returns risk level, score, and specific risks (mint authority, freeze, top holders, etc.).
 * Cached per mint for 10 minutes to stay under rate limits.
 * Used as an additional safety gate in the evaluator + rug screen.
 */
import { moduleLogger } from '../lib/logger';
import { redis } from '../lib/redis';

const log = moduleLogger('rugcheck');
const BASE = 'https://api.rugcheck.xyz/v2';
const CACHE_SEC = 600;
const TIMEOUT_MS = 5_000;

export interface RugCheckRisk {
  name: string;
  level: string;
  description: string;
  score: number;
}

export interface RugCheckResult {
  mint: string;
  score: number;
  /** 'Good' | 'Warn' | 'Danger' | unknown string */
  riskLevel: string;
  risks: RugCheckRisk[];
  /** Top holder percentage from RugCheck's own analysis. */
  topHolderPct: number | null;
  /** Whether the token has mint authority (can print more tokens). */
  hasMintAuthority: boolean;
  /** Whether the token has freeze authority. */
  hasFreezeAuthority: boolean;
  fetchedAt: number;
}

export interface RugCheckVerdict {
  pass: boolean;
  score: number;
  riskLevel: string;
  reasons: string[];
  result: RugCheckResult | null;
}

const CACHE_KEY = (mint: string) => `rugcheck:${mint}`;

let callsToday = 0;
let callDay = '';
const MAX_CALLS_PER_DAY = 500;

function resetDayIfNeeded(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== callDay) { callsToday = 0; callDay = today; }
}

export async function fetchRugCheck(mint: string): Promise<RugCheckResult | null> {
  resetDayIfNeeded();
  const cached = await redis.get(CACHE_KEY(mint)).catch(() => null);
  if (cached) {
    try { return JSON.parse(cached) as RugCheckResult; } catch { /* fall through */ }
  }
  if (callsToday >= MAX_CALLS_PER_DAY) return null;
  try {
    callsToday++;
    const res = await fetch(`${BASE}/tokens/${mint}/report/summary`, {
      headers: { accept: 'application/json', 'user-agent': 'solbot/1.0' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      if (res.status === 429) log.warn('rugcheck rate limited');
      return null;
    }
    const body = await res.json() as Record<string, unknown>;
    const risks: RugCheckRisk[] = [];
    let hasMint = false;
    let hasFreeze = false;
    let topHolder: number | null = null;
    if (Array.isArray(body.risks)) {
      for (const r of body.risks as Array<Record<string, unknown>>) {
        risks.push({
          name: String(r.name ?? ''),
          level: String(r.level ?? ''),
          description: String(r.description ?? ''),
          score: Number(r.score ?? 0),
        });
        const n = String(r.name ?? '').toLowerCase();
        if (n.includes('mint') && n.includes('auth')) hasMint = true;
        if (n.includes('freeze') && n.includes('auth')) hasFreeze = true;
        if (n.includes('top') && n.includes('holder')) {
          const m = String(r.description ?? '').match(/(\d+(?:\.\d+)?)%/);
          if (m) topHolder = parseFloat(m[1]!);
        }
      }
    }
    const result: RugCheckResult = {
      mint,
      score: Number(body.score ?? 0),
      riskLevel: String(body.riskLevel ?? 'unknown'),
      risks,
      topHolderPct: topHolder,
      hasMintAuthority: hasMint || !!body.hasMintAuthority,
      hasFreezeAuthority: hasFreeze || !!body.hasFreezeAuthority,
      fetchedAt: Date.now(),
    };
    await redis.set(CACHE_KEY(mint), JSON.stringify(result), 'EX', CACHE_SEC).catch(() => {});
    return result;
  } catch (err) {
    log.debug({ err: (err as Error).message, mint }, 'rugcheck fetch failed');
    return null;
  }
}

/**
 * Evaluate a token against RugCheck data. Called in the entry pipeline.
 * Returns pass/fail + reasons. Does NOT block on network failure (fail-open for availability).
 */
export function rugCheckVerdict(
  result: RugCheckResult | null,
  cfg: { enabled: boolean; maxScore?: number; blockDanger?: boolean },
): RugCheckVerdict {
  if (!cfg.enabled || !result) return { pass: true, score: 0, riskLevel: 'unknown', reasons: [], result };
  const reasons: string[] = [];
  const maxScore = cfg.maxScore ?? 500;
  if (result.score > maxScore) reasons.push(`RugCheck score ${result.score} > ${maxScore}`);
  if (cfg.blockDanger !== false && result.riskLevel === 'Danger') reasons.push(`RugCheck: ${result.riskLevel}`);
  if (result.hasMintAuthority) reasons.push('RugCheck: mint authority enabled');
  if (result.hasFreezeAuthority) reasons.push('RugCheck: freeze authority enabled');
  return {
    pass: reasons.length === 0,
    score: result.score,
    riskLevel: result.riskLevel,
    reasons,
    result,
  };
}

/** Stats for the dashboard. */
export function rugCheckStats(): { callsToday: number; maxPerDay: number } {
  resetDayIfNeeded();
  return { callsToday, maxPerDay: MAX_CALLS_PER_DAY };
}
