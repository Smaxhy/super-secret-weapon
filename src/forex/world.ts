/**
 * v27.39 world events (owner: "Fincept Terminal scans everything — an oil tanker gets hit, war… anything that could move
 * the markets"; Fincept's own maritime / geopolitics screens call its paid server, so the idea is rebuilt here on free
 * feeds). World and energy news (Al Jazeera, BBC World, Guardian World, Middle East Eye, France 24, DW, UN News,
 * OilPrice) is read every 5 minutes next to the forex headlines but kept apart: only headlines that match a world-event
 * kind are kept, and they never feed the normal "big headline" pause (general world news names the US all day). A kind
 * raises an ALARM when its headlines suddenly pile up — 3+ in the last hour from 2+ sources and at least double its usual
 * hourly count — or at once on one critical headline (a tanker hit / seized, a strait closed, war declared, an invasion,
 * a nuclear strike). Each kind (+ the regions named) points at the markets it moves; while an alarm is on (until 45 min
 * after its last headline) the bots open no NEW trades there. Not graded — like the VIX brake it is a safety rule; every
 * alarm is recorded (`fx:world:hist`) so the lab can grade it once there is history. Pure, except `WorldWatch`.
 */

export type WorldKind = 'conflict' | 'energy' | 'shipping' | 'sanctions' | 'disaster' | 'cyber' | 'crash';

export const WORLD = {
  windowMin: 60,
  baseHours: 6,
  minHits: 3,
  minSources: 2,
  burstX: 2,
  holdMin: 45,
  keepDays: 3,
  maxItems: 400,
  histMax: 1000,
};

export const WORLD_LABEL: Record<WorldKind, string> = {
  conflict: 'war / military escalation',
  energy: 'oil & energy supply',
  shipping: 'shipping / tankers / straits',
  sanctions: 'sanctions & trade war',
  disaster: 'natural disaster',
  cyber: 'cyber attack',
  crash: 'market crash / bank stress',
};

const RISK = ['NDX', 'SPX', 'DJI', 'RUT', 'BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'LINK', 'AVAX'];
const HAVEN = ['JPY', 'CHF', 'XAU'];
const OIL = ['CAD', 'XAU', 'JPY', 'NDX', 'SPX', 'DJI', 'RUT'];
const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'LINK', 'AVAX'];

/** Each kind: what to look for in a title, the markets it moves, and the words that make ONE headline enough. */
export const WORLD_RULES: Record<WorldKind, { re: RegExp; markets: string[]; critical?: RegExp }> = {
  conflict: {
    re: /\b(war|missiles?|airstrikes?|air strikes?|invasion|invades?|troops|drone strikes?|shelling|bombing|military (strike|action|escalation)|escalat\w*|retaliat\w*|nuclear|ceasefire collapses?|declares? war)\b/i,
    markets: [...HAVEN, ...RISK],
    critical: /\b(declares? war|invasion|invades|nuclear (strike|attack|test)|all-out war|missile strikes? on)\b/i,
  },
  energy: {
    re: /\b(oil (supply|output|production|field|facility|facilities|terminal|exports?)|refiner(y|ies)|pipelines?|opec\+?|crude (surges?|spikes?|jumps?|soars?)|oil (surges?|spikes?|jumps?|soars?|price spike)|gas field|lng (plant|terminal)|energy (crisis|facility|infrastructure))\b/i,
    markets: OIL,
    critical: /\b(refinery (hit|attacked|ablaze|on fire)|oil (field|facility|terminal) (hit|attacked)|pipeline (blown|sabotag\w*|attacked)|opec\+? (emergency|surprise) cut)\b/i,
  },
  shipping: {
    re: /\b(tankers?|strait of hormuz|hormuz|red sea|houthis?|suez|bab[- ]el[- ]mandeb|shipping lanes?|cargo ships?|container ships?|vessels? (attacked|seized|hit|struck)|maritime|naval blockade|blockade)\b/i,
    markets: OIL,
    critical: /\b(tankers? (hit|attacked|struck|seized|ablaze|sinks?|sunk)|(seizes?|seized|hits?|attacks?|attacked|strikes?|struck) (an? |the )?(oil |gas |lng )?tankers?|(strait|hormuz|suez|red sea)\b.{0,40}\b(closed|closure|blocked|shut)|naval blockade)\b/i,
  },
  sanctions: {
    re: /\b(sanctions?|embargo|export bans?|trade war|tariffs?|retaliatory tariffs?)\b/i,
    markets: ['USD', 'NDX', 'SPX', 'DJI', 'RUT'],
  },
  disaster: {
    re: /\b(earthquake|tsunami|hurricane|typhoon|cyclone|volcan\w*|pandemic|outbreak)\b/i,
    markets: [],
    critical: /\b(magnitude [7-9](\.\d)?|category [45] hurricane|tsunami warning)\b/i,
  },
  cyber: {
    re: /\b(cyber ?attacks?|ransomware|hacked|hackers|data breach|stolen funds?|funds drained)\b/i,
    markets: [],
  },
  crash: {
    re: /\b(flash crash|circuit breakers?|trading halt(ed)?|bank runs?|bank (collapse|failure)|defaults? on (its )?debt|liquidity crisis|margin calls?)\b/i,
    markets: [...HAVEN, ...RISK],
  },
};

/** Regions named in a headline → the markets they add (whatever the kind). */
const REGIONS: Array<[RegExp, string[]]> = [
  [/\b(iran|israel|gaza|lebanon|hezbollah|saudi|iraq|yemen|middle east|gulf|qatar|uae)\b/i, ['CAD', 'XAU', 'JPY']],
  [/\b(russia|ukraine|kremlin|moscow|kyiv|poland|nato)\b/i, ['EUR', 'CHF', 'XAU']],
  [/\b(china|taiwan|beijing|south china sea)\b/i, ['AUD', 'NZD', 'JPY']],
  [/\b(north korea|pyongyang|korea)\b/i, ['JPY']],
  [/\b(japan|tokyo)\b/i, ['JPY']],
  [/\b(venezuela|libya|nigeria)\b/i, ['CAD']],
  [/\b(crypto|bitcoin|exchange|defi|stablecoin|binance|coinbase)\b/i, COINS],
  [/\b(united states|u\.s\.|washington|white house|pentagon)\b/i, ['USD']],
  [/\b(europe|eu|eurozone|germany|france)\b/i, ['EUR']],
  [/\b(britain|uk|london)\b/i, ['GBP']],
  [/\b(canada)\b/i, ['CAD']],
  [/\b(australia)\b/i, ['AUD']],
];

export interface WorldItem {
  t: number;
  title: string;
  link: string;
  source: string;
  kinds: WorldKind[];
  markets: string[];
  critical: boolean;
}

/** Which world-event kinds a headline is, the markets it points at, and whether it is critical on its own. Pure. */
export function worldTag(title: string): { kinds: WorldKind[]; markets: string[]; critical: boolean } {
  const kinds = (Object.keys(WORLD_RULES) as WorldKind[]).filter((k) => WORLD_RULES[k].re.test(title));
  if (!kinds.length) return { kinds, markets: [], critical: false };
  const m = new Set<string>();
  for (const k of kinds) for (const x of WORLD_RULES[k].markets) m.add(x);
  for (const [re, xs] of REGIONS) if (re.test(title)) for (const x of xs) m.add(x);
  const critical = kinds.some((k) => WORLD_RULES[k].critical?.test(title));
  return { kinds, markets: [...m], critical };
}

export interface WorldAlarm {
  kind: WorldKind;
  label: string;
  /** first headline of the burst, newest headline, and the moment the pause ends */
  startedAt: number;
  lastAt: number;
  until: number;
  critical: boolean;
  count: number;
  sources: number;
  /** baseline: headlines an hour of this kind over the hours before */
  usualPerHour: number;
  markets: string[];
  headlines: Array<{ t: number; title: string; source: string; link: string }>;
}

/** The alarms on at `now` (and ended ones in the last `lookbackH` hours, for display). Pure. */
export function worldAlarms(items: readonly WorldItem[], now: number, lookbackH = 6): WorldAlarm[] {
  const out: WorldAlarm[] = [];
  const win = WORLD.windowMin * 60_000;
  for (const kind of Object.keys(WORLD_RULES) as WorldKind[]) {
    const mine = items.filter((x) => x.kinds.includes(kind) && x.t <= now + 60_000 && now - x.t <= lookbackH * 3_600_000 + win).sort((a, b) => a.t - b.t);
    if (!mine.length) continue;
    // walk the headlines; an alarm starts at the first headline where the rule fires and lasts while headlines keep coming
    let cur: WorldAlarm | null = null;
    for (let i = 0; i < mine.length; i++) {
      const x = mine[i]!;
      const inWin = mine.filter((y) => y.t <= x.t && x.t - y.t < win);
      const before = items.filter((y) => y.kinds.includes(kind) && y.t <= x.t - win && x.t - win - y.t < WORLD.baseHours * 3_600_000).length;
      const usual = before / WORLD.baseHours;
      const sources = new Set(inWin.map((y) => y.source)).size;
      const burst = inWin.length >= WORLD.minHits && sources >= WORLD.minSources && inWin.length >= WORLD.burstX * Math.max(1, usual);
      if (cur && x.t <= cur.until) {
        // still going: extend it
        // a headline only keeps the alarm going while the flow is still unusual (or it is critical itself) — a steady
        // stream that has become the norm lets it end 45 min after the last unusual headline
        if (!(burst || x.critical)) continue;
        cur.lastAt = x.t;
        cur.until = x.t + WORLD.holdMin * 60_000;
        cur.critical ||= x.critical;
        cur.headlines.push({ t: x.t, title: x.title, source: x.source, link: x.link });
        for (const mk of x.markets) if (!cur.markets.includes(mk)) cur.markets.push(mk);
        continue;
      }
      if (!(burst || x.critical)) continue;
      if (cur) out.push(cur);
      const first = burst ? inWin : [x];
      cur = {
        kind,
        label: WORLD_LABEL[kind],
        startedAt: first[0]!.t,
        lastAt: x.t,
        until: x.t + WORLD.holdMin * 60_000,
        critical: first.some((y) => y.critical),
        count: 0,
        sources: 0,
        usualPerHour: Math.round(usual * 10) / 10,
        markets: [...new Set(first.flatMap((y) => y.markets))],
        headlines: first.map((y) => ({ t: y.t, title: y.title, source: y.source, link: y.link })),
      };
    }
    if (cur) out.push(cur);
  }
  for (const a of out) {
    a.count = a.headlines.length;
    a.sources = new Set(a.headlines.map((h) => h.source)).size;
    a.headlines = a.headlines.sort((x, y) => y.t - x.t).slice(0, 6);
  }
  return out.filter((a) => a.until >= now - lookbackH * 3_600_000).sort((a, b) => b.lastAt - a.lastAt);
}

/** The tags a market answers to (EURUSD → EUR + USD; XAGUSD → XAU + USD; DOGEUSD → DOGE + USD; NDXUSD → NDX + USD). Pure. */
export function marketTags(pair: string): string[] {
  if (pair.startsWith('XA')) return ['XAU', 'USD'];
  if (pair.length > 6 || /^(NDX|SPX|DJI|RUT|BTC|ETH|SOL|XRP|ADA)USD$/.test(pair)) return [pair.slice(0, -3), 'USD'];
  return [pair.slice(0, 3), pair.slice(3, 6)];
}

/** Why a NEW trade on `pair` waits because of a world-event alarm (null = it doesn't). Pure. */
export function worldBlock(pair: string, now: number, alarms: readonly WorldAlarm[]): string | null {
  const tags = marketTags(pair);
  for (const a of alarms) {
    if (a.startedAt > now + 60_000 || now > a.until) continue;
    if (!a.markets.some((m) => tags.includes(m))) continue;
    return `world event (${a.label}${a.critical ? ', critical' : ''}): ${a.headlines[0]?.title.slice(0, 80) ?? ''}`;
  }
  return null;
}

/** Merge fresh world items into the stored list: one per title, newest first, `keepDays`, `maxItems`. Pure. */
export function mergeWorld(fresh: readonly WorldItem[], have: readonly WorldItem[], now: number): WorldItem[] {
  const seen = new Set<string>();
  return [...fresh, ...have]
    .filter((x) => {
      const k = x.title.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return now - x.t < WORLD.keepDays * 86_400_000;
    })
    .sort((a, b) => b.t - a.t)
    .slice(0, WORLD.maxItems);
}
