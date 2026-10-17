/**
 * RugCheck API client — pre-trade external safety validation.
 *
 * Calls the RugCheck API (https://api.rugcheck.xyz) to get an independent
 * risk assessment before the bot enters a position. This catches rugs that
 * on-chain analysis alone misses: bundled launches, known scammer wallets,
 * LP manipulation patterns, etc.
 *
 * The result feeds into the safety checker as an additional penalty/bonus.
 * A high-risk RugCheck report can hard-fail a token that passed on-chain checks.
 */
import { moduleLogger } from '../lib/logger';

const log = moduleLogger('rugcheck');

const RUGCHECK_BASE_URL = process.env.RUGCHECK_API_URL ?? 'https://api.rugcheck.xyz';
const RUGCHECK_API_KEY = process.env.RUGCHECK_API_KEY ?? '';
const TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 60_000; // cache reports for 1 minute

export interface RugCheckRisk {
  name: string;
  description: string;
  level: 'info' | 'warn' | 'danger' | 'critical';
  score: number;
}

export interface RugCheckReport {
  mint: string;
  /** Overall risk score — higher = more risky. */
  riskScore: number;
  /** Normalized 0-100 where 100 = extremely risky. */
  riskScoreNormalized: number;
  /** Human-readable risk level. */
  riskLevel: 'Good' | 'Moderate' | 'Risky' | 'Danger';
  /** Whether RugCheck thinks this has already rugged. */
  rugged: boolean;
  /** Individual risk factors found. */
  risks: RugCheckRisk[];
  /** Top 10 holder concentration %. */
  top10HoldersPct: number;
  /** Insider holding %. */
  insiderPct: number;
  /** Whether this check succeeded. */
  ok: true;
}

export interface RugCheckError {
  ok: false;
  error: string;
}

export type RugCheckResult = RugCheckReport | RugCheckError;

// Simple in-memory cache to avoid hammering the API on re-checks
const cache = new Map<string, { report: RugCheckResult; expiresAt: number }>();

function cleanCache(): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
}

/**
 * Fetch a RugCheck report for a token. Returns a degraded result (ok: false)
 * on timeout or API errors — the bot should proceed with its own on-chain
 * checks rather than blocking on an external dependency.
 */
export async function fetchRugCheckReport(mint: string): Promise<RugCheckResult> {
  // Check cache first
  const cached = cache.get(mint);
  if (cached && cached.expiresAt > Date.now()) return cached.report;

  if (!RUGCHECK_API_KEY) {
    return { ok: false, error: 'RUGCHECK_API_KEY not configured' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const url = `${RUGCHECK_BASE_URL}/v1/tokens/${mint}/report`;
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'X-API-KEY': RUGCHECK_API_KEY,
    };

    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
      const err = `RugCheck API returned ${res.status}`;
      log.warn({ mint, status: res.status }, err);
      return { ok: false, error: err };
    }

    const data = await res.json();

    // Parse the response — field names vary between API versions, be defensive
    const riskScore = data.score ?? data.risk_score ?? data.riskScore ?? 0;
    const riskScoreNorm = data.risk_score_normalised ?? data.riskScoreNormalized ?? Math.min(100, riskScore);

    const riskLevel: RugCheckReport['riskLevel'] =
      riskScoreNorm >= 80 ? 'Danger' :
      riskScoreNorm >= 50 ? 'Risky' :
      riskScoreNorm >= 25 ? 'Moderate' : 'Good';

    const risks: RugCheckRisk[] = (data.risks ?? []).map((r: Record<string, unknown>) => ({
      name: r.name ?? r.title ?? 'unknown',
      description: r.description ?? r.message ?? '',
      level: r.level ?? r.severity ?? 'info',
      score: r.score ?? r.value ?? 0,
    }));

    const report: RugCheckReport = {
      mint,
      riskScore,
      riskScoreNormalized: riskScoreNorm,
      riskLevel,
      rugged: data.rugged === true,
      risks,
      top10HoldersPct: data.top10_holders_pct ?? data.topHoldersConcentration ?? 0,
      insiderPct: data.insider_pct ?? data.insiderPct ?? 0,
      ok: true,
    };

    // Cache it
    cache.set(mint, { report, expiresAt: Date.now() + CACHE_TTL_MS });
    if (cache.size > 500) cleanCache();

    log.debug({ mint, riskLevel, riskScore: riskScoreNorm, risks: risks.length }, `RugCheck: ${riskLevel}`);
    return report;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('abort')) {
      log.warn({ mint }, 'RugCheck API timed out');
      return { ok: false, error: 'timeout' };
    }
    log.warn({ mint, err: msg }, 'RugCheck API error');
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Convert a RugCheck report into a safety penalty for the scorer.
 * Returns 0 for clean tokens, up to 100 (hard fail) for dangerous ones.
 */
export function rugCheckPenalty(result: RugCheckResult): { penalty: number; hardFail: boolean; detail: string } {
  if (!result.ok) {
    // API unavailable — don't block, but note it
    return { penalty: 0, hardFail: false, detail: `RugCheck unavailable: ${result.error}` };
  }

  if (result.rugged) {
    return { penalty: 100, hardFail: true, detail: 'RugCheck: token already rugged' };
  }

  const dangerRisks = result.risks.filter(r => r.level === 'critical' || r.level === 'danger');
  if (dangerRisks.length >= 3 || result.riskScoreNormalized >= 80) {
    return {
      penalty: 100,
      hardFail: true,
      detail: `RugCheck: ${result.riskLevel} (score ${result.riskScoreNormalized}, ${dangerRisks.length} critical risks)`,
    };
  }

  if (result.riskScoreNormalized >= 50) {
    return {
      penalty: 30,
      hardFail: false,
      detail: `RugCheck: ${result.riskLevel} (score ${result.riskScoreNormalized})`,
    };
  }

  if (result.riskScoreNormalized >= 25) {
    return {
      penalty: 10,
      hardFail: false,
      detail: `RugCheck: ${result.riskLevel} (score ${result.riskScoreNormalized})`,
    };
  }

  return { penalty: 0, hardFail: false, detail: `RugCheck: ${result.riskLevel}` };
}
