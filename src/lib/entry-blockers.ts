/**
 * "Why isn't it trading?" — counts, per minute for the last hour, why coins were skipped
 * (rule fails / score under the bar, from the evaluator and the swing trader) and why buy
 * signals were refused by the trader (breakers, limits, size, rug screen…). In memory only;
 * `blockerSnapshot()` is shown on the dashboard (/api/system → Bot health).
 *
 * Also drives the drought rule: no entry for `explore.droughtMinutes` → learning trades take
 * coins a little further under the bar (`explore.droughtScoreMargin`) so the bot keeps learning.
 */

type Kind = 'skip' | 'refuse';
interface Minute {
  at: number;
  skip: Map<string, number>;
  refuse: Map<string, number>;
  evaluated: number;
  signals: number;
  entries: number;
  funnel: Map<string, Funnel>;
}

/**
 * Per-strategy funnel (v10.33, owner: "I don't know if any strategies are being implemented"): how far each strategy's
 * coins got in the last hour — checked → passed every rule → buy signal (score over the bar) → then held back (dip wait /
 * confirming / didn't confirm / other) or handed to the trader → refused / bought. Dip watches that gave up count too.
 */
export const FUNNEL_STAGES = ['checked', 'rulesOk', 'signal', 'dipWait', 'confirming', 'notConfirmed', 'heldBack', 'toTrader', 'refused', 'bought', 'dipGaveUp'] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];
export type Funnel = Record<FunnelStage, number>;
const emptyFunnel = (): Funnel => Object.fromEntries(FUNNEL_STAGES.map((k) => [k, 0])) as Funnel;

const WINDOW_MIN = 60;
const minutes: Minute[] = [];
let lastEntryAt: number | null = null;
let startedAt = Date.now();

function bucket(now: number): Minute {
  const at = Math.floor(now / 60_000) * 60_000;
  let m = minutes[minutes.length - 1];
  if (!m || m.at !== at) {
    m = { at, skip: new Map(), refuse: new Map(), evaluated: 0, signals: 0, entries: 0, funnel: new Map() };
    minutes.push(m);
    while (minutes.length && minutes[0]!.at <= at - WINDOW_MIN * 60_000) minutes.shift();
  }
  return m;
}

/** Numbers vary per coin — group "top 10 hold 54%" and "top 10 hold 61%" together. */
export function normaliseReason(reason: string): string {
  return reason
    .replace(/\(.*?\)/g, '')
    .replace(/[-+−]?\$?\d+(?:[.,]\d+)*\s*[kKmM%x×]?/g, '#')
    .replace(/(?:#\s*)+/g, '# ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function add(kind: Kind, strategy: string, reason: string, now: number): void {
  const m = bucket(now);
  const key = `${strategy}: ${normaliseReason(reason)}`;
  const map = kind === 'skip' ? m.skip : m.refuse;
  if (map.size < 200 || map.has(key)) map.set(key, (map.get(key) ?? 0) + 1);
}

/** Count one or more funnel stages for a strategy. */
export function noteStage(strategy: string, stages: FunnelStage | readonly FunnelStage[], now = Date.now()): void {
  const m = bucket(now);
  let f = m.funnel.get(strategy);
  if (!f) {
    if (m.funnel.size >= 30) return;
    f = emptyFunnel();
    m.funnel.set(strategy, f);
  }
  for (const st of typeof stages === 'string' ? [stages] : stages) f[st]++;
}

/** One finished evaluation in the funnel: how far it got and what happened after the buy signal. */
export function noteEvaluation(
  strategy: string,
  r: { rulesOk: boolean; signal: boolean; outcome: 'toTrader' | 'dipWait' | 'confirming' | 'notConfirmed' | 'heldBack' | 'none' },
  now = Date.now(),
): void {
  const st: FunnelStage[] = ['checked'];
  if (r.rulesOk) st.push('rulesOk');
  if (r.signal) st.push('signal');
  if (r.outcome !== 'none') st.push(r.outcome);
  noteStage(strategy, st, now);
}

/** A coin was checked and not bought. `reason` = its first failed rule, or "score under the bar". */
export function noteSkip(strategy: string, reason: string, now = Date.now()): void {
  bucket(now).evaluated++;
  add('skip', strategy, reason, now);
}
/** A coin was checked and passed (a buy signal follows). */
export function noteSignal(now = Date.now()): void {
  const m = bucket(now);
  m.evaluated++;
  m.signals++;
}
/** The trader refused a buy signal. */
export function noteRefusal(strategy: string, reason: string, now = Date.now()): void {
  add('refuse', strategy, reason, now);
  noteStage(strategy, 'refused', now);
}
export function noteEntry(strategy?: string, now = Date.now()): void {
  bucket(now).entries++;
  if (strategy) noteStage(strategy, 'bought', now);
  lastEntryAt = now;
}
/** At start: when the last position was opened (from the DB), so a restart doesn't hide a drought. */
export function setLastEntryAt(at: number | null, now = Date.now()): void {
  startedAt = now;
  if (at !== null && (lastEntryAt === null || at > lastEntryAt)) lastEntryAt = at;
}

/** Minutes since the last entry (or since start, when there never was one). */
export function minutesSinceEntry(now = Date.now()): number {
  return (now - (lastEntryAt ?? startedAt)) / 60_000;
}

/** Learning-trade score margin: wider while the bot hasn't bought anything for a while. */
export function exploreMargin(ex: { scoreMargin: number; droughtMinutes?: number; droughtScoreMargin?: number }, now = Date.now()): number {
  if (ex.droughtMinutes && ex.droughtScoreMargin && minutesSinceEntry(now) >= ex.droughtMinutes) return Math.max(ex.scoreMargin, ex.droughtScoreMargin);
  return ex.scoreMargin;
}

export interface BlockerSnapshot {
  lastEntryAt: string | null;
  minutesSinceEntry: number;
  lastHour: { evaluated: number; buySignals: number; entries: number };
  topSkips: Array<{ reason: string; count: number }>;
  topRefusals: Array<{ reason: string; count: number }>;
  /** Per strategy, last hour (busiest first; switched-on strategies with no activity are listed with zeros). */
  strategies: Array<{ strategy: string; on: boolean | null; topSkips: Array<{ reason: string; count: number }> } & Funnel>;
  /** One line for the dashboard. */
  summary: string;
}

export function blockerSnapshot(now = Date.now(), enabled?: Readonly<Record<string, boolean>>): BlockerSnapshot {
  bucket(now);
  const skip = new Map<string, number>();
  const refuse = new Map<string, number>();
  let evaluated = 0;
  let signals = 0;
  let entries = 0;
  const funnel = new Map<string, Funnel>();
  for (const m of minutes) {
    for (const [k, f] of m.funnel) {
      const acc = funnel.get(k) ?? emptyFunnel();
      for (const st of FUNNEL_STAGES) acc[st] += f[st];
      funnel.set(k, acc);
    }
    evaluated += m.evaluated;
    signals += m.signals;
    entries += m.entries;
    for (const [k, v] of m.skip) skip.set(k, (skip.get(k) ?? 0) + v);
    for (const [k, v] of m.refuse) refuse.set(k, (refuse.get(k) ?? 0) + v);
  }
  const top = (x: Map<string, number>, n: number) => [...x].sort((a, b) => b[1] - a[1]).slice(0, n).map(([reason, count]) => ({ reason, count }));
  const topSkips = top(skip, 8);
  // Each strategy's own top 3 skip reasons (the overall list is dominated by the busiest strategy).
  const topFor = (strategy: string) =>
    top(new Map([...skip].filter(([k]) => k.startsWith(`${strategy}: `)).map(([k, v]) => [k.slice(strategy.length + 2), v])), 3);
  let dipWaits = 0;
  for (const f of funnel.values()) dipWaits += f.dipWait + f.confirming;
  const topRefusals = top(refuse, 6);
  const mins = Math.round(minutesSinceEntry(now));
  let summary: string;
  if (entries > 0) summary = `${entries} buy${entries === 1 ? '' : 's'} in the last hour`;
  else if (evaluated === 0) summary = `No coins checked in the last hour — the trade stream is probably down (see Scanner)`;
  else if (dipWaits > 0 && signals === 0) summary = `${dipWaits} buy signal${dipWaits === 1 ? '' : 's'} waiting for a dip / confirmation, none filled yet — ${evaluated} coins checked`;
  else if (signals > 0 && topRefusals[0]) summary = `${signals} buy signal${signals === 1 ? '' : 's'} refused — mostly "${topRefusals[0].reason}"`;
  else summary = `${evaluated} coins checked, none good enough — mostly "${topSkips[0]?.reason ?? 'score under the bar'}"`;
  return {
    lastEntryAt: lastEntryAt ? new Date(lastEntryAt).toISOString() : null,
    minutesSinceEntry: mins,
    lastHour: { evaluated, buySignals: signals, entries },
    topSkips,
    topRefusals,
    strategies: [...new Set([...funnel.keys(), ...Object.entries(enabled ?? {}).filter(([, on]) => on).map(([k]) => k)])]
      .map((strategy) => ({ strategy, on: enabled ? enabled[strategy] ?? null : null, ...(funnel.get(strategy) ?? emptyFunnel()), topSkips: topFor(strategy) }))
      .sort((a, b) => b.bought - a.bought || b.signal - a.signal || b.checked - a.checked),
    summary,
  };
}

/** Tests only. */
export function resetBlockers(now = Date.now()): void {
  minutes.length = 0;
  lastEntryAt = null;
  startedAt = now;
}
