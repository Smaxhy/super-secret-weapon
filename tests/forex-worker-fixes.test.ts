import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { fork } from 'node:child_process';
import path from 'node:path';
import { serialize, deserialize } from 'node:v8';
import { FeedBook, feeds } from '../src/forex/feeds';
import { ForexLab, FX_LEARN, type RunOutput, type WorkerInput, type WorkerResult } from '../src/forex/lab';
import { afterLabRun, heapFor, forkLabRun, learnerSource, learnerTighten, LAB_WORKER, memoryError, NO_STREAK, planLabRun, tightenOut, type ForkOutcome } from '../src/forex/lab-runner';
import type { LearnKey } from '../src/forex/learner';
import type { LabOpenTrade } from '../src/forex/practice';

vi.mock('../src/forex/lab-runner', async (orig) => {
  const m = await orig<typeof import('../src/forex/lab-runner')>();
  return { ...m, forkLabRun: vi.fn() };
});

const M = 60_000;

class R {
  m = new Map<string, string>();
  h = new Map<string, Record<string, string>>();
  async get(k: string) {
    return this.m.get(k) ?? null;
  }
  async set(k: string, v: string) {
    this.m.set(k, v);
    return 'OK';
  }
  async mget(...ks: string[]) {
    return ks.map((k) => this.m.get(k) ?? null);
  }
  async hset(k: string, v: Record<string, string>) {
    this.h.set(k, { ...(this.h.get(k) ?? {}), ...v });
    return 1;
  }
  async hgetall(k: string) {
    return this.h.get(k) ?? {};
  }
}
const asRedis = (r: R) => r as unknown as Redis;

const lk = (state: LearnKey['state']): LearnKey => ({ n: 12, meanR: state === 'on' ? 0.2 : -0.3, pPos: state === 'off' ? 0.1 : state === 'down' ? 0.3 : 0.7, state, sizeF: state === 'off' ? 0 : state === 'down' ? 0.5 : 1, why: state });

describe('v17 FINDING 8: breakers travel between the hourly run and its child', () => {
  it('an open breaker from the other process is honoured; the newer update per provider wins', () => {
    let tc = 1_000_000;
    let tp = 1_000_000;
    const child = new FeedBook(() => tc);
    const parent = new FeedBook(() => tp);
    // the child's hourly Yahoo refresh fails 3 times → its Yahoo breaker opens
    for (let i = 0; i < 3; i++) child.fail('yahoo-1h', new Error('timeout'));
    expect(child.allow('yahoo')).toBe(false);
    const snap = deserialize(serialize(child.breakerSnapshot())) as ReturnType<FeedBook['breakerSnapshot']>;
    expect(snap.yahoo).toEqual({ fails: 3, until: 1_000_000 + 2 * M, at: 1_000_000 });
    // the parent (fast candles, quotes) now pauses Yahoo too
    expect(parent.allow('yahoo')).toBe(true);
    parent.mergeBreakers(snap);
    expect(parent.allow('yahoo')).toBe(false);
    expect(parent.pausedUntil('yahoo')).toBe(1_000_000 + 2 * M);
    // a later success in the parent closes it — and an older open breaker merged afterwards does not reopen it
    tp += 30_000;
    parent.ok('yahoo-quotes', { items: 1 });
    expect(parent.allow('yahoo')).toBe(true);
    parent.mergeBreakers(snap);
    expect(parent.allow('yahoo')).toBe(true);
    // the reverse: the parent's open breaker reaches a fresh child (it used to start each hour closed)
    tp += 30_000;
    for (let i = 0; i < 3; i++) parent.fail('dk-quotes', new Error('down'));
    const fresh = new FeedBook(() => tp);
    fresh.mergeBreakers(parent.breakerSnapshot());
    expect(fresh.allow('dukascopy')).toBe(false);
    // a newer child failure streak beats the parent's older closed state
    tc = tp + 60_000;
    const c2 = new FeedBook(() => tc);
    for (let i = 0; i < 4; i++) c2.fail('oanda', new Error('x'));
    parent.ok('oanda');
    parent.mergeBreakers(c2.breakerSnapshot());
    expect(parent.pausedUntil('oanda')).toBe(tc + 4 * M);
  });

  it('garbage is ignored; feed states and their merge are unchanged', () => {
    const b = new FeedBook(() => 5);
    b.mergeBreakers(null);
    b.mergeBreakers(undefined);
    b.mergeBreakers({ yahoo: { fails: 3, until: Number.NaN, at: 9 }, cftc: undefined });
    expect(b.allow('yahoo')).toBe(true);
    expect(b.breakerSnapshot()).toEqual({});
    b.ok('cftc', { items: 3 });
    expect(Object.keys(b.snapshot())).toEqual(['cftc']); // breakers are not in the feed snapshot
  });
});

describe('v17 FINDING 5: the learner the parent keeps after a run in the child', () => {
  function childState(childLearned: Record<string, LearnKey>, childSig: string) {
    const child = new ForexLab(asRedis(new R()));
    child.importWorkerInput({ learned: { 'k:1h': lk('on') }, learnSig: 'FORK', chosenSig: '', heatActive: null });
    child.learned = childLearned;
    child.learnSig = childSig;
    child.dropped = ['lost:1h'];
    child.chosen = ['k:1h', 'tsmom:1h'];
    child.labOpen = { 'k:1h:EURUSD': 1, 'tsmom:1h:GBPUSD': 2 };
    child.logBot(['learner: k:1h → half size: 12 real trades', 'waited on EURUSD: news']);
    return deserialize(serialize(child.exportState())) as ReturnType<ForexLab['exportState']>;
  }

  it('keeps the parent learner when its states moved since the fork (an off key does not step back to half size)', async () => {
    const st = childState({ 'k:1h': lk('down') }, 'CHILD');
    const r = new R();
    const parent = new ForexLab(asRedis(r));
    parent.learned = { 'k:1h': lk('off') }; // the parent's fast-chart check switched it off while the child ran
    parent.learnSig = 'PARENT';
    parent.logBot(['learner: k:1h → off']);
    const t = parent.importState(st, 'FORK');
    expect(parent.learned['k:1h']!.state).toBe('off');
    expect(parent.learnSig).toBe('PARENT');
    expect(t).toEqual({ off: ['k:1h'], down: {} });
    // the learner-derived lists follow the parent's learner
    expect(parent.dropped).toEqual(['lost:1h', 'k:1h']);
    expect(parent.chosen).toEqual(['tsmom:1h']);
    expect(parent.labOpen).toEqual({ 'tsmom:1h:GBPUSD': 2 });
    // the child's stale "learner:" line is not repeated; its other lines still arrive
    const lines = parent.botLog.map((x) => x.e);
    expect(lines.filter((e) => e.startsWith('learner: '))).toEqual(['learner: k:1h → off']);
    expect(lines).toContain('waited on EURUSD: news');
    // the child wrote its older view to fx:learn → the parent writes its own again
    await Promise.resolve();
    expect((JSON.parse(r.m.get(FX_LEARN)!) as { keys: Record<string, LearnKey> }).keys['k:1h']!.state).toBe('off');
  });

  it('takes the child learner when the parent did not move since the fork (or no fork was recorded)', () => {
    for (const fork of ['FORK', null] as const) {
      const st = childState({ 'k:1h': lk('down') }, 'CHILD');
      const r = new R();
      const parent = new ForexLab(asRedis(r));
      parent.learned = { 'k:1h': lk('on') };
      parent.learnSig = fork === null ? 'whatever' : 'FORK';
      expect(parent.importState(st, fork)).toBeNull();
      expect(parent.learned['k:1h']!.state).toBe('down');
      expect(parent.learnSig).toBe('CHILD');
      expect(parent.dropped).toEqual(['lost:1h']);
      expect(parent.chosen).toEqual(['k:1h', 'tsmom:1h']);
      expect(parent.botLog.map((x) => x.e)).toContain('learner: k:1h → half size: 12 real trades');
      expect(r.m.has(FX_LEARN)).toBe(false); // the child already wrote it
    }
  });

  it('decision + tightening are pure and only ever tighten', () => {
    expect(learnerSource(null, 'x')).toBe('child');
    expect(learnerSource('a', 'a')).toBe('child');
    expect(learnerSource('a', 'b')).toBe('parent');
    const t = learnerTighten({ off: lk('off'), half: lk('down'), same: lk('down'), loose: lk('on') }, { off: lk('down'), half: lk('on'), same: lk('down'), loose: lk('off') });
    expect(t).toEqual({ off: ['off'], down: { half: 0.5 } });
    const tr = (strategy: string, sizeF: number): LabOpenTrade => ({ ref: `${strategy}:1h:EURUSD:1`, strategy, tf: '1h', pair: 'EURUSD', side: 1, entryT: 1, stop: 1, target: 2, chosen: true, sizeF });
    const out = { report: {} as never, botTrades: [tr('off', 1), tr('half', 1.15), tr('loose', 1)], pairsSeen: [], chosen: ['off', 'half', 'loose'].map((x) => `${x}:1h`), dropped: [], firing: { signals: 0, chosen: 0 } } as RunOutput;
    const o = tightenOut(out, { off: ['off:1h'], down: { 'half:1h': 0.5 } });
    expect(o.botTrades.map((x) => [x.strategy, x.chosen, x.sizeF])).toEqual([
      ['off', false, 1],
      ['half', true, 0.575],
      ['loose', true, 1],
    ]);
    expect(o.chosen).toEqual(['half:1h', 'loose:1h']);
    expect(o.dropped).toEqual(['off:1h']);
    expect(out.botTrades[0]!.chosen).toBe(true); // input untouched
  });
});

describe('v17 FINDING 9: a child that keeps failing sends the next runs inline', () => {
  it('pure: 2 failures in a row → the next runs inline, then the child again; a good run clears it', () => {
    let st = { ...NO_STREAK };
    expect(planLabRun(st)).toBe('worker');
    let a = afterLabRun(st, 'failed');
    expect(a.tripped).toBe(false);
    st = a.st;
    expect(planLabRun(st)).toBe('worker');
    st = afterLabRun(st, 'spawn').st; // could not start (that hour ran inline already): not counted
    expect(st.fails).toBe(1);
    a = afterLabRun(st, 'failed');
    expect(a.tripped).toBe(true);
    st = a.st;
    for (let i = 0; i < LAB_WORKER.inlineRuns; i++) {
      expect(planLabRun(st)).toBe('inline');
      st = afterLabRun(st, 'inline').st;
    }
    expect(planLabRun(st)).toBe('worker');
    a = afterLabRun(st, 'failed'); // the retry fails → straight back to inline
    expect(a.tripped).toBe(true);
    expect(planLabRun(a.st)).toBe('inline');
    expect(afterLabRun(a.st, 'ok').st).toEqual(NO_STREAK);
  });

  it('pure (v18.5): a heavy failure clears a light streak, earns the next child a bigger heap, and a second in a row goes inline', () => {
    let st = afterLabRun({ ...NO_STREAK }, 'failed').st;
    expect(st.fails).toBe(1);
    const h = afterLabRun(st, 'heavy');
    expect(h.tripped).toBe(false);
    st = h.st;
    expect(st.fails).toBe(0);
    expect(st.heavy).toBe(1);
    expect(planLabRun(st)).toBe('worker');
    expect(heapFor(st)).toBe(LAB_WORKER.heapMbRetry);
    expect(heapFor(NO_STREAK)).toBe(LAB_WORKER.heapMb);
    const h2 = afterLabRun(st, 'heavy');
    expect(h2.tripped).toBe(true);
    expect(planLabRun(h2.st)).toBe('inline');
    expect(afterLabRun(h2.st, 'ok').st).toEqual(NO_STREAK);
  });

  it('memoryError spots a heap error the child caught itself', () => {
    expect(memoryError('JavaScript heap out of memory')).toBe(true);
    expect(memoryError('Array buffer allocation failed')).toBe(true);
    expect(memoryError('Cannot read properties of undefined')).toBe(false);
  });

  describe('wired into ForexLab.run', () => {
    const prev = process.env.FX_LAB_WORKER;
    const fk = vi.mocked(forkLabRun);
    beforeEach(() => {
      process.env.FX_LAB_WORKER = 'on';
      fk.mockReset();
    });
    afterEach(() => {
      if (prev === undefined) delete process.env.FX_LAB_WORKER;
      else process.env.FX_LAB_WORKER = prev;
    });

    it('fails twice → the next run is inline, with a warning in the bot log; spawn failures still run inline', async () => {
      fk.mockResolvedValue({ kind: 'failed', error: 'could not clone the result', heavy: false } satisfies ForkOutcome);
      const lab = new ForexLab(asRedis(new R()));
      const inline = vi.fn(async () => null);
      lab.computeRun = inline;
      await expect(lab.run()).rejects.toThrow(/lab worker: could not clone/);
      await expect(lab.run()).rejects.toThrow(/lab worker: could not clone/);
      expect(fk).toHaveBeenCalledTimes(2);
      expect(lab.botLog[0]!.e).toMatch(/failed 2 times in a row .* the next 6 runs go in the main process/);
      await lab.run();
      expect(fk).toHaveBeenCalledTimes(2); // not forked
      expect(inline).toHaveBeenCalledTimes(1);
      expect(lab.lastError).toBeNull();
      for (let i = 1; i < LAB_WORKER.inlineRuns; i++) await lab.run();
      expect(inline).toHaveBeenCalledTimes(LAB_WORKER.inlineRuns);
      // then the child is tried again; it could not start → that hour inline, the streak unchanged
      fk.mockResolvedValue({ kind: 'spawn', error: 'ENOENT' });
      await lab.run();
      expect(fk).toHaveBeenCalledTimes(3);
      expect(inline).toHaveBeenCalledTimes(LAB_WORKER.inlineRuns + 1);
      expect(lab.workerStreak.fails).toBe(2);
    });

    it('heavy failures (out of memory / timed out): skipped once with more memory next, then the runs go inline (v18.5)', async () => {
      fk.mockResolvedValue({ kind: 'failed', error: 'killed (out of memory?)', heavy: true, breakers: { yahoo: { fails: 4, until: Date.now() + 8 * M, at: Date.now() + 1 } } } satisfies ForkOutcome);
      const lab = new ForexLab(asRedis(new R()));
      const inline = vi.fn(async () => null);
      lab.computeRun = inline;
      await expect(lab.run()).rejects.toThrow(/lab worker: killed/);
      expect(lab.workerStreak.heavy).toBe(1);
      expect(fk).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ heapMb: LAB_WORKER.heapMb }));
      await expect(lab.run()).rejects.toThrow(/lab worker: killed/);
      expect(fk).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ heapMb: LAB_WORKER.heapMbRetry }));
      expect(fk).toHaveBeenCalledTimes(2);
      expect(planLabRun(lab.workerStreak)).toBe('inline');
      await lab.run();
      expect(inline).toHaveBeenCalledTimes(1);
      // the failed child's open Yahoo breaker still pauses the parent's calls
      expect(feeds.allow('yahoo')).toBe(false);
    });

    it('a good child run clears the streak, carries the breakers both ways and keeps a moved parent learner', async () => {
      // the parent's Yahoo breaker is open → the child gets it
      for (let i = 0; i < 3; i++) feeds.fail('yahoo-quotes', new Error('x'));
      const childLab = new ForexLab(asRedis(new R()));
      childLab.learned = { 'k:1h': lk('down') };
      childLab.learnSig = 'CHILD';
      const state = childLab.exportState();
      const out = { report: { rows: [], at: 1 } as never, botTrades: [], pairsSeen: [], chosen: [], dropped: [], firing: { signals: 0, chosen: 0 }, noSync: true } as RunOutput;
      const lab = new ForexLab(asRedis(new R()));
      lab.learned = { 'k:1h': lk('on') };
      lab.learnSig = 'FORK';
      lab.workerStreak = { fails: 2, inlineLeft: 0 };
      const seen: { input?: WorkerInput } = {};
      fk.mockImplementation(async (_refresh, input) => {
        seen.input = input;
        lab.learned = { 'k:1h': lk('off') }; // the fast lab's botRecord moves the parent learner mid-run
        lab.learnSig = 'MOVED';
        return { kind: 'ok', res: { ok: true, out, state, feeds: {}, breakers: { dukascopy: { fails: 5, until: Date.now() + 10 * M, at: Date.now() + 1 } } } as Extract<WorkerResult, { ok: true }> };
      });
      await lab.run();
      expect(seen.input!.breakers!.yahoo!.until).toBeGreaterThan(Date.now());
      expect(seen.input!.learnSig).toBe('FORK');
      expect(feeds.allow('dukascopy')).toBe(false); // the child's open breaker pauses the parent's backup quotes
      expect(lab.workerStreak).toEqual(NO_STREAK);
      expect(lab.botLog.map((x) => x.e)).toContain('hourly test: its separate process works again');
      expect(lab.learned['k:1h']!.state).toBe('off');
      expect(lab.learnSig).toBe('MOVED');
      expect(lab.dropped).toContain('k:1h');
    });
  });
});

describe('v17 FINDING 11: the child process never lingers', () => {
  const worker = path.resolve('src/forex/lab-worker.ts');
  const spawnWorker = () =>
    fork(worker, [], {
      execArgv: ['--import', 'tsx'],
      env: { ...process.env, NODE_OPTIONS: '', REDIS_URL: 'redis://127.0.0.1:1', LOG_LEVEL: 'error' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });

  it('exits as soon as the parent drops the channel (before any run)', async () => {
    const c = spawnWorker();
    const code = await new Promise<number | string | null>((resolve) => {
      const kill = setTimeout(() => {
        c.kill('SIGKILL');
        resolve('lingered');
      }, 15_000);
      c.on('message', (m: { ready?: boolean }) => {
        if (m?.ready) c.disconnect();
      });
      c.on('exit', (cd, sig) => {
        clearTimeout(kill);
        resolve(cd ?? sig);
      });
    });
    expect(code).toBe(0);
  }, 30_000);

  it('a finished run still reports and exits by itself (here: a run that fails)', async () => {
    const c = spawnWorker();
    const res = await new Promise<{ msg: unknown; code: number | string | null }>((resolve) => {
      let msg: unknown = null;
      const kill = setTimeout(() => {
        c.kill('SIGKILL');
        resolve({ msg, code: 'lingered' });
      }, 20_000);
      c.on('message', (m: { ready?: boolean }) => {
        if (m?.ready) c.send({ cmd: 'run', refresh: false, input: null });
        else msg = m;
      });
      c.on('exit', (cd, sig) => {
        clearTimeout(kill);
        resolve({ msg, code: cd ?? sig });
      });
    });
    expect(res.msg).toMatchObject({ ok: false });
    expect(res.code).toBe(1);
  }, 30_000);
});
