/**
 * Replay runner (v11.5): the dashboard's way to run learner/replay-cli.ts — in a CHILD PROCESS so a replay over
 * days of tape never slows the bot (the API runs inside the bot process). One at a time; results come from Redis.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { moduleLogger } from '../lib/logger';
import { redis } from '../lib/redis';
import { REPLAY_IDS, REPLAY_LAST, replayResKey } from './replay-cli';
import type { ReplayReport } from './replay';

const log = moduleLogger('replay');

export interface ReplayJob {
  id: string;
  startedAt: string;
  args: string[];
  pid: number | null;
  log: string[];
  finishedAt: string | null;
  exitCode: number | null;
}

let running: ReplayJob | null = null;
let last: ReplayJob | null = null;

/** Pure: CLI args for a request. Dates are ISO strings (or anything Date.parse reads); overrides as key=value. */
export function buildArgs(req: { from?: string; to?: string; policy?: string; set?: Record<string, unknown> | string[] }, id: string): string[] {
  const args = ['--id', id];
  if (req.from) args.push('--from', String(req.from));
  if (req.to) args.push('--to', String(req.to));
  args.push('--policy', req.policy === 'sniper' ? 'sniper' : 'live');
  const sets = Array.isArray(req.set) ? req.set : Object.entries(req.set ?? {}).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  for (const s of sets.slice(0, 40)) if (/^[a-zA-Z0-9_.]+=.{0,200}$/.test(s)) args.push('--set', s);
  return args;
}

export function startReplay(req: { from?: string; to?: string; policy?: string; set?: Record<string, unknown> | string[] }): { ok: true; job: ReplayJob } | { ok: false; error: string; job?: ReplayJob } {
  if (running) return { ok: false, error: 'a replay is already running', job: running };
  const id = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;
  const args = buildArgs(req, id);
  const js = path.join(__dirname, 'replay-cli.js');
  const ts = path.join(__dirname, 'replay-cli.ts');
  const cmd = existsSync(js) ? [process.execPath, js] : ['npx', 'tsx', ts];
  const job: ReplayJob = { id, startedAt: new Date().toISOString(), args, pid: null, log: [], finishedAt: null, exitCode: null };
  try {
    const child = spawn(cmd[0]!, [...cmd.slice(1), ...args], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    job.pid = child.pid ?? null;
    const push = (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) if (line.trim()) job.log.push(line.slice(0, 300));
      if (job.log.length > 60) job.log.splice(0, job.log.length - 60);
    };
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    child.on('exit', (code) => {
      job.finishedAt = new Date().toISOString();
      job.exitCode = code;
      last = job;
      running = null;
      log.info({ id, code }, code === 0 ? '🎞️ replay finished' : 'replay failed');
    });
    child.on('error', (err) => {
      job.log.push(`spawn failed: ${err.message}`);
      job.finishedAt = new Date().toISOString();
      job.exitCode = -1;
      last = job;
      running = null;
    });
    running = job;
    log.info({ id, args }, '🎞️ replay started (child process)');
    return { ok: true, job };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function replayRunning(): boolean {
  return running !== null;
}

/** Start a replay and wait for its report (the self-improving loop). null = busy, failed or timed out. */
export async function runReplayAndWait(req: { from?: string; to?: string; policy?: string; set?: string[] }, timeoutMs = 45 * 60_000): Promise<ReplayReport | null> {
  const r = startReplay(req);
  if (!r.ok) return null;
  const id = r.job.id;
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await new Promise((res) => setTimeout(res, 2_000));
    if (running?.id === id) continue;
    if (r.job.exitCode !== 0) return null;
    const raw = await redis.get(replayResKey(id)).catch(() => null);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ReplayReport;
    } catch {
      return null;
    }
  }
  return null;
}

export interface ReplayStatus {
  running: ReplayJob | null;
  lastJob: ReplayJob | null;
  last: ReplayReport | null;
  history: Array<Pick<ReplayReport, 'id' | 'at' | 'from' | 'to' | 'policy' | 'trades' | 'winRatePct' | 'totalSol' | 'avgPct'>>;
}

export async function replayStatus(): Promise<ReplayStatus> {
  const [lastRaw, ids] = await Promise.all([redis.get(REPLAY_LAST).catch(() => null), redis.lrange(REPLAY_IDS, 0, 19).catch(() => [] as string[])]);
  const history: ReplayStatus['history'] = [];
  if (ids.length) {
    const raws = await redis.mget(...ids.map(replayResKey)).catch(() => [] as Array<string | null>);
    for (const raw of raws) {
      if (!raw) continue;
      try {
        const r = JSON.parse(raw) as ReplayReport;
        history.push({ id: r.id, at: r.at, from: r.from, to: r.to, policy: r.policy, trades: r.trades, winRatePct: r.winRatePct, totalSol: r.totalSol, avgPct: r.avgPct });
      } catch {
        /* skip */
      }
    }
  }
  let lastReport: ReplayReport | null = null;
  if (lastRaw) {
    try {
      lastReport = JSON.parse(lastRaw) as ReplayReport;
    } catch {
      lastReport = null;
    }
  }
  return { running, lastJob: last, last: lastReport, history };
}
