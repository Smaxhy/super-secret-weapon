/**
 * Copy-replay runner (v11.18): runs learner/copy-replay.ts in a CHILD PROCESS from the dashboard so a walk over days of
 * tape never slows the bot. One at a time; the report lands in Redis (`copyrep:last`).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { moduleLogger } from '../lib/logger';
import { redis } from '../lib/redis';
import { COPYREP_LAST, type CopyReport } from './copy-replay';

const log = moduleLogger('copy-replay');

export interface CopyJob {
  id: string;
  startedAt: string;
  args: string[];
  pid: number | null;
  log: string[];
  finishedAt: string | null;
  exitCode: number | null;
}

let running: CopyJob | null = null;
let last: CopyJob | null = null;

export function buildCopyArgs(req: { from?: string; to?: string; sizeSol?: number; method?: boolean }, id: string): string[] {
  const args = ['--id', id];
  if (req.from && Number.isFinite(Date.parse(req.from))) args.push('--from', new Date(req.from).toISOString());
  if (req.to && Number.isFinite(Date.parse(req.to))) args.push('--to', new Date(req.to).toISOString());
  if (typeof req.sizeSol === 'number' && req.sizeSol > 0 && req.sizeSol <= 50) args.push('--size', String(req.sizeSol));
  if (req.method) args.push('--method');
  return args;
}

export function startCopyReplay(req: { from?: string; to?: string; sizeSol?: number; method?: boolean }): { ok: boolean; job?: CopyJob; error?: string } {
  if (running) return { ok: false, error: 'a copy replay is already running', job: running };
  const id = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;
  const args = buildCopyArgs(req, id);
  const js = path.join(__dirname, 'copy-replay.js');
  const ts = path.join(__dirname, 'copy-replay.ts');
  const cmd = existsSync(js) ? [process.execPath, '--max-old-space-size=1024', js] : ['npx', 'tsx', ts];
  const job: CopyJob = { id, startedAt: new Date().toISOString(), args, pid: null, log: [], finishedAt: null, exitCode: null };
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
      log.info({ id, code }, code === 0 ? '👛 copy replay finished' : 'copy replay failed');
    });
    child.on('error', (err) => {
      job.log.push(`spawn failed: ${err.message}`);
      job.finishedAt = new Date().toISOString();
      job.exitCode = -1;
      last = job;
      running = null;
    });
    running = job;
    log.info({ id, args }, '👛 copy replay started (child process)');
    return { ok: true, job };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function copyReplayStatus(): Promise<{ running: CopyJob | null; lastJob: CopyJob | null; last: CopyReport | null }> {
  const raw = await redis.get(COPYREP_LAST).catch(() => null);
  let rep: CopyReport | null = null;
  if (raw) { try { rep = JSON.parse(raw) as CopyReport; } catch { rep = null; } }
  return { running, lastJob: last, last: rep };
}
