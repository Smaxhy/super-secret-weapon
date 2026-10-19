/**
 * v17.2 parent side of the hourly run's child process (`lab-worker.ts`, FX_LAB_WORKER=on). The child gets its own heap
 * limit (a run that blows up can't take the crypto bot or the API down with it) and its own CPU core. Failure rules:
 * the child could not START (spawn / load error) → the caller may run inline once; it started and then failed, timed
 * out or ran out of memory → that run is skipped (re-running a pathological run in the main process is exactly what
 * this is meant to avoid). v17: but a child that fails `inlineAfterFails` hours in a row with a LIGHT failure (it threw,
 * or its result couldn't come back) is not left to skip every hour — the next `inlineRuns` runs go inline (the flag-off
 * path), then the child is tried again (`planLabRun` / `afterLabRun`); a good child run clears the streak. A HEAVY
 * failure (timed out, out of memory, killed) gets one retry with a bigger heap; a second in a row goes inline too (v18.5).
 */
import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { RunOutput, WorkerInput, WorkerResult, WorkerState } from './lab';
import type { LearnKey } from './learner';

export const LAB_WORKER = {
  heapMb: 900,
  /** v18.5: after a heavy failure the next child gets this heap (the v18 lab is bigger); a second heavy failure in a row
   * sends the next `inlineRuns` runs inline — a bot that skips every hour is worse than a main process under load */
  heapMbRetry: 1300,
  heavyBeforeInline: 2,
  timeoutMs: 15 * 60_000,
  inlineAfterFails: 2,
  inlineRuns: 6,
};

/** v17: the child's failure streak (started, then failed / timed out / ran out of memory) and inline runs still owed. */
export interface WorkerStreak {
  fails: number;
  inlineLeft: number;
  /** v18.5: heavy failures (timed out / out of memory / killed) in a row */
  heavy?: number;
}
export const NO_STREAK: WorkerStreak = { fails: 0, inlineLeft: 0, heavy: 0 };

/** v18.5: the child's heap for the next run — bigger after a heavy failure. Pure. */
export function heapFor(st: WorkerStreak, cfg: Pick<typeof LAB_WORKER, 'heapMb' | 'heapMbRetry'> = LAB_WORKER): number {
  return (st.heavy ?? 0) >= 1 ? cfg.heapMbRetry : cfg.heapMb;
}

/** v17: where the next run goes while the worker flag is on: inline while a failure streak is sat out, else the child. Pure. */
export function planLabRun(st: WorkerStreak): 'worker' | 'inline' {
  return st.inlineLeft > 0 ? 'inline' : 'worker';
}

/**
 * v17: the streak after a run. `ok` clears it; `failed` (light) counts (reaching `inlineAfterFails` in a row →
 * `tripped`, the next `inlineRuns` runs go inline; a failed retry after that trips again at once); `heavy` (timed out /
 * out of memory / killed) clears it and owes no inline run; `inline` uses up one owed inline run; `spawn` (could not
 * start — that hour already ran inline) changes nothing. Pure.
 */
export function afterLabRun(st: WorkerStreak, what: 'ok' | 'failed' | 'heavy' | 'inline' | 'spawn', cfg: Pick<typeof LAB_WORKER, 'inlineAfterFails' | 'inlineRuns' | 'heavyBeforeInline'> = LAB_WORKER): { st: WorkerStreak; tripped: boolean } {
  if (what === 'ok') return { st: { ...NO_STREAK }, tripped: false };
  if (what === 'heavy') {
    // v18.5: one heavy failure → the next child gets a bigger heap (`heapFor`); the second in a row → inline runs,
    // the way light failures do (before, a heavy failure was skipped forever — the bot then never opened a trade)
    const heavy = (st.heavy ?? 0) + 1;
    const tripped = heavy >= cfg.heavyBeforeInline;
    return { st: { fails: 0, inlineLeft: tripped ? cfg.inlineRuns : st.inlineLeft, heavy }, tripped };
  }
  if (what === 'inline') return { st: { ...st, inlineLeft: Math.max(0, st.inlineLeft - 1) }, tripped: false };
  if (what === 'spawn') return { st: { ...st }, tripped: false };
  const fails = st.fails + 1;
  const tripped = fails >= cfg.inlineAfterFails;
  return { st: { ...st, fails, inlineLeft: tripped ? cfg.inlineRuns : st.inlineLeft }, tripped };
}

/** v17: a failed run says whether it was heavy (timed out / out of memory / killed) and may carry the child's feed reports */
export type ForkOutcome =
  | { kind: 'ok'; res: Extract<WorkerResult, { ok: true }> }
  | { kind: 'spawn'; error: string }
  | { kind: 'failed'; error: string; heavy: boolean; feeds?: Extract<WorkerResult, { ok: false }>['feeds']; breakers?: Extract<WorkerResult, { ok: false }>['breakers'] };

/** v17: an error text that means the child ran out of memory (a JS-level heap error the child still caught). Pure. */
export const memoryError = (e: string) => /heap|out of memory|allocation failed/i.test(e);

export const labWorkerOn = () => process.env.FX_LAB_WORKER === 'on';

export function forkLabRun(refresh: boolean, input: WorkerInput, cfg: Pick<typeof LAB_WORKER, 'heapMb' | 'timeoutMs'> = LAB_WORKER): Promise<ForkOutcome> {
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
      settle({ kind: 'failed', error: `timed out after ${Math.round(cfg.timeoutMs / 60_000)} min`, heavy: true });
    }, cfg.timeoutMs);
    child.on('message', (m: unknown) => {
      const msg = m as ({ ready?: boolean } & Partial<WorkerResult>) | null;
      if (msg?.ready && !ready) {
        ready = true;
        child.send({ cmd: 'run', refresh, input });
        return;
      }
      if (msg && 'ok' in msg) {
        if (msg.ok) settle({ kind: 'ok', res: msg as Extract<WorkerResult, { ok: true }> });
        else {
          const f = msg as Extract<WorkerResult, { ok: false }>;
          const error = f.error ?? 'failed';
          settle({ kind: 'failed', error, heavy: memoryError(error), feeds: f.feeds, breakers: f.breakers });
        }
      }
    });
    child.on('error', (err) => settle(ready ? { kind: 'failed', error: err.message, heavy: false } : { kind: 'spawn', error: err.message }));
    child.on('exit', (code, signal) => {
      // v17: Node's heap-limit crash aborts (SIGABRT / 134); SIGKILL = the kernel's OOM killer or our own timeout
      const killed = signal === 'SIGKILL' || signal === 'SIGABRT' || code === 134;
      const why = killed ? 'killed (out of memory?)' : `exited with ${code ?? signal}`;
      settle(ready ? { kind: 'failed', error: why, heavy: killed } : { kind: 'spawn', error: `could not start: ${why}` });
    });
  });
}

/**
 * v17: whose restricted-learner state the parent keeps after a run in the child. While the child runs, the parent's
 * fast-chart checks keep calling `botRecord` (every 1–15 min); the child started from the fork-time states, so once the
 * parent's states moved since the fork (`forkSig`) the child's view has stale hysteresis (an 'off' key could step back
 * to half size) → keep the parent's. Unchanged since the fork → the child's (it saw the newer ledger). No fork recorded
 * (null) → the child's. Pure.
 */
export function learnerSource(forkSig: string | null, parentSig: string): 'parent' | 'child' {
  return forkSig !== null && parentSig !== forkSig ? 'parent' : 'child';
}

/** v17: keys where the parent's learner is stricter than the child's: off where the child wasn't, half where it had normal. */
export interface LearnerTighten {
  off: string[];
  /** key → the parent's size factor */
  down: Record<string, number>;
}
/** Pure. */
export function learnerTighten(parent: Readonly<Record<string, LearnKey>>, child: Readonly<Record<string, LearnKey>>): LearnerTighten {
  const off: string[] = [];
  const down: Record<string, number> = {};
  for (const [k, p] of Object.entries(parent)) {
    const c = child[k]?.state ?? 'on';
    if (p.state === 'off' && c !== 'off') off.push(k);
    else if (p.state === 'down' && c === 'on') down[k] = p.sizeF;
  }
  return { off, down };
}

const addOff = (dropped: readonly string[], off: readonly string[]) => [...dropped, ...off.filter((k) => !dropped.includes(k))];
/** `strategy:tf:pair` → `strategy:tf` */
const keyOfOpen = (k: string) => k.slice(0, k.lastIndexOf(':'));

/**
 * v17: the child's learner-derived state (dropped list, chosen list, the plan's open trades) made as strict as the
 * parent's learner. Only ever tightens: a key the child had off but the parent doesn't stays dropped for this hour (the
 * dropped list also holds the bot record's losers, which can't be told apart here). Pure.
 */
export function tightenState(s: WorkerState, t: LearnerTighten): WorkerState {
  if (!t.off.length) return s;
  const off = new Set(t.off);
  return {
    ...s,
    dropped: addOff(s.dropped, t.off),
    chosen: s.chosen.filter((k) => !off.has(k)),
    labOpen: Object.fromEntries(Object.entries(s.labOpen).filter(([k]) => !off.has(keyOfOpen(k)))),
    // v17.8: the live market view's signals of an off key are not "chosen" either
    marketsNow: Array.isArray(s.marketsNow) ? tightenMarkets(s.marketsNow, off) : s.marketsNow,
  };
}

/**
 * v17.8: the newest-close signals of an off key marked not chosen (the inline run never marks them chosen: its list
 * already left the key out). Same array back when nothing flips. Pure.
 */
export function tightenMarkets<M extends { firing: ReadonlyArray<{ id: string; tf: string; chosen?: boolean }> }>(markets: readonly M[], off: ReadonlySet<string>): M[] {
  let flipped = false;
  const res = markets.map((m) => {
    if (!m.firing.some((f) => f.chosen && off.has(`${f.id}:${f.tf}`))) return m;
    flipped = true;
    return { ...m, firing: m.firing.map((f) => (f.chosen && off.has(`${f.id}:${f.tf}`) ? { ...f, chosen: false } : f)) };
  });
  return flipped ? res : (markets as M[]);
}

/**
 * v17: the run's bot hand-over made as strict as the parent's learner: an off key's trades are no longer chosen (never
 * opened; a held one is still managed), a half-size key's trades are sized down by the parent's factor. The ×1.15
 * "proven" bonus the child may have given a key it still had at normal can't be told apart here and stays for that
 * hour. Pure.
 */
export function tightenOut(out: RunOutput, t: LearnerTighten): RunOutput {
  if (!t.off.length && !Object.keys(t.down).length) return out;
  const off = new Set(t.off);
  // v17.8: the report's newest-close signals and the run's "chosen signals" count follow the tightened list
  const markets = Array.isArray(out.report?.markets) ? tightenMarkets(out.report.markets, off) : null;
  const flipped = markets !== null && markets !== out.report.markets;
  return {
    ...out,
    ...(flipped ? { report: { ...out.report, markets }, firing: { signals: out.firing.signals, chosen: markets.flatMap((m) => m.firing).filter((f) => f.chosen && f.allowed).length } } : {}),
    dropped: addOff(out.dropped, t.off),
    chosen: out.chosen.filter((k) => !off.has(k)),
    botTrades: out.botTrades.map((x) => {
      const k = `${x.strategy}:${x.tf}`;
      if (off.has(k)) return x.chosen ? { ...x, chosen: false } : x;
      const f = t.down[k];
      return f === undefined ? x : { ...x, sizeF: (x.sizeF ?? 1) * f };
    }),
  };
}
