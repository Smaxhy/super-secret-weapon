/**
 * OANDA v20 (v12.1): broker-grade forex data — live bid / ask and candles from 5 s to daily. Free with an OANDA
 * fxTrade PRACTICE (demo) account: the owner pastes the API token + account id on Forex → Setup. Stored only in
 * this server's DB (BotConfig `_oanda`), never in git; the API shows a masked token. When missing, Yahoo is used.
 */
import { prisma } from '../lib/prisma';
import { moduleLogger } from '../lib/logger';
import { instrument, type Bar } from './types';

const log = moduleLogger('oanda');
export const OANDA_KEY = '_oanda';

export interface OandaSettings {
  token?: string | null;
  accountId?: string | null;
  env?: 'practice' | 'live';
  updatedAt?: string;
}

let cached: { s: OandaSettings; at: number } | null = null;

export async function loadOanda(): Promise<OandaSettings> {
  if (cached && Date.now() - cached.at < 30_000) return cached.s;
  try {
    const row = await prisma.botConfig.findUnique({ where: { key: OANDA_KEY } });
    const s = (row?.value as OandaSettings | null) ?? {};
    cached = { s, at: Date.now() };
    return s;
  } catch {
    return {};
  }
}

export async function saveOanda(s: OandaSettings): Promise<void> {
  await prisma.botConfig.upsert({ where: { key: OANDA_KEY }, update: { value: s as object }, create: { key: OANDA_KEY, value: s as object } });
  cached = { s, at: Date.now() };
}

export const oandaReady = (s: OandaSettings) => !!(s.token && s.accountId);
export const maskToken = (t: string | null | undefined) => (t ? `${t.slice(0, 4)}…${t.slice(-4)}` : null);
/** v27.47: OANDA's own names for markets whose id isn't base_quote (US stock indices are CFDs there). */
const OANDA_NAMES: Record<string, string> = { NDXUSD: 'NAS100_USD', SPXUSD: 'SPX500_USD', DJIUSD: 'US30_USD', RUTUSD: 'US2000_USD' };
const FROM_OANDA = Object.fromEntries(Object.entries(OANDA_NAMES).map(([k, v]) => [v, k]));
/** EURUSD → EUR_USD, XAUUSD → XAU_USD, NDXUSD → NAS100_USD; coins → null (Coinbase prices them, live and free). */
export function toOanda(id: string): string | null {
  const inst = instrument(id);
  if (!inst || inst.kind === 'crypto') return null;
  return OANDA_NAMES[id] ?? `${id.slice(0, 3)}_${id.slice(3)}`;
}
export const fromOanda = (sym: string) => FROM_OANDA[sym] ?? sym.replace('_', '');
/** v27.47: markets this OANDA account refused (not offered in its region) — skipped for 6 h, so one bad name never
 * fails the whole price request again */
const unavailable = new Map<string, number>();
export const oandaCovers = (id: string, now = Date.now()) => toOanda(id) !== null && (unavailable.get(id) ?? 0) <= now;
const host = (s: OandaSettings) => (s.env === 'live' ? 'https://api-fxtrade.oanda.com' : 'https://api-fxpractice.oanda.com');

async function get<T>(s: OandaSettings, path: string): Promise<T> {
  const res = await fetch(`${host(s)}${path}`, { headers: { authorization: `Bearer ${s.token}`, 'accept-datetime-format': 'UNIX' }, signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`OANDA HTTP ${res.status}${res.status === 401 ? ' (token wrong?)' : ''}`);
  return (await res.json()) as T;
}

export interface OandaPrice {
  id: string;
  bid: number;
  ask: number;
  t: number;
  tradeable: boolean;
}

/** Live bid / ask for many instruments in one call. */
export async function oandaPrices(s: OandaSettings, ids: readonly string[]): Promise<OandaPrice[]> {
  const want = ids.filter((id) => oandaCovers(id));
  if (!want.length) return [];
  const one = async (xs: readonly string[]) => {
    const j = await get<{ prices?: Array<{ instrument: string; time: string; tradeable?: boolean; bids?: Array<{ price: string }>; asks?: Array<{ price: string }> }> }>(s, `/v3/accounts/${s.accountId}/pricing?instruments=${xs.map((x) => toOanda(x)!).join(',')}`);
    return (j.prices ?? [])
      .map((p) => ({ id: fromOanda(p.instrument), bid: Number(p.bids?.[0]?.price), ask: Number(p.asks?.[0]?.price), t: Math.round(Number(p.time) * 1000), tradeable: p.tradeable !== false }))
      .filter((p) => p.bid > 0 && p.ask > 0);
  };
  try {
    return await one(want);
  } catch (err) {
    // HTTP 400 = a name this account can't price: find it (one call each), skip it for 6 h, keep the rest
    if (!/HTTP 400/.test((err as Error).message) || want.length === 1) throw err;
    const out: OandaPrice[] = [];
    for (const id of want) {
      try {
        out.push(...(await one([id])));
      } catch (e) {
        if (/HTTP 400/.test((e as Error).message)) {
          unavailable.set(id, Date.now() + 6 * 3_600_000);
          log.warn({ id }, 'OANDA does not price this market for this account — Yahoo keeps it');
        } else throw e;
      }
    }
    return out;
  }
}

export type Granularity = 'S5' | 'M1' | 'M5' | 'M15' | 'H1' | 'H4' | 'D';

/** Candles (mid prices). Includes the still-forming last candle (flag `complete`). v15: `to` (ms) pages back in time. */
export async function oandaCandles(s: OandaSettings, id: string, g: Granularity, count = 300, to?: number): Promise<Array<Bar & { v: number; complete: boolean }>> {
  const sym = toOanda(id);
  if (!sym) throw new Error(`OANDA has no ${id}`);
  const j = await get<{ candles?: Array<{ time: string; volume: number; complete: boolean; mid?: { o: string; h: string; l: string; c: string } }> }>(s, `/v3/instruments/${sym}/candles?granularity=${g}&count=${Math.min(5000, count)}&price=M${to ? `&to=${Math.floor(to / 1000)}` : ''}`);
  return (j.candles ?? []).filter((c) => c.mid).map((c) => ({ t: Math.round(Number(c.time) * 1000), o: Number(c.mid!.o), h: Number(c.mid!.h), l: Number(c.mid!.l), c: Number(c.mid!.c), v: c.volume, complete: c.complete }));
}

/** Check a pasted token / account: one pricing call. */
export async function testOanda(s: OandaSettings): Promise<{ ok: boolean; error?: string }> {
  try {
    const p = await oandaPrices(s, ['EURUSD']);
    return p.length ? { ok: true } : { ok: false, error: 'no price returned' };
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'oanda test failed');
    return { ok: false, error: (err as Error).message };
  }
}
