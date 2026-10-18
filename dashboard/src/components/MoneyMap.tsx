/**
 * Performance → Money: "Where's the money?" — every coin the bot looked at (bought, nearly bought, or just checked),
 * followed with the bot's own exits, split any way you like. Answers two questions in plain words: which KINDS of coin
 * pay, and whether the picks or the exits are losing the money.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import { ago, STRATEGY_LABEL } from '../lib/format';
import { Icon } from './Icon';
import { Badge, Card, Chip, Empty, ErrorBox, HeatRow, Loading, NumberInput, SectionHeader, StatTile, Tabs, useStored } from './ui';
import { CopyReplay } from './CopyReplay';
import { CohortTest } from './CohortTest';

interface GroupStat { label: string; n: number; winPct: number; avgPct: number; medianPct: number; robustPct: number; sol: number; reach115Pct: number; reach150Pct: number; reach200Pct: number; perfectPct: number }
interface Dimension { key: string; label: string; about: string; groups: GroupStat[]; unknown: number }
interface Ranked extends GroupStat { dim: string; dimLabel: string; rank: number }
interface Combo extends GroupStat { a: { dim: string; dimLabel: string; label: string }; b: { dim: string; dimLabel: string; label: string }; rank: number }
interface Verdict { strategy: string; n: number; real: number; avgPct: number; winPct: number; reach115Pct: number; reach150Pct: number; perfectPct: number; verdict: 'picks' | 'exits' | 'both' | 'working' | 'unclear'; text: string }
interface ExitCompare { strategy: string; n: number; live: number; alt: Record<string, number>; perfect: number }
interface Data {
  at: number;
  hours: number;
  rows: number;
  dropped: number;
  bySource: { real: number; shadow: number; outcome: number };
  overall: GroupStat | null;
  verdicts: Verdict[];
  best: Ranked[];
  worst: Ranked[];
  combos: Combo[];
  dimensions: Dimension[];
  exits: ExitCompare[];
  exitNames: Record<string, string>;
  week: Array<{ dow: number; hour: number; n: number; avgPct: number }>;
  gotAway: Array<{ symbol: string; mint: string; strategy: string; atMs: number; peakX: number; pnlPct: number; why: string; source: string }>;
  note: string;
}

const RANGES = [
  { key: '24', label: '24 h' },
  { key: '48', label: '48 h' },
  { key: '168', label: '7 days' },
] as const;
type RangeKey = (typeof RANGES)[number]['key'];
const SOURCES = [
  { key: 'filtered', label: 'Inside your filters' },
  { key: 'all', label: 'Every coin' },
  { key: 'skipped', label: 'Skipped only' },
  { key: 'real', label: 'Bought only' },
] as const;
type SourceKey = (typeof SOURCES)[number]['key'];
const VERDICT: Record<Verdict['verdict'], { tone: 'up' | 'down' | 'warn' | 'neutral'; text: string }> = {
  working: { tone: 'up', text: 'Working' },
  picks: { tone: 'down', text: 'Picks are the problem' },
  exits: { tone: 'warn', text: 'Exits are the problem' },
  both: { tone: 'down', text: 'Picks and exits' },
  unclear: { tone: 'neutral', text: 'Too few yet' },
};
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const strat = (s: string) => STRATEGY_LABEL[s] ?? s;
const signed = (x: number, dp = 1) => `${x >= 0 ? '+' : ''}${x.toFixed(dp)}`;
const tone = (x: number) => (x > 0 ? 'text-up' : x < 0 ? 'text-down' : 'text-ink-2');

export function MoneyMap() {
  const [range, setRange] = useStored<RangeKey>('money.range', '48', RANGES.map((r) => r.key));
  const [source, setSource] = useStored<SourceKey>('money.source', 'filtered', SOURCES.map((s) => s.key));
  const [strategy, setStrategy] = useState<string>('');
  const [size, setSize] = useState('0.5');
  const sizeSol = Math.max(0.01, Number(size) || 0.5);
  const { data, error } = useApi<Data>(`/api/money-map?hours=${range}&source=${source}${strategy ? `&strategy=${strategy}` : ''}`, 120_000);
  const strategies = useMemo(() => (data?.verdicts ?? []).map((v) => v.strategy), [data]);
  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="Where's the money?"
        description={data ? `${data.note} · ${ago(new Date(data.at).toISOString())}` : 'Coins the bot looked at, followed with its own exits, split by what they looked like at the time. "Inside your filters" = passed every rule (bought, or held back only by the score).'}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Tabs tabs={RANGES} value={range} onChange={setRange} label="Time range" />
        <Tabs tabs={SOURCES} value={source} onChange={setSource} label="Coins" />
        {strategies.length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            <Chip active={strategy === ''} onClick={() => setStrategy('')}>All strategies</Chip>
            {strategies.map((s) => (
              <Chip key={s} active={strategy === s} onClick={() => setStrategy(strategy === s ? '' : s)}>{strat(s)}</Chip>
            ))}
          </div>
        )}
      </div>
      {error && <ErrorBox message={error} />}
      {!data && !error && <Loading kind="tiles" />}
      {data && !data.overall && <Empty icon={<Icon name="radar" size={20} />}>No followed coins in this window yet. The outcome tracker labels a coin 45 minutes after the bot checks it.</Empty>}
      {data?.overall && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <StatTile compact label="Coins followed" value={data.rows.toLocaleString()} sub={`${data.bySource.real} bought · ${(data.bySource.shadow + data.bySource.outcome).toLocaleString()} skipped${data.dropped ? ` · ${data.dropped} broken prices left out` : ''}`} />
            <StatTile compact label="Buy-anything yardstick" value={`${signed(data.overall.robustPct)}%`} sub={`${data.overall.winPct}% won · median ${signed(data.overall.medianPct)}%`} tone={data.overall.robustPct > 0 ? 'up' : 'down'} />
            <StatTile compact label="Reached break-even" value={`${data.overall.reach115Pct}%`} sub="went 1.15× or more at some point" tone={data.overall.reach115Pct < 40 ? 'down' : undefined} />
            <StatTile compact label="Reached 2×" value={`${data.overall.reach200Pct}%`} sub={`${data.overall.reach150Pct}% reached 1.5×`} />
            <StatTile compact label="Perfect exits" value={`${signed(data.overall.perfectPct)}%`} sub="sold at the peak, after costs" tone={data.overall.perfectPct > 0 ? 'up' : undefined} />
          </div>

          <Card title="Picks or exits?" subtitle="Per strategy: if most coins never reach 1.15× the filters let the wrong coins through; if they ran and still lost, the exits are giving it back.">
            <ul className="grid gap-3 sm:grid-cols-2">
              {data.verdicts.map((v) => (
                <li key={v.strategy} className={`min-w-0 rounded-xl border p-3 ${v.verdict === 'working' ? 'border-good/40 bg-good/5' : v.verdict === 'unclear' ? 'border-line bg-surface-2/40' : 'border-critical/40 bg-critical/5'}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-semibold text-ink">{strat(v.strategy)}</span>
                    <Badge tone={VERDICT[v.verdict].tone}>{VERDICT[v.verdict].text}</Badge>
                  </div>
                  <div className="mt-2 flex items-baseline gap-3">
                    <span className={`tabular text-2xl font-bold leading-none ${tone(v.avgPct)}`}>{signed(v.avgPct)}%</span>
                    <span className="text-xs text-muted">avg · {v.n.toLocaleString()} coins ({v.real} bought)</span>
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                    <Mini label="Won" value={`${v.winPct}%`} />
                    <Mini label="Reached 1.5×" value={`${v.reach150Pct}%`} />
                    <Mini label="Perfect exit" value={`${signed(v.perfectPct)}%`} />
                  </div>
                  <p className="mt-2 text-sm text-ink-2">{v.text}</p>
                </li>
              ))}
            </ul>
          </Card>

          <div className="grid gap-6 xl:grid-cols-2">
            <Card
              title="Best places to look"
              subtitle="Groups of 15+ coins that paid, any way of splitting. Small groups are shrunk toward 0 so a lucky handful can't win."
              action={<NumberInput size="sm" label="SOL per trade" value={size} onChange={setSize} min={0.01} max={50} step={0.1} unit="SOL" className="w-32" />}
            >
              <GroupList rows={data.best} sizeSol={sizeSol} empty="Nothing paid yet in this window." />
            </Card>
            <Card title="Stay away from" subtitle="The groups that bled the most. Rules that keep these out cost nothing.">
              <GroupList rows={data.worst} sizeSol={sizeSol} empty="No group lost enough to show." />
            </Card>
          </div>

          {!!data.combos.length && (
            <Card title="Two rules together" subtitle="Pairs of the best single groups that still paid when combined (15+ coins). A candidate for a new filter.">
              <ul className="divide-y divide-line text-sm">
                {data.combos.map((c) => (
                  <li key={`${c.a.dim}:${c.a.label}:${c.b.dim}:${c.b.label}`} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                    <span className="min-w-0 flex flex-wrap items-center gap-1.5">
                      <Badge tone="accent">{c.a.dimLabel}: {c.a.label}</Badge>
                      <span className="text-muted">+</span>
                      <Badge tone="accent">{c.b.dimLabel}: {c.b.label}</Badge>
                    </span>
                    <span className="tabular flex shrink-0 items-baseline gap-3 text-right">
                      <span className="text-muted">{c.n} coins</span>
                      <span className="text-muted">{c.winPct}% won · median {signed(c.medianPct)}%</span>
                      <span className={`font-semibold ${tone(c.robustPct)}`}>{signed(c.robustPct)}%</span>
                      <span className={`text-xs ${tone(c.sol)}`}>{signed(c.sol * sizeSol, 2)} SOL</span>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Explorer dims={data.dimensions} sizeSol={sizeSol} />

          <div className="grid gap-6 xl:grid-cols-2">
            <Card title="Same coins, other exits" subtitle="Every checked coin replayed through other exit settings too (since the latest update). Live = the bot's current exits; Perfect = sold at the peak.">
              {!data.exits.length ? (
                <p className="text-sm text-ink-2">Collecting — the first coins with other exits land about an hour after the update.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="tabular w-full min-w-[26rem] text-sm">
                    <thead>
                      <tr className="text-left text-xs text-muted">
                        <th className="py-2 font-medium">Strategy</th>
                        <th className="py-2 text-right font-medium">Coins</th>
                        <th className="py-2 text-right font-medium">Live</th>
                        {Object.keys(data.exits[0]!.alt).map((id) => (
                          <th key={id} className="py-2 text-right font-medium" title={data.exitNames[id] ?? id}>{shortExit(id, data.exitNames[id])}</th>
                        ))}
                        <th className="py-2 text-right font-medium">Perfect</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.exits.map((e) => {
                        const bestAlt = Math.max(e.live, ...Object.values(e.alt));
                        return (
                          <tr key={e.strategy} className="border-t border-line">
                            <td className="py-2 text-ink">{strat(e.strategy)}</td>
                            <td className="py-2 text-right text-ink-2">{e.n}</td>
                            <td className={`py-2 text-right ${e.live === bestAlt ? 'font-semibold' : ''} ${tone(e.live)}`}>{signed(e.live)}%</td>
                            {Object.entries(e.alt).map(([id, v]) => (
                              <td key={id} className={`py-2 text-right ${v === bestAlt ? 'font-semibold' : ''} ${tone(v)}`}>{signed(v)}%</td>
                            ))}
                            <td className="py-2 text-right text-ink-2">{signed(e.perfect)}%</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
            <Card title="The ones that got away" subtitle="The biggest runners it skipped, and why. Tap a coin for its page.">
              {!data.gotAway.length ? (
                <p className="text-sm text-ink-2">No skipped coin reached 1.5× in this window.</p>
              ) : (
                <ul className="divide-y divide-line text-sm">
                  {data.gotAway.map((g) => (
                    <li key={`${g.mint}:${g.atMs}`} className="flex items-start justify-between gap-3 py-2.5">
                      <div className="min-w-0">
                        <Link to={`/token/${g.mint}`} className="font-semibold text-ink hover:underline">{g.symbol || g.mint.slice(0, 6)}</Link>
                        <span className="ml-2 text-xs text-muted">{strat(g.strategy)} · {ago(new Date(g.atMs).toISOString())}</span>
                        <div className="mt-0.5 truncate text-xs text-muted" title={g.why}>{g.why}</div>
                      </div>
                      <div className="tabular shrink-0 text-right">
                        <div className="font-semibold text-up">{g.peakX.toFixed(2)}×</div>
                        <div className={`text-xs ${tone(g.pnlPct)}`}>exits: {signed(g.pnlPct)}%</div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <WeekHeat cells={data.week} />
        </>
      )}
      <CopyReplay />
      <CohortTest />
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-muted">{label}</dt>
      <dd className="tabular truncate font-medium text-ink">{value}</dd>
    </div>
  );
}

const shortExit = (id: string, name?: string) => (name ? name.split(':')[0]!.split(' (')[0]!.slice(0, 18) : id);

function GroupList({ rows, sizeSol, empty }: { rows: Ranked[]; sizeSol: number; empty: string }) {
  if (!rows.length) return <p className="text-sm text-ink-2">{empty}</p>;
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.robustPct)));
  return (
    <ul className="flex flex-col gap-2.5">
      {rows.map((r) => (
        <li key={`${r.dim}:${r.label}`} className="min-w-0">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate">
              <span className="text-muted">{r.dimLabel}: </span>
              <span className="font-medium text-ink">{r.label}</span>
            </span>
            <span className="tabular flex shrink-0 items-baseline gap-2.5">
              <span className="text-xs text-muted">{r.n} coins · {r.winPct}% won · median {signed(r.medianPct)}%</span>
              <span className={`font-semibold ${tone(r.robustPct)}`}>{signed(r.robustPct)}%</span>
            </span>
          </div>
          <div className="mt-1 flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
              <div className={`h-full rounded-full ${r.robustPct >= 0 ? 'bg-good' : 'bg-critical'}`} style={{ width: `${Math.max(3, (Math.abs(r.robustPct) / max) * 100)}%` }} />
            </div>
            <span className={`tabular w-24 shrink-0 text-right text-xs ${tone(r.sol)}`} title={`at ${sizeSol} SOL per coin`}>{signed(r.sol * sizeSol, 2)} SOL</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

function Explorer({ dims, sizeSol }: { dims: Dimension[]; sizeSol: number }) {
  const keys = dims.map((d) => d.key);
  const [dimKey, setDimKey] = useStored<string>('money.dim', keys[0] ?? 'mc');
  const dim = dims.find((d) => d.key === dimKey) ?? dims[0];
  if (!dim) return null;
  const max = Math.max(1, ...dim.groups.map((g) => Math.abs(g.robustPct)));
  const biggest = Math.max(1, ...dim.groups.map((g) => g.n));
  return (
    <Card title="Split it yourself" subtitle={`${dim.about} Average = each coin capped at +300% so one freak print can't carry a group.`}>
      <div className="mb-4 flex flex-wrap gap-1.5">
        {dims.map((d) => (
          <Chip key={d.key} active={d.key === dim.key} onClick={() => setDimKey(d.key)}>{d.label}</Chip>
        ))}
      </div>
      {!dim.groups.length ? (
        <p className="text-sm text-ink-2">No coin in this window has this number.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="tabular w-full min-w-[34rem] text-sm">
            <thead>
              <tr className="text-left text-xs text-muted">
                <th className="py-2 font-medium">{dim.label}</th>
                <th className="py-2 text-right font-medium">Coins</th>
                <th className="py-2 pl-3 font-medium">Average</th>
                <th className="py-2 text-right font-medium">Median</th>
                <th className="py-2 text-right font-medium">Won</th>
                <th className="py-2 text-right font-medium">→ 1.5×</th>
                <th className="py-2 text-right font-medium">Perfect</th>
                <th className="py-2 text-right font-medium">At {sizeSol} SOL</th>
              </tr>
            </thead>
            <tbody>
              {dim.groups.map((g) => (
                <tr key={g.label} className="border-t border-line">
                  <td className="py-2 text-ink">{g.label}</td>
                  <td className="py-2 text-right">
                    <span className="text-ink-2">{g.n}</span>
                    <div className="ml-auto mt-0.5 h-1 w-16 overflow-hidden rounded-full bg-surface-2"><div className="h-full rounded-full bg-accent/60" style={{ width: `${(g.n / biggest) * 100}%` }} /></div>
                  </td>
                  <td className="py-2 pl-3">
                    <div className="flex items-center gap-2">
                      <div className="relative h-2 w-28 overflow-hidden rounded-full bg-surface-2">
                        <div className={`absolute top-0 h-full ${g.robustPct >= 0 ? 'left-1/2 bg-good' : 'right-1/2 bg-critical'}`} style={{ width: `${(Math.abs(g.robustPct) / max) * 50}%` }} />
                      </div>
                      <span className={`font-semibold ${tone(g.robustPct)}`}>{signed(g.robustPct)}%</span>
                    </div>
                  </td>
                  <td className={`py-2 text-right ${tone(g.medianPct)}`}>{signed(g.medianPct)}%</td>
                  <td className="py-2 text-right text-ink-2">{g.winPct}%</td>
                  <td className="py-2 text-right text-ink-2">{g.reach150Pct}%</td>
                  <td className="py-2 text-right text-ink-2">{signed(g.perfectPct)}%</td>
                  <td className={`py-2 text-right ${tone(g.sol)}`}>{signed(g.sol * sizeSol, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {dim.unknown > 0 && <p className="mt-2 text-xs text-muted">{dim.unknown.toLocaleString()} coins had no value here and are left out.</p>}
        </div>
      )}
    </Card>
  );
}

function WeekHeat({ cells }: { cells: Data['week'] }) {
  // UTC cells → the viewer's clock.
  const offsetH = -new Date().getTimezoneOffset() / 60;
  const grid = useMemo(() => {
    const g: Array<Array<{ n: number; sum: number }>> = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ n: 0, sum: 0 })));
    for (const c of cells) {
      const local = c.hour + offsetH;
      const h = ((Math.round(local) % 24) + 24) % 24;
      const d = (c.dow + (local >= 24 ? 1 : local < 0 ? -1 : 0) + 7) % 7;
      g[d]![h]!.n += c.n;
      g[d]![h]!.sum += c.avgPct * c.n;
    }
    return g;
  }, [cells, offsetH]);
  const any = cells.length > 0;
  return (
    <Card title="When it pays" subtitle="Average result by weekday and hour, in your time. Green = the coins it saw then made money; grey = nothing seen.">
      {!any ? (
        <p className="text-sm text-ink-2">Nothing to show yet.</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {[1, 2, 3, 4, 5, 6, 0].map((d) => (
            <div key={d} className="flex items-center gap-2">
              <span className="w-8 shrink-0 text-xs text-muted">{DAY[d]}</span>
              <div className="min-w-0 flex-1">
                <HeatRow
                  signed
                  ariaLabel={`${DAY[d]} by hour`}
                  cells={grid[d]!.map((c, h) => ({ key: `${d}:${h}`, value: c.n >= 3 ? c.sum / c.n : null, title: c.n ? `${DAY[d]} ${String(h).padStart(2, '0')}:00 — ${c.n} coins, avg ${signed(c.sum / c.n)}%${c.n < 3 ? ' (too few to colour)' : ''}` : `${DAY[d]} ${String(h).padStart(2, '0')}:00 — nothing seen` }))}
                  labels={d === 0 ? ['0', '6', '12', '18', '23'] : undefined}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
