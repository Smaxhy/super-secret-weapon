/**
 * v17.2 parent side of the hourly run's child process (`lab-worker.ts`, FX_LAB_WORKER=on). The child gets its own heap
 * limit (a run that blows up can't take the crypto bot or the API down with it) and its own CPU core. Failure rules:
 * the child could not START (spawn / load error) → the caller may run inline once; it started and then failed, timed
 * out or ran out of memory → that run is skipped (re-running a pathological run in the main process is exactly what
 * this is meant to avoid).
 */
import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { WorkerInput, WorkerResult } from './lab';

export const LAB_WORKER = { heapMb: 900, timeoutMs: 15 * 60_000 };

export type ForkOutcome = { kind: 'ok'; res: Extract<WorkerResult, { ok: true }> } | { kind: 'spawn'; error: string } | { kind: 'failed'; error: string };

export const labWorkerOn = () => process.env.FX_LAB_WORKER === 'on';

export function forkLabRun(refresh: boolean, input: WorkerInput, cfg = LAB_WORKER): Promise<ForkOutcome> {
  const js = path.join(__dirname, 'lab-worker.js');
  const ts = path.join(__dirname, 'lab-worker.ts');
  const useJs = existsSync(js);
  return new Promise((resolve) => {
    let done = false;
    let ready = false;
    let timer: NodeJS.Timeout | null = null;
    const settle = (o: ForkOutcome) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(o);
    };
    let child: ReturnType<typeof fork>;
    try {
      child = fork(useJs ? js : ts, [], {
        execArgv: [...(useJs ? [] : ['--import', 'tsx']), `--max-old-space-size=${cfg.heapMb}`],
        serialization: 'advanced',
        env: { ...process.env, NODE_OPTIONS: '' },
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
    } catch (err) {
      settle({ kind: 'spawn', error: (err as Error).message });
      return;
    }
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle({ kind: 'failed', error: `timed out after ${Math.round(cfg.timeoutMs / 60_000)} min` });
    }, cfg.timeoutMs);
    child.on('message', (m: unknown) => {
      const msg = m as ({ ready?: boolean } & Partial<WorkerResult>) | null;
      if (msg?.ready && !ready) {
        ready = true;
        child.send({ cmd: 'run', refresh, input });
        return;
      }
      if (msg && 'ok' in msg) settle(msg.ok ? { kind: 'ok', res: msg as Extract<WorkerResult, { ok: true }> } : { kind: 'failed', error: (msg as { error?: string }).error ?? 'failed' });
    });
    child.on('error', (err) => settle(ready ? { kind: 'failed', error: err.message } : { kind: 'spawn', error: err.message }));
    child.on('exit', (code, signal) => {
      const why = signal === 'SIGKILL' || code === 134 ? 'killed (out of memory?)' : `exited with ${code ?? signal}`;
      settle(ready ? { kind: 'failed', error: why } : { kind: 'spawn', error: `could not start: ${why}` });
    });
  });
}
