/**
 * v18.2 Forex → Lab (owner: "I want tabs like the lab so I can actively see what the new features are"). One page that
 * lists every test the bot runs on itself, in one line each (what it is, what it changes, where it stands), then the
 * cards. Display only: everything here is already computed by the hourly lab (/api/forex) and the bot (/api/forex/bot).
 */
import { useApi } from '../hooks/useApi';
import { Card, Badge } from './ui';
import { ConvictionCard, DeskCard, EntriesCard, ExitsCard, FiltersCard, FinancingCard, HonestCard, JudgeCard, LockCard, NewsStudyCard, PortfolioCard, RiskCard, RollingCard, SniperCard, type ConvictionReport, type DeskReport, type EntrySummary, type ExitSummary, type FilterSummary, type FinancingSummary, type HonestReport, type JudgeReport, type Ledger, type LockSummary, type NewsStudy, type PortfolioReport, type RiskSummary, type RollReport, type SniperReport } from './FxInsights';
import { apiBase } from '../lib/ws';

export interface LabRow { id: string; name: string; family?: string; desc?: string; tf?: string; verdict: 'edge' | 'maybe' | 'no'; outSample?: { n: number; avgR: number } }
export interface LabReport { honest?: HonestReport; judge?: JudgeReport | null; filters?: FilterSummary[]; lock?: LockSummary; exits?: ExitSummary[]; entries?: EntrySummary[]; financing?: FinancingSummary; news?: NewsStudy | null; rows: LabRow[] }
const FAMILY: Record<string, { label: string; what: string }> = {
  trend: { label: 'Trend following', what: 'Go with a move that is already under way: moving-average crosses and pullbacks, Supertrend, MACD, ADX, trendline and structure breaks, time-series momentum, currency momentum.' },
  breakout: { label: 'Breakouts', what: 'Enter when price leaves a range: Donchian highs / lows, Bollinger squeeze, Keltner, inside bars, breakout-and-retest, volatility-forecast breaks, round-number breaks.' },
  reversion: { label: 'Mean reversion', what: 'Bet on a snap-back: RSI dips, Connors RSI(2), Bollinger reversion, pivot bounces, Fibonacci 50–61.8% pullbacks, Turtle Soup false breaks, stochastic / Williams %R turns, stat-arb on linked crosses, round-number fades.' },
  pattern: { label: 'Candle patterns', what: 'Engulfing and pin bars at an extreme, double bottoms / tops, momentum candles.' },
  ict: { label: 'ICT / smart money', what: 'Inner Circle Trader concepts in New York time: the Judas swing after the 9:30 open, quarterly theory (accumulation → manipulation → distribution in 90-minute and 6-hour quarters), and order flow — a liquidity sweep, a displacement candle, the fair-value gap it leaves, a market-structure shift.' },
  session: { label: 'Session timing', what: 'The clock as the edge: London and New York open breakouts, the Asian-range fade, the dollar into the London fix.' },
  news: { label: 'News shocks', what: 'After a shock candle: follow the drift, or fade the shock that fails.' },
  intermarket: { label: 'Linked markets', what: 'Oil → CAD, US yields → USD/JPY, stocks → yen crosses, the dollar → gold: trade the laggard when the leader has moved.' },
  flow: { label: 'Flows & positioning', what: 'Month-end rebalancing, crowded CFTC positioning squeezes, overstretched 3-month runs.' },
  control: { label: 'Yardstick', what: 'Random entries with the same costs. Anything that cannot beat this has no edge.' },
};
const FAMILY_ORDER = ['ict', 'session', 'trend', 'breakout', 'reversion', 'pattern', 'news', 'intermarket', 'flow', 'control'];

/** v18.3 playbook: every strategy the bot knows, grouped by what kind of edge it hunts, with its grade per chart. */
function Playbook({ rows, chosen }: { rows: LabRow[]; chosen: Set<string> }) {
  const byId = new Map<string, LabRow[]>();
  for (const r of rows) byId.set(r.id, [...(byId.get(r.id) ?? []), r]);
  const fams = new Map<string, Array<{ id: string; name: string; desc: string; charts: LabRow[] }>>();
  for (const [id, list] of byId) {
    const f = list[0]!.family ?? 'other';
    fams.set(f, [...(fams.get(f) ?? []), { id, name: list[0]!.name, desc: list[0]!.desc ?? '', charts: list.sort((a, b) => ['1m', '15m', '1h', '4h'].indexOf(a.tf ?? '') - ['1m', '15m', '1h', '4h'].indexOf(b.tf ?? '')) }]);
  }
  const order = [...fams.keys()].sort((a, b) => (FAMILY_ORDER.indexOf(a) + 100) % 100 - (FAMILY_ORDER.indexOf(b) + 100) % 100);
  const traded = rows.filter((r) => chosen.has(`${r.id}:${r.tf}`)).length;
  return (
    <Card title="The playbook: every setup it knows" subtitle={`${byId.size} strategies, each tested on 1-minute, 15-minute, hourly and 4-hour charts (${rows.length} strategy × chart rows). A chip per chart shows its grade on the unseen 30%: green Edge, blue Maybe, grey no edge; a ring means the bot trades it right now (${traded} rows). Tap a family to read what each setup looks for.`}>
      <div className="space-y-2">
        {order.map((f) => {
          const list = fams.get(f)!;
          const meta = FAMILY[f] ?? { label: f, what: '' };
          const edges = list.flatMap((x) => x.charts).filter((c) => c.verdict !== 'no').length;
          return (
            <details key={f} className="group rounded-xl border border-line bg-surface-2/60 open:bg-surface-2/40">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3.5 py-3 [&::-webkit-details-marker]:hidden">
                <span className="min-w-0">
                  <span className="block font-semibold text-ink">{meta.label} <span className="text-xs font-normal text-muted">· {list.length} {list.length === 1 ? 'setup' : 'setups'}{edges ? ` · ${edges} with an edge or maybe` : ''}</span></span>
                  <span className="block text-xs text-muted">{meta.what}</span>
                </span>
                <span className="shrink-0 text-ink-2 transition-transform group-open:rotate-180">▾</span>
              </summary>
              <ul className="divide-y divide-line border-t border-line">
                {list.map((x) => (
                  <li key={x.id} className="px-3.5 py-2.5">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-medium text-ink">{x.name}</span>
                      <span className="flex flex-wrap gap-1">
                        {x.charts.map((c) => (
                          <span key={c.tf} title={`${c.tf}: ${c.verdict === 'edge' ? 'Edge' : c.verdict === 'maybe' ? 'Maybe' : 'no edge'} on the unseen 30%${c.outSample ? ` · ${c.outSample.n} trades · ${c.outSample.avgR >= 0 ? '+' : ''}${c.outSample.avgR}R a trade` : ''}${chosen.has(`${c.id}:${c.tf}`) ? ' · the bot trades it' : ''}`} className={`rounded-full px-1.5 py-0.5 text-[11px] font-semibold ${c.verdict === 'edge' ? 'bg-good/15 text-up' : c.verdict === 'maybe' ? 'bg-accent/15 text-accent-text' : 'bg-surface-3 text-muted'} ${chosen.has(`${c.id}:${c.tf}`) ? 'ring-2 ring-accent/60' : ''}`}>{c.tf}</span>
                        ))}
                      </span>
                    </div>
                    {x.desc && <p className="mt-0.5 text-xs text-ink-2">{x.desc}</p>}
                  </li>
                ))}
              </ul>
            </details>
          );
        })}
      </div>
    </Card>
  );
}

interface BotData { chosen?: string[]; desk?: DeskReport | null; rolling?: RollReport | null; chooser?: string; ledger?: Ledger; names?: Record<string, string>; sniper?: SniperReport | null; risk?: RiskSummary | null; portfolio?: PortfolioReport | null; judge?: JudgeReport | null; conviction?: Partial<Record<'hourly' | '15m' | '1m', ConvictionReport | null>> | null }

type State = 'on' | 'off' | 'test';
const chip = (s: State, text: string) => <Badge tone={s === 'on' ? 'up' : s === 'off' ? 'neutral' : 'accent'}>{text}</Badge>;

export function FxLab({ r }: { r: LabReport }) {
  const { data: b } = useApi<BotData>(`${apiBase()}/bot`, 60_000);
  const edges = r.rows.filter((x) => x.verdict === 'edge').length;
  const maybes = r.rows.filter((x) => x.verdict === 'maybe').length;
  const judgeOn = !!(b?.judge ?? r.judge)?.active;
  const rollingOn = !!b?.rolling?.active;
  const sniperOn = !!b?.sniper?.active;
  const convOn = !!(b?.conviction && Object.values(b.conviction).some((c) => c?.active));
  const deskOk = !!(b?.desk && b.desk.unseen.weeks >= 26 && b.desk.unseen.totalPct > 0 && b.desk.unseen.sr >= 0.5 && b.desk.unseen.maxDdPct <= 25);
  const items: Array<{ name: string; what: string; state: State; status: string }> = [
    { name: 'Strategy exam', what: 'Every strategy on every chart, picked on the first 70% of history, graded on the unseen last 30%. Edge / Maybe rows are the ones the bot may trade.', state: edges + maybes ? 'on' : 'test', status: `${edges} Edge · ${maybes} Maybe of ${r.rows.length} rows` },
    { name: 'Honest statistics', what: 'Counts how many strategies were tried and knocks down winners that luck alone would explain (deflated Sharpe, overfitting probability).', state: r.honest ? 'on' : 'test', status: r.honest ? `${r.honest.downgraded} rows downgraded · PBO ${Math.round((r.honest.pbo?.pbo ?? 0) * 100)}%` : 'no data yet' },
    { name: 'Checks (filters)', what: 'Currency strength, bigger charts, market mood, regime, volatility, positioning… each strategy keeps the one check that helped on the first 70%.', state: 'on', status: r.filters ? `${r.filters.reduce((s, f) => s + f.chosenBy, 0)} strategies use a check` : '' },
    { name: 'Exits', what: 'Break-even, half off, trailing stop-loss, trailing take-profit… each strategy keeps the exit that did best on the first 70%.', state: 'on', status: r.exits ? `${r.exits.reduce((s, e) => s + e.chosenBy, 0)} strategies changed their exit` : '' },
    { name: 'Profit lock', what: 'Your rule: a third of the way to the target the stop jumps past the entry, then trails. On every trade.', state: r.lock?.on ? 'on' : 'off', status: r.lock ? `unseen ${r.lock.outDeltaR >= 0 ? '+' : ''}${r.lock.outDeltaR}R a trade vs without` : '' },
    { name: 'Entry timing', what: 'The same trades entered by limit order, after a pullback, or after a confirming candle. Graded only — goes live once one wins and resting orders exist.', state: 'test', status: r.entries ? r.entries.map((e) => `${e.entry} ${e.outDeltaR >= 0 ? '+' : ''}${e.outDeltaR}R`).join(' · ') : '' },
    { name: 'Overnight financing', what: 'Interest earned on the currency bought, paid on the one sold, minus a broker markup — inside every test and booked nightly on the account.', state: r.financing?.on ? 'on' : 'off', status: r.financing ? `${r.financing.known} of ${r.financing.rows} rows have rates` : '' },
    { name: 'Signal judge', what: 'A model that scores each signal from 24 context readings and skips the weak ones. Live only after passing its unseen exam.', state: judgeOn ? 'on' : 'test', status: judgeOn ? 'live: weak signals are skipped' : 'not proven yet: every signal passes' },
    { name: 'What it learned this week', what: 'Each week the bot re-picks strategies from what made money in the last 26 weeks, graded against 100 random pickers.', state: rollingOn ? 'on' : 'test', status: rollingOn ? 'live: the weekly list is the bot\'s list' : 'not proven yet: the unseen-30% verdicts decide' },
    { name: 'Bigger size when sure', what: 'When several checks agree the trade is 1.5–2× the size at more leverage — only if sure trades proved better on unseen data.', state: convOn ? 'on' : 'test', status: convOn ? 'live' : 'not proven yet: normal size' },
    { name: 'Sniper', what: 'All checks plus the judge vote; a full-vote signal gets 8% risk at 200×. Only if those trades proved far better on unseen data.', state: sniperOn ? 'on' : 'test', status: sniperOn ? 'live' : 'not proven yet' },
    { name: 'The desk', what: 'A second way to trade: continuous forecasts (trend, breakout, carry) sized to equal risk per market, the way quant funds run FX. Goes live when its unseen record passes.', state: deskOk ? 'on' : 'test', status: b?.desk ? `unseen ${b.desk.unseen.totalPct >= 0 ? '+' : ''}${b.desk.unseen.totalPct}% · Sharpe ${b.desk.unseen.sr} · drop ${b.desk.unseen.maxDdPct}% · ${b.desk.unseen.weeks} weeks (needs 26+, SR ≥ 0.5, drop ≤ 25%)` : 'no run yet' },
    { name: 'Correlated-risk cap', what: 'Stops it from holding five trades that are really the same bet (EUR/USD + GBP/USD + …). Live only when its test shows it cuts the biggest drop.', state: b?.portfolio?.heated ? 'test' : 'test', status: b?.portfolio?.heatWhy ?? '' },
  ];
  return (
    <>
      <Card title="What the bot tests on itself" subtitle="Every idea runs as an exam first. Green = used live. Blue = graded only, waiting to prove itself on data it never trained on. Nothing switches itself on without passing.">
        <ul className="divide-y divide-line">
          {items.map((it) => (
            <li key={it.name} className="py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-ink">{it.name}</span>
                {chip(it.state, it.state === 'on' ? 'live' : it.state === 'off' ? 'off' : 'testing')}
              </div>
              <p className="mt-0.5 text-sm text-ink-2">{it.what}</p>
              {it.status && <p className="tabular mt-1 break-words text-xs text-muted">{it.status}</p>}
            </li>
          ))}
        </ul>
      </Card>
      <Playbook rows={r.rows} chosen={new Set(b?.chosen ?? [])} />
      <HonestCard h={r.honest} names={Object.fromEntries(r.rows.map((x) => [x.id, x.name]))} />
      <DeskCard d={b?.desk} />
      <EntriesCard e={r.entries} />
      <FinancingCard f={r.financing} />
      <JudgeCard j={b?.judge ?? r.judge} />
      <FiltersCard f={r.filters} />
      <ExitsCard e={r.exits} />
      <LockCard l={r.lock} />
      <RollingCard r={b?.rolling} chooser={b?.chooser} ledger={b?.ledger} names={b?.names} />
      <ConvictionCard c={b?.conviction} />
      <SniperCard s={b?.sniper} />
      <PortfolioCard p={b?.portfolio} judgeOn={judgeOn} />
      <RiskCard r={b?.risk} />
      <NewsStudyCard n={r.news} />
    </>
  );
}
