/**
 * v18.2 Forex → Lab (owner: "I want tabs like the lab so I can actively see what the new features are"). One page that
 * lists every test the bot runs on itself, in one line each (what it is, what it changes, where it stands), then the
 * cards. Display only: everything here is already computed by the hourly lab (/api/forex) and the bot (/api/forex/bot).
 */
import { useApi } from '../hooks/useApi';
import { Card, Rows, Row, Badge } from './ui';
import { ConvictionCard, DeskCard, EntriesCard, ExitsCard, FiltersCard, FinancingCard, HonestCard, JudgeCard, LockCard, NewsStudyCard, PortfolioCard, RiskCard, RollingCard, SniperCard, type ConvictionReport, type DeskReport, type EntrySummary, type ExitSummary, type FilterSummary, type FinancingSummary, type HonestReport, type JudgeReport, type Ledger, type LockSummary, type NewsStudy, type PortfolioReport, type RiskSummary, type RollReport, type SniperReport } from './FxInsights';

export interface LabReport { honest?: HonestReport; judge?: JudgeReport | null; filters?: FilterSummary[]; lock?: LockSummary; exits?: ExitSummary[]; entries?: EntrySummary[]; financing?: FinancingSummary; news?: NewsStudy | null; rows: Array<{ id: string; name: string; verdict: 'edge' | 'maybe' | 'no' }> }
interface BotData { desk?: DeskReport | null; rolling?: RollReport | null; chooser?: string; ledger?: Ledger; names?: Record<string, string>; sniper?: SniperReport | null; risk?: RiskSummary | null; portfolio?: PortfolioReport | null; judge?: JudgeReport | null; conviction?: Partial<Record<'hourly' | '15m' | '1m', ConvictionReport | null>> | null }

type State = 'on' | 'off' | 'test';
const chip = (s: State, text: string) => <Badge tone={s === 'on' ? 'up' : s === 'off' ? 'neutral' : 'accent'}>{text}</Badge>;

export function FxLab({ r }: { r: LabReport }) {
  const { data: b } = useApi<BotData>('/api/forex/bot', 60_000);
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
        <Rows>
          {items.map((it) => (
            <Row key={it.name} label={<span className="flex flex-wrap items-center gap-2">{it.name} {chip(it.state, it.state === 'on' ? 'live' : it.state === 'off' ? 'off' : 'testing')}</span>} sub={it.what} value={<span className="text-xs text-ink-2">{it.status}</span>} />
          ))}
        </Rows>
      </Card>
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
