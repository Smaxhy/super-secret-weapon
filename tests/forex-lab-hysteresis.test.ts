import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import { serialize, deserialize } from 'node:v8';
import { chooseFilter } from '../src/forex/filters';
import { ForexLab, FX_CHOSEN_HIST, FX_REPORT, PICK_LINE_SLACK_MS, prevPicks, statsOf, type ChosenStore, type RunOutput, type WorkerResult } from '../src/forex/lab';
import { forkLabRun, tightenMarkets, tightenOut } from '../src/forex/lab-runner';
import type { LearnKey } from '../src/forex/learner';
import type { Trade } from '../src/forex/types';

vi.mock('../src/forex/lab-runner', async (orig) => {
  const m = await orig<typeof import('../src/forex/lab-runner')>();
  return { ...m, forkLabRun: vi.fn() };
});

const DAY = 86_400_000;

class R {
  m = new Map<string, string>();
  h = new Map<string, Record<string, string>>();
  lists = new Map<string, string[]>();
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
  async lpush(k: string, v: string) {
    const l = this.lists.get(k) ?? [];
    l.unshift(v);
    this.lists.set(k, l);
    return l.length;
  }
  async ltrim(k: string, a: number, b: number) {
    this.lists.set(k, (this.lists.get(k) ?? []).slice(a, b + 1));
    return 'OK';
  }
}
const asRedis = (r: R) => r as unknown as Redis;
const hist = (r: R) => (r.lists.get(FX_CHOSEN_HIST) ?? []).map((x) => (JSON.parse(x) as { keys: string[] }).keys);
const lk = (state: LearnKey['state']): LearnKey => ({ n: 12, meanR: state === 'on' ? 0.2 : -0.3, pPos: state === 'off' ? 0.1 : 0.7, state, sizeF: state === 'off' ? 0 : 1, why: state });
/** the private chosen-history writer */
const note = (lab: ForexLab, keys: string[]) => (lab as unknown as { noteChosen(c: ReadonlySet<string>): Promise<void> }).noteChosen(new Set(keys));

describe('v17.8 FINDING C: last run\'s picks only count while the 70/30 line has not moved back', () => {
  const line = 700 * DAY;
  const store: ChosenStore = { oosFrom: line, picks: { 'a:1h': { f: 'strength', e: 'trail_tp' }, 'a:4h': { f: 'mtf', e: 'designed' } } };
  const raw = JSON.stringify(store);

  it('kept after a forward move / no move / a move back of up to a day; dropped after a bigger move back', () => {
    expect(prevPicks(raw, '1h', line)).toEqual({ 'a:1h': { f: 'strength', e: 'trail_tp' } });
    expect(prevPicks(raw, '4h', line)).toEqual({ 'a:4h': { f: 'mtf', e: 'designed' } });
    expect(prevPicks(raw, '1h', line + 5 * DAY)).toEqual({ 'a:1h': { f: 'strength', e: 'trail_tp' } }); // forward: harmless
    expect(prevPicks(raw, '1h', line - 0.5 * DAY)).toEqual({ 'a:1h': { f: 'strength', e: 'trail_tp' } });
    expect(prevPicks(raw, '1h', line - PICK_LINE_SLACK_MS)).toEqual({ 'a:1h': { f: 'strength', e: 'trail_tp' } });
    expect(prevPicks(raw, '1h', line - PICK_LINE_SLACK_MS - 60_000)).toEqual({});
    expect(prevPicks(raw, '1h', line - 111 * DAY)).toEqual({}); // the Dukascopy back-fill landing
    expect(prevPicks(raw, '1h', Number.NaN)).toEqual({});
  });

  it('per chart: each chart is judged by its own line (15m / 1m)', () => {
    const fast = JSON.stringify({ oosFrom: { '15m': 50 * DAY, '1m': 20 * DAY }, picks: { 's:15m': { f: 'regime', e: 'designed' }, 's:1m': { f: 'none', e: 'quick' } } } satisfies ChosenStore);
    expect(prevPicks(fast, '15m', 30 * DAY)).toEqual({}); // its line moved back 20 days
    expect(prevPicks(fast, '1m', 20 * DAY + 3_600_000)).toEqual({ 's:1m': { f: 'none', e: 'quick' } });
    expect(prevPicks(fast, '15m', 50 * DAY)).toEqual({ 's:15m': { f: 'regime', e: 'designed' } }); // ':1m' never matches ':15m'
    expect(prevPicks(JSON.stringify({ oosFrom: { '15m': 50 * DAY }, picks: { 's:1m': { f: 'none' } } }), '1m', 20 * DAY)).toEqual({}); // no line for that chart
  });

  it('the old unstamped format and garbage are ignored without throwing (one re-pick after the deploy)', () => {
    const old = JSON.stringify({ 'a:1h': 'strength', 'b:1h': { f: 'mtf', e: 'designed' } });
    for (const tf of ['1h', '4h']) expect(prevPicks(old, tf, line)).toEqual({});
    for (const g of [null, undefined, '', 'not json', 'null', '[]', '"x"', '42', '{"oosFrom":"5","picks":{"a:1h":{"f":"mtf"}}}', '{"oosFrom":5}', '{"oosFrom":5,"picks":{"a:1h":null,"b:1h":7}}']) {
      expect(() => prevPicks(g, '1h', 5)).not.toThrow();
      expect(prevPicks(g, '1h', 5)).toEqual({});
    }
    // a pick with odd fields keeps only what it can
    expect(prevPicks(JSON.stringify({ oosFrom: 5, picks: { 'a:1h': { f: 'mtf', e: 3 } } }), '1h', 5)).toEqual({ 'a:1h': { f: 'mtf' } });
  });

  it('end to end with the chooser: after a big move back the pick is the one the new first 70% supports', () => {
    // 'strength' looked better while days 589…700 were in-sample; on the new line those days are unseen
    const mk = (segs: Array<[number, number, number]>): Trade[] => {
      const out: Trade[] = [];
      for (const [d0, d1, r] of segs) for (let d = d0; d < d1; d++) out.push({ strategy: 's', tf: '1h', pair: 'EURUSD', side: 1, entryT: d * DAY, exitT: d * DAY + 3_600_000, entry: 1, exit: 1, r: r + (d % 2 === 0 ? 0.8 : -0.8), stopPct: 0.5, reason: 'stop', bars: 1, stop: 1, stop0: 1, target: null } as Trade);
      return out;
    };
    const now = 1000;
    const sets = { none: mk([[-370, now, 0]]), strength: mk([[-370, 589, 0.1], [589, 700, 0.5], [700, now, 0]]), mtf: mk([[-370, 589, 0.108], [589, now, 0]]) };
    const pick = (fromDay: number, prev: Record<string, { f?: string }>) => {
      const oos = (fromDay + 0.7 * (now - fromDay)) * DAY;
      const st = (Object.keys(sets) as Array<keyof typeof sets>).map((k) => ({ filter: k, ...statsOf(sets[k].filter((t) => t.entryT >= fromDay * DAY), oos) }));
      return { oos, f: chooseFilter(st, 40, prev['s:1h']?.f as never) };
    };
    const before = pick(0, {});
    expect(before.f).toBe('strength');
    const stored = JSON.stringify({ oosFrom: before.oos, picks: { 's:1h': { f: before.f } } });
    const backfilled = (pick(-370, {}).oos - before.oos) / DAY;
    expect(backfilled).toBeLessThan(-100);
    // the stored pick no longer steers it (it would have, through the near-tie)
    expect(pick(-370, { 's:1h': { f: 'strength' } }).f).toBe('strength');
    expect(pick(-370, prevPicks(stored, '1h', pick(-370, {}).oos)).f).toBe('mtf');
    // an hour later on the same history the line only moves forward: the pick is kept
    const later = JSON.stringify({ oosFrom: before.oos - 3_600_000, picks: { 's:1h': { f: before.f } } });
    expect(prevPicks(later, '1h', before.oos)).toEqual({ 's:1h': { f: 'strength' } });
  });
});

describe('v17.8 FINDING D: a run in the child — the chosen list the bot actually uses is what gets recorded', () => {
  type Firing = { id: string; name: string; tf: '1h' | '4h'; side: 1 | -1; allowed: boolean; why: string | null; chosen?: boolean };
  const market = (firing: Firing[]) => ({ id: 'EURUSD', label: 'EUR/USD', firing }) as never;
  const fire = (id: string, allowed = true): Firing => ({ id, name: id, tf: '1h', side: 1, allowed, why: allowed ? null : 'x', chosen: true });

  it('pure: off keys\' signals lose the chosen flag and the count follows; nothing to flip → the same objects', () => {
    const ms = [market([fire('k'), fire('tsmom'), fire('k', false)])] as Array<{ firing: Firing[] }>;
    const t = tightenMarkets(ms, new Set(['k:1h']));
    expect(t[0]!.firing.map((f) => [f.id, f.chosen])).toEqual([['k', false], ['tsmom', true], ['k', false]]);
    expect(ms[0]!.firing[0]!.chosen).toBe(true); // input untouched
    expect(tightenMarkets(ms, new Set(['other:1h']))).toBe(ms);
    const out = { report: { rows: [], at: 1, markets: ms }, botTrades: [], pairsSeen: [], chosen: ['k:1h', 'tsmom:1h'], dropped: [], firing: { signals: 3, chosen: 2 } } as unknown as RunOutput;
    const o = tightenOut(out, { off: ['k:1h'], down: {} });
    expect(o.firing).toEqual({ signals: 3, chosen: 1 });
    expect(o.report.markets[0]!.firing.filter((f) => f.chosen).map((f) => f.id)).toEqual(['tsmom']);
    expect(o.report).not.toBe(out.report);
    const same = tightenOut(out, { off: ['other:1h'], down: {} });
    expect(same.report).toBe(out.report);
    expect(same.firing).toBe(out.firing);
    // a report without markets (a test stub, an empty run) doesn't crash
    expect(tightenOut({ ...out, report: {} as never }, { off: ['k:1h'], down: {} }).firing).toEqual({ signals: 3, chosen: 2 });
  });

  it('the child never writes the history itself; the parent (and the inline run) do, deduped', async () => {
    const rc = new R();
    const child = new ForexLab(asRedis(rc));
    child.importWorkerInput({ learned: {}, learnSig: 's', chosenSig: '', heatActive: null });
    await note(child, ['k:1h']);
    expect(hist(rc)).toEqual([]);
    expect(child.chosenSig).toBe('');
    const rp = new R();
    const inline = new ForexLab(asRedis(rp));
    await note(inline, ['k:1h', 'a:4h']);
    await note(inline, ['a:4h', 'k:1h']);
    expect(hist(rp)).toEqual([['a:4h', 'k:1h']]);
  });

  describe('wired into ForexLab.run (FX_LAB_WORKER=on)', () => {
    const prevEnv = process.env.FX_LAB_WORKER;
    const fk = vi.mocked(forkLabRun);
    beforeEach(() => {
      process.env.FX_LAB_WORKER = 'on';
      fk.mockReset();
    });
    afterEach(() => {
      if (prevEnv === undefined) delete process.env.FX_LAB_WORKER;
      else process.env.FX_LAB_WORKER = prevEnv;
    });

    function childResult(childR: R) {
      const child = new ForexLab(asRedis(childR));
      child.importWorkerInput({ learned: { 'k:1h': lk('on') }, learnSig: 'FORK', chosenSig: 'k:1h,tsmom:1h', heatActive: null });
      child.learned = { 'k:1h': lk('on') };
      child.learnSig = 'CHILD';
      child.chosen = ['k:1h', 'tsmom:1h'];
      const markets = [market([fire('k'), fire('tsmom')])];
      child.marketsNow = markets;
      const out = { report: { rows: [], at: 1, markets } as never, botTrades: [], pairsSeen: [], chosen: ['k:1h', 'tsmom:1h'], dropped: [], firing: { signals: 2, chosen: 2 } } as RunOutput;
      // one structured clone, like the IPC message (shared references survive it)
      return deserialize(serialize({ ok: true, out, state: child.exportState(), feeds: {} })) as Extract<WorkerResult, { ok: true }>;
    }

    it('the parent\'s learner switched a key off mid-run → the history, the report and the count leave it out', async () => {
      const r = new R();
      const lab = new ForexLab(asRedis(r));
      lab.learned = { 'k:1h': lk('on') };
      lab.learnSig = 'FORK';
      lab.chosenSig = 'k:1h,tsmom:1h'; // last hour's list
      const res = childResult(new R());
      fk.mockImplementation(async () => {
        lab.learned = { 'k:1h': lk('off') }; // the fast lab's botRecord switched it off while the child ran
        lab.learnSig = 'MOVED';
        return { kind: 'ok', res };
      });
      const rep = await lab.run();
      expect(lab.chosen).toEqual(['tsmom:1h']);
      expect(hist(r)).toEqual([['tsmom:1h']]);
      expect(lab.chosenSig).toBe('tsmom:1h');
      expect(rep!.markets[0]!.firing.map((f) => [f.id, f.chosen])).toEqual([['k', false], ['tsmom', true]]);
      expect(lab.marketsNow[0]!.firing.map((f) => [f.id, f.chosen])).toEqual([['k', false], ['tsmom', true]]);
      const stored = JSON.parse(r.m.get(FX_REPORT)!) as { markets: Array<{ firing: Firing[] }> };
      expect(stored.markets[0]!.firing.find((f) => f.id === 'k')!.chosen).toBe(false);
    });

    it('no tightening → the child\'s list is recorded once by the parent (and not again next hour)', async () => {
      const r = new R();
      const lab = new ForexLab(asRedis(r));
      lab.learned = { 'k:1h': lk('on') };
      lab.learnSig = 'FORK';
      lab.chosenSig = 'old:1h';
      const childR = new R();
      fk.mockImplementation(async () => ({ kind: 'ok', res: childResult(childR) }));
      await lab.run();
      await lab.run();
      expect(hist(r)).toEqual([['k:1h', 'tsmom:1h']]);
      expect(hist(childR)).toEqual([]);
      expect(lab.chosenSig).toBe('k:1h,tsmom:1h');
      expect(r.m.has(FX_REPORT)).toBe(false); // nothing flipped: the child's report stands
    });
  });
});
