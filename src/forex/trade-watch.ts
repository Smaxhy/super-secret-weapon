/**
 * v17.14 watching the open trades: puts together, for every open trade of either account, its live read (trade-read.ts,
 * from the newest 1-minute candles + the hourly lab's market read + the news calendar) and its newest AI read
 * (trade-ai.ts), and once a minute asks the AI for the trades that are due (a new trade, every 15 min, or sooner when the
 * live read turns serious). Display only — nothing here touches a trade.
 */
import { moduleLogger } from '../lib/logger';
import { marketClock, type CalEvent } from './calendar';
import type { MarketNow } from './lab';
import type { AccountView, AcctId, Practice, Quote } from './practice';
import { STRATEGIES, styleOf } from './strategies';
import { aiDue, FX_AI, type AiRead, type TradeAi, type TradeAiContext } from './trade-ai';
import { liveRead, type TradeRead } from './trade-read';
import { instrument } from './types';

const log = moduleLogger('forex-trade-watch');

type Pos = AccountView['positions'][number];
const digitsOf = (pair: string) => (pair.includes('JPY') ? 3 : pair === 'XAUUSD' ? 2 : pair === 'XAGUSD' ? 3 : 5);

export interface WatchSources {
  markets: () => readonly MarketNow[];
  news: (pair: string, now: number) => readonly CalEvent[];
}

/** One trade's live read + what the AI gets. Pure. */
export function readContext(acct: AcctId, p: Pos, q: Quote | undefined, m: MarketNow | undefined, news: readonly CalEvent[], now: number): { read: TradeRead; ctx: TradeAiContext } {
  const inst = instrument(p.pair);
  const pip = inst?.pip ?? 0.0001;
  const digits = digitsOf(p.pair);
  const label = inst?.label ?? p.pair;
  const st = p.strategy ? STRATEGIES.find((x) => x.id === p.strategy) ?? null : null;
  const strategy = st ? { name: st.name, desc: st.desc, style: styleOf(st) } : null;
  const bars = q?.bars ?? [];
  const read = liveRead({
    pos: p,
    bars,
    pip,
    digits,
    label,
    now,
    strategy,
    market: m ? { atrPips: m.atrPips, mtf: m.mtf, rsi: m.rsi, levels: m.drawings?.levels, lines: m.drawings?.lines, prevDay: m.drawings?.prevDay } : null,
    news,
  });
  const reach = (m?.atrPips ?? 0) * 2 * pip;
  const near = (x: number) => reach > 0 && Math.abs(x - p.px) <= reach;
  const levels: string[] = [];
  if (m?.drawings) {
    for (const l of m.drawings.levels) if (near(l.price)) levels.push(`${l.kind} ${l.price.toFixed(digits)} (${l.touches} touches)`);
    for (const l of m.drawings.lines) if (!l.broken && near(l.pNow)) levels.push(`${l.kind === 'support' ? 'rising support line' : 'falling resistance line'} now at ${l.pNow.toFixed(digits)}`);
    if (m.drawings.prevDay) {
      if (near(m.drawings.prevDay.h)) levels.push(`yesterday's high ${m.drawings.prevDay.h.toFixed(digits)}`);
      if (near(m.drawings.prevDay.l)) levels.push(`yesterday's low ${m.drawings.prevDay.l.toFixed(digits)}`);
    }
  }
  const ctx: TradeAiContext = {
    acct,
    posId: p.id,
    pair: p.pair,
    label,
    digits,
    side: p.side,
    entry: p.entry,
    px: p.px,
    stop: p.stop,
    target: p.target,
    openedAt: p.openedAt,
    strategy: st ? { name: st.name, desc: st.desc, chart: p.tf ?? null } : null,
    read,
    hourly: m?.bars ?? [],
    minute: bars,
    market: m ? { atrPips: m.atrPips, trend: m.mtf, rsi1h: m.rsi, strengthGap: m.strength?.gap ?? null, levels: levels.slice(0, 8) } : null,
    news,
    now,
  };
  return { read, ctx };
}

export interface TradeReadRow {
  id: string;
  pair: string;
  read: TradeRead;
  ai: AiRead | null;
}

export class TradeWatch {
  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Timeout | null = null;
  private busy = false;
  private askedAt = new Map<string, number>();

  constructor(private readonly practice: Pick<Practice, 'openNow'>, readonly ai: TradeAi, private readonly src: WatchSources) {}

  start(): void {
    this.first = setTimeout(() => void this.tick(), 20_000);
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.first.unref?.();
    this.timer.unref?.();
  }
  stop(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
  }

  private async build(acct: AcctId, now: number): Promise<Array<{ p: Pos; read: TradeRead; ctx: TradeAiContext }>> {
    const { positions, quotes } = await this.practice.openNow(acct);
    const markets = this.src.markets();
    return positions.map((p) => {
      const { read, ctx } = readContext(acct, p, quotes[p.pair], markets.find((x) => x.id === p.pair), this.src.news(p.pair, now), now);
      return { p, read, ctx };
    });
  }

  /** once a minute: an AI read for every open trade that is due (one at a time) */
  async tick(now = Date.now()): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    let asked = 0;
    try {
      const open = marketClock(now).open;
      if (!open || (await this.ai.capped(now))) return 0;
      for (const acct of ['bot', 'me'] as AcctId[]) {
        const items = await this.build(acct, now).catch((err: Error) => {
          log.warn({ acct, err: err.message }, 'trade watch: could not read the account');
          return [];
        });
        if (!items.length) continue;
        const prev = await this.ai.cachedMany(acct, items.map((x) => x.p.id));
        for (const it of items) {
          const why = aiDue(prev[it.p.id] ?? null, it.read.status, open, now);
          if (!why) continue;
          if (await this.ai.capped(now)) return asked;
          if (await this.ai.ask(it.ctx, why)) asked++;
        }
      }
      return asked;
    } finally {
      this.busy = false;
    }
  }

  /** every open trade of the account: its live read + newest AI read, and whether the AI reads are on */
  async reads(acct: AcctId, now = Date.now()): Promise<{ trades: TradeReadRow[]; ai: Awaited<ReturnType<TradeAi['status']>> }> {
    const items = await this.build(acct, now);
    const cached = await this.ai.cachedMany(acct, items.map((x) => x.p.id));
    return { trades: items.map((x) => ({ id: x.p.id, pair: x.p.pair, read: x.read, ai: cached[x.p.id] ?? null })), ai: await this.ai.status(now) };
  }

  /** the owner asked for a read now (≥ 60 s apart per trade; skips the hourly cap and the budget) */
  async askNow(acct: AcctId, id: string, now = Date.now()): Promise<{ ok: boolean; error?: string; ai?: AiRead | null }> {
    const key = `${acct}:${id}`;
    const last = this.askedAt.get(key) ?? 0;
    const cached = await this.ai.cached(acct, id);
    if (now - Math.max(last, cached?.at ?? 0) < FX_AI.askGapMs) return { ok: false, error: 'asked less than a minute ago', ai: cached };
    const it = (await this.build(acct, now)).find((x) => x.p.id === id);
    if (!it) return { ok: false, error: 'no open trade with that id' };
    const why = await this.ai.capped(now, true);
    if (why) return { ok: false, error: why, ai: cached };
    this.askedAt.set(key, now);
    const out = await this.ai.ask(it.ctx, 'asked');
    return out ? { ok: true, ai: out } : { ok: false, error: this.ai.lastError ?? 'the AI read failed', ai: cached };
  }
}
