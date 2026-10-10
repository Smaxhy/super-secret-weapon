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
}

const WINDOW_MIN = 60;
const minutes: Minute[] = [];
let lastEntryAt: number | null = null;
let startedAt = Date.now();

function bucket(now: number): Minute {
  const at = Math.floor(now / 60_000) * 60_000;
  let m = minutes[minutes.length - 1];
  if (!m || m.at !== at) {
    m = { at, skip: new Map(), refuse: new Map(), evaluated: 0, signals: 0, entries: 0 };
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
}
export function noteEntry(now = Date.now()): void {
  bucket(now).entries++;
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
  /** One line for the dashboard. */
  summary: string;
}

export function blockerSnapshot(now = Date.now()): BlockerSnapshot {
  bucket(now);
  const skip = new Map<string, number>();
  const refuse = new Map<string, number>();
  let evaluated = 0;
  let signals = 0;
  let entries = 0;
  for (const m of minutes) {
    evaluated += m.evaluated;
    signals += m.signals;
    entries += m.entries;
    for (const [k, v] of m.skip) skip.set(k, (skip.get(k) ?? 0) + v);
    for (const [k, v] of m.refuse) refuse.set(k, (refuse.get(k) ?? 0) + v);
  }
  const top = (x: Map<string, number>, n: number) => [...x].sort((a, b) => b[1] - a[1]).slice(0, n).map(([reason, count]) => ({ reason, count }));
  const topSkips = top(skip, 8);
  const topRefusals = top(refuse, 6);
  const mins = Math.round(minutesSinceEntry(now));
  let summary: string;
  if (entries > 0) summary = `${entries} buy${entries === 1 ? '' : 's'} in the last hour`;
  else if (evaluated === 0) summary = `No coins checked in the last hour — the trade stream is probably down (see Scanner)`;
  else if (signals > 0 && topRefusals[0]) summary = `${signals} buy signal${signals === 1 ? '' : 's'} refused — mostly "${topRefusals[0].reason}"`;
  else summary = `${evaluated} coins checked, none good enough — mostly "${topSkips[0]?.reason ?? 'score under the bar'}"`;
  return {
    lastEntryAt: lastEntryAt ? new Date(lastEntryAt).toISOString() : null,
    minutesSinceEntry: mins,
    lastHour: { evaluated, buySignals: signals, entries },
    topSkips,
    topRefusals,
    summary,
  };
}

/** Tests only. */
export function resetBlockers(now = Date.now()): void {
  minutes.length = 0;
  lastEntryAt = null;
  startedAt = now;
}
