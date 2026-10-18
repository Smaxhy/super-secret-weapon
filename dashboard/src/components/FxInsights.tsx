/**
 * Forex v13 cards: currency strength, market mood, the filter check, "after big moves", the whole-bot test and the
 * bot's risk per currency. Data comes from the lab report (`/api/forex`) or the bot endpoint (`/api/forex/bot`).
 */
import { useState } from 'react';
import { ago } from '../lib/format';
import { Badge, Button, Card, Row, Rows, Sparkline, Stack, StatTile } from './ui';

export interface StrengthNow { at: number | null; ccys: Array<{ ccy: string; score: number; today: number; week: number }> }
export interface MoodNow { at: number | null; score: number | null; label: 'risk-on' | 'risk-off' | 'calm'; inputs: Array<{ id: string; label: string; value: number | null; change: number | null; unit: '%' | 'bp' }>; note: string }
export type FilterKind = 'none' | 'strength' | 'mtf' | 'mood' | 'regime' | 'volf' | 'hurst' | 'crowd' | 'all';
export interface FilterSummary { filter: FilterKind; label: string; chosenBy: number; compared: number; inDeltaR: number; outDeltaR: number; outBetterPct: number; keptPct: number; random: { inAvgR: number; outAvgR: number; outN: number } }
interface StudyCell { n: number; avgAtr: number[]; contPct: number[] }
export interface NewsStudy { horizons: number[]; shocks: number; overall: StudyCell; byHour: Array<{ key: string; label: string } & StudyCell>; byPair: Array<{ pair: string } & StudyCell>; byEvent: Array<{ key: string; label: string } & StudyCell>; recent: Array<{ pair: string; t: number; dir: 1 | -1; sizeAtr: number; moves: Array<number | null>; event: string | null }>; eventsKnown: number }
export interface PortfolioResult { label: string; baseRiskPct: number; trades: number; skipped: { full: number; ccy: number; margin: number; strategy?: number }; finalX: number; totalPct: number; weeks: number; avgWeekPct: number; medianWeekPct: number; greenWeeksPct: number; weeks5Pct: number; bigWeeksPct: number; bestWeekPct: number; worstWeekPct: number; months: number; avgMonthPct: number; medianMonthPct: number; greenMonthsPct: number; bigMonthsPct: number; worstMonthPct: number; maxDdPct: number; blown: boolean; mc: { paths: number; quarterP10: number; quarterMedian: number; quarterP90: number; pLoss: number; pDd20: number; pDd40: number } | null; equity: number[] }
export type ExitKind = 'designed' | 'breakeven' | 'scale' | 'tight' | 'runner' | 'quick' | 'wide' | 'trail_tp' | 'half_trail' | 'trail_sl';
export interface WalkForward { from: number; to: number; lookbackMonths: number; result: PortfolioResult; months: Array<{ month: string; picked: number; trades: number }> }
export interface TierStats { tier: 'sure' | 'verySure'; label: string; from: number; mult: number; lev: number; inN: number; inAvgR: number; outN: number; outAvgR: number; active: boolean }
export interface ConvictionReport { scope: string; judge: boolean; all: { inN: number; inAvgR: number; outN: number; outAvgR: number }; tiers: TierStats[]; active: boolean; why: string }
export interface PortfolioReport { from: number; to: number; picked: Array<{ id: string; name: string; tf: string; filter: FilterKind; exit?: ExitKind; inAvgR: number; inN: number; unseenN: number }>; oldPicked: number; levels: PortfolioResult[]; old: PortfolioResult; judged?: PortfolioResult | null; walkForward?: WalkForward | null; convicted?: PortfolioResult | null; sniped?: PortfolioResult | null; note: string }
export interface ExitSummary { exit: ExitKind; label: string; chosenBy: number; compared: number; inDeltaR: number; outDeltaR: number; outBetterPct: number }
export interface JudgeReport { active: boolean; why: string; trainedOn: number; tested: number; auc: number | null; threshold: number | null; keepPct: number; allR: number; keptR: number; skippedR: number; allWinPct: number; keptWinPct: number; importance: Array<{ feature: string; label: string; share: number }> }
export interface RiskSummary { exposure: Array<{ ccy: string; pct: number }>; capPct: number; ddPct: number; ddFactor: number; baseRiskPct: number; openRiskPct: number }

export const FILTER_SHORT: Record<FilterKind | 'regime', string> = { none: 'no filter', strength: '+ strength', mtf: '+ bigger chart', mood: '+ mood', regime: '+ regime', volf: '+ vol forecast', hurst: '+ trend/chop', crowd: '+ not crowded', all: '+ all 3 checks' };
export const EXIT_SHORT: Record<ExitKind, string> = { designed: 'exits as designed', breakeven: 'break-even at +1R', scale: 'half off at +1R', tight: 'closer target', runner: 'runner exit', quick: 'quick exit', wide: 'bigger target', trail_tp: 'trailing take-profit', half_trail: 'half at target, rest trails', trail_sl: 'trailing stop-loss' };
const signed = (x: number, dp = 1) => {
  const v = Number(x.toFixed(dp));
  return v === 0 ? (0).toFixed(dp) : `${v > 0 ? '+' : ''}${v.toFixed(dp)}`;
};
const tone = (x: number) => (x > 0 ? 'text-up' : x < 0 ? 'text-down' : 'text-ink-2');
const day = (t: number | null) => (t ? new Date(t).toISOString().slice(0, 10) : '—');

/** Strongest → weakest currency, as bars either side of zero. */
export function StrengthCard({ s, pairs }: { s: StrengthNow | undefined; pairs: string[] }) {
  if (!s || !s.ccys.length) return <Card title="Currency strength"><p className="text-sm text-ink-2">Fills in after the next hourly update (it needs the cross pairs downloaded first).</p></Card>;
  const max = Math.max(1, ...s.ccys.map((c) => Math.abs(c.score)));
  const strong = s.ccys[0]!;
  const weak = s.ccys[s.ccys.length - 1]!;
  const direct = pairs.find((p) => p === `${strong.ccy}${weak.ccy}`) ? `buy ${strong.ccy}/${weak.ccy}` : pairs.find((p) => p === `${weak.ccy}${strong.ccy}`) ? `sell ${weak.ccy}/${strong.ccy}` : null;
  return (
    <Card title="Currency strength" subtitle={`All 20 pairs boiled down to one score per currency (last 24 h + last 5 days, scaled by how much each pair normally moves). ${s.at ? `As of ${ago(new Date(s.at).toISOString())}.` : ''}`}>
      <ul className="space-y-2">
        {s.ccys.map((c) => {
          const w = Math.min(50, (Math.abs(c.score) / max) * 50);
          return (
            <li key={c.ccy} className="grid grid-cols-[3rem_1fr_3.5rem] items-center gap-2 text-sm">
              <span className="font-semibold text-ink">{c.ccy}</span>
              <div className="relative h-3 rounded-full bg-surface-2" aria-hidden="true">
                <div className="absolute inset-y-0 left-1/2 w-px bg-line" />
                <div className={`absolute inset-y-0 rounded-full ${c.score >= 0 ? 'bg-good' : 'bg-critical'}`} style={c.score >= 0 ? { left: '50%', width: `${w}%` } : { right: '50%', width: `${w}%` }} />
              </div>
              <span className={`tabular text-right font-medium ${tone(c.score)}`} title={`today ${signed(c.today, 2)} · week ${signed(c.week, 2)}`}>{signed(c.score, 2)}</span>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-xs text-muted">
        Strongest <span className="font-medium text-ink">{strong.ccy}</span>, weakest <span className="font-medium text-ink">{weak.ccy}</span>{direct ? ` — the strength check favours trades like: ${direct}.` : '.'} With the strength check on, the bot only buys the stronger currency of a pair.
      </p>
    </Card>
  );
}

const MOOD_TONE = { 'risk-on': 'up', 'risk-off': 'down', calm: 'neutral' } as const;
const MOOD_LABEL = { 'risk-on': 'Risk-on', 'risk-off': 'Risk-off', calm: 'Calm' } as const;

/** Risk-on / risk-off from stocks, fear, the dollar, yields and oil. */
export function MoodCard({ m }: { m: MoodNow | undefined }) {
  if (!m) return <Card title="Market mood"><p className="text-sm text-ink-2">Fills in after the next hourly update.</p></Card>;
  return (
    <Card title="Market mood" subtitle="What the wider market is doing in the last 24 hours. Fear moves money into the yen, the franc and gold; calm moves it into AUD, NZD and CAD." action={<Badge tone={MOOD_TONE[m.label]}>{MOOD_LABEL[m.label]}{m.score !== null ? ` ${signed(m.score, 1)}` : ''}</Badge>}>
      <Rows>
        {m.inputs.map((x) => (
          <Row key={x.id} label={x.label} sub={x.value !== null ? `now ${x.id === 'US10Y' ? `${x.value}%` : x.value.toLocaleString()}` : 'no data yet'} value={x.change === null ? <span className="text-muted">—</span> : <span className={x.id === 'VIX' ? tone(-x.change) : x.id === 'SPX' ? tone(x.change) : 'text-ink'}>{signed(x.change, x.unit === 'bp' ? 0 : 2)}{x.unit === 'bp' ? ' bp' : '%'}</span>} />
        ))}
      </Rows>
      <p className="mt-3 text-xs text-muted">{m.note}</p>
    </Card>
  );
}

/** Do the new checks help? Raw vs filtered, first 70% and unseen 30%, plus random entries with each check. */
export function FiltersCard({ f }: { f: FilterSummary[] | undefined }) {
  if (!f?.length) return null;
  return (
    <Card title="Do the new checks help?" subtitle="Every strategy was run without a check and with each one. R per trade = profit per trade in units of the amount risked. A check only counts if it also helps on the unseen 30%, and if random entries with that check alone stay near zero (else the check, not the strategy, is doing the work).">
      <div className="overflow-x-auto">
        <table className="tabular w-full min-w-[40rem] text-sm">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th className="py-1 font-medium">Check</th>
              <th className="py-1 text-right font-medium">Picked by</th>
              <th className="py-1 text-right font-medium">R/trade first 70%</th>
              <th className="py-1 text-right font-medium">R/trade unseen</th>
              <th className="py-1 text-right font-medium">Better unseen</th>
              <th className="py-1 text-right font-medium">Trades kept</th>
              <th className="py-1 text-right font-medium">Random + check</th>
            </tr>
          </thead>
          <tbody>
            {f.map((x) => (
              <tr key={x.filter} className="border-t border-line">
                <td className="py-1.5 text-ink">{x.label}</td>
                <td className="py-1.5 text-right text-ink-2">{x.chosenBy} {x.chosenBy === 1 ? 'strategy' : 'strategies'}</td>
                <td className={`py-1.5 text-right ${tone(x.inDeltaR)}`}>{signed(x.inDeltaR, 2)}</td>
                <td className={`py-1.5 text-right font-semibold ${tone(x.outDeltaR)}`}>{signed(x.outDeltaR, 2)}</td>
                <td className="py-1.5 text-right text-ink-2">{x.outBetterPct}% of {x.compared}</td>
                <td className="py-1.5 text-right text-ink-2">{x.keptPct}%</td>
                <td className={`py-1.5 text-right ${tone(x.random.outAvgR)}`}>{signed(x.random.outAvgR, 2)}R</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted">Each strategy keeps at most one check, chosen on the first 70% of the history only, so the unseen column is a fair test.</p>
    </Card>
  );
}

/** Do the new exits help? Each strategy under its own filter, exits swapped. */
export function ExitsCard({ e }: { e: ExitSummary[] | undefined }) {
  if (!e?.length) return null;
  return (
    <Card title="Do other exits help?" subtitle="Same entries, different ways out: stop to break-even once +1R up, half off at +1R, a closer or bigger target, no target with a trailing stop, a shorter time limit, a trailing take-profit (at the target the stop locks in profit and trails instead of closing; or half off there and the rest trails), or a trailing stop-loss (the stop follows the price from the start: break-even at +1R, +1R locked at +2R…). Each strategy keeps the exit that did best on the first 70% only; where they test as well, the trailing stop-loss and then the trailing take-profit win.">
      <div className="overflow-x-auto">
        <table className="tabular w-full min-w-[34rem] text-sm">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th className="py-1 font-medium">Exit</th>
              <th className="py-1 text-right font-medium">Picked by</th>
              <th className="py-1 text-right font-medium">R/trade first 70%</th>
              <th className="py-1 text-right font-medium">R/trade unseen</th>
              <th className="py-1 text-right font-medium">Better unseen</th>
            </tr>
          </thead>
          <tbody>
            {e.map((x) => (
              <tr key={x.exit} className="border-t border-line">
                <td className="py-1.5 text-ink">{x.label}</td>
                <td className="py-1.5 text-right text-ink-2">{x.chosenBy} {x.chosenBy === 1 ? 'strategy' : 'strategies'}</td>
                <td className={`py-1.5 text-right ${tone(x.inDeltaR)}`}>{signed(x.inDeltaR, 2)}</td>
                <td className={`py-1.5 text-right font-semibold ${tone(x.outDeltaR)}`}>{signed(x.outDeltaR, 2)}</td>
                <td className="py-1.5 text-right text-ink-2">{x.outBetterPct}% of {x.compared}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/** The signal judge: a learned model that scores every signal from its context. */
export function JudgeCard({ j }: { j: JudgeReport | null | undefined }) {
  if (!j) return null;
  return (
    <Card
      title="Signal judge"
      subtitle="A learning model (boosted trees) that scores every signal from its context: currency strength, bigger-chart trend, mood, how wild the market is, the hour, distance from the averages, the strategy's recent results. It learns on the first 70% and must prove itself on the unseen 30% before the bot listens to it."
      action={<Badge tone={j.active ? 'up' : 'neutral'}>{j.active ? 'On: the bot uses it' : 'Off: not proven yet'}</Badge>}
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile compact label="Unseen trades" value={j.tested.toLocaleString()} sub={`learned from ${j.trainedOn.toLocaleString()}`} />
        <StatTile compact label="Ranking skill (AUC)" value={j.auc === null ? '—' : j.auc.toFixed(2)} sub="0.50 = coin flip" tone={j.auc !== null && j.auc >= 0.55 ? 'up' : undefined} />
        <StatTile compact label="Trades it keeps" value={`${j.keepPct}%`} sub={`win rate ${j.keptWinPct}% vs ${j.allWinPct}%`} />
        <StatTile compact label="R per trade, kept" value={`${signed(j.keptR, 2)}R`} sub={`all ${signed(j.allR, 2)}R · skipped ${signed(j.skippedR, 2)}R`} tone={j.keptR > j.allR ? 'up' : undefined} />
      </div>
      <p className="mt-3 text-sm text-ink-2">{j.why}.</p>
      {j.importance.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">What it looks at most</div>
          <div className="flex flex-wrap gap-1.5">
            {j.importance.map((x) => (
              <Badge key={x.feature} tone="neutral">{x.label} {x.share}%</Badge>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

const HZ = (h: number) => (h === 1 ? '1 h' : `${h} h`);

/** What prices did after past shock candles (big news hours). */
export function NewsStudyCard({ n }: { n: NewsStudy | null | undefined }) {
  const [more, setMore] = useState(false);
  if (!n) return null;
  if (!n.shocks) return <Card title="After big moves"><p className="text-sm text-ink-2">No shock candles found yet in the loaded history.</p></Card>;
  const cellRow = (key: string, label: string, c: StudyCell) => (
    <tr key={key} className="border-t border-line">
      <td className="py-1.5 text-ink">{label} <span className="text-xs text-muted">({c.n})</span></td>
      {c.avgAtr.map((v, k) => (
        <td key={k} className={`py-1.5 text-right ${tone(v)}`}>{signed(v, 2)} <span className="text-xs text-muted">{c.contPct[k]}%</span></td>
      ))}
    </tr>
  );
  return (
    <Card
      title="After big moves"
      subtitle={`${n.shocks.toLocaleString()} shock candles (2.2× the normal hourly range, closing near the extreme) on 2 years of hourly charts. Numbers = how far price went on in the shock's direction afterwards, in normal hourly ranges; the % = how often it was still past the shock's close. Positive = the move kept going (the News drift strategy), negative = it came back (News fade).`}
    >
      <div className="overflow-x-auto">
        <table className="tabular w-full min-w-[34rem] text-sm">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th className="py-1 font-medium">When</th>
              {n.horizons.map((h) => (
                <th key={h} className="py-1 text-right font-medium">after {HZ(h)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cellRow('all', 'All shocks', n.overall)}
            {n.byHour.map((x) => cellRow(x.key, x.label, x))}
            {more && n.byEvent.map((x) => cellRow(`e-${x.key}`, x.label, x))}
            {more && n.byPair.map((x) => cellRow(`p-${x.pair}`, x.pair, x))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted">{n.eventsKnown ? `${n.eventsKnown} calendar releases recorded so far; shocks in their hour are split by kind of news.` : 'The split by kind of news (CPI, jobs, rate decisions) builds up as the calendar history grows.'}</p>
        <Button size="sm" variant="ghost" onClick={() => setMore(!more)}>{more ? 'Less' : 'By news type and market'}</Button>
      </div>
      {more && n.recent.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Latest shocks</div>
          <Rows>
            {n.recent.map((x) => (
              <Row key={`${x.pair}${x.t}`} label={`${x.dir === 1 ? '▲' : '▼'} ${x.pair} · ${x.sizeAtr}× normal`} sub={`${ago(new Date(x.t).toISOString())}${x.event ? ` · ${x.event}` : ''}`} value={x.moves[1] === null ? <span className="text-xs text-muted">running</span> : <span className={tone(x.moves[1]!)}>{signed(x.moves[1]!, 2)} after 4 h</span>} />
            ))}
          </Rows>
        </div>
      )}
    </Card>
  );
}

/** The whole bot on the unseen weeks, at several risk levels, against the bot before v13. */
export function PortfolioCard({ p, judgeOn }: { p: PortfolioReport | null | undefined; judgeOn?: boolean }) {
  const [showPicked, setShowPicked] = useState(false);
  if (!p) return <Card title="Honest test of the whole bot"><p className="text-sm text-ink-2">Runs with the next hourly update.</p></Card>;
  const one = p.levels.find((x) => x.baseRiskPct === 1) ?? p.levels[0]!;
  const o = p.old;
  return (
    <Card title={`Honest test: the whole bot on ${one.weeks} weeks it never saw`} subtitle={`${day(p.from)} → ${day(p.to)}. ${p.note}`}>
      <Stack>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile compact label="Average week (1% risk)" value={`${signed(one.avgWeekPct)}%`} sub={`median ${signed(one.medianWeekPct)}%`} tone={one.avgWeekPct > 0 ? 'up' : 'down'} spark={one.equity} />
          <StatTile compact label="Green weeks" value={`${one.greenWeeksPct}%`} sub={`${one.weeks5Pct}% of weeks ≥ +5%`} />
          <StatTile compact label="Worst week" value={`${signed(one.worstWeekPct)}%`} sub={`biggest drop −${one.maxDdPct}%`} tone="down" />
          <StatTile compact label="Over the period" value={`${signed(one.totalPct, 0)}%`} sub={`${one.trades} trades · avg month ${signed(one.avgMonthPct)}%`} tone={one.totalPct > 0 ? 'up' : 'down'} />
        </div>
        <div className="overflow-x-auto">
          <table className="tabular w-full min-w-[40rem] text-sm">
            <thead>
              <tr className="text-left text-xs text-muted">
                <th className="py-1 font-medium">Risk / trade</th>
                <th className="py-1 text-right font-medium">Avg week</th>
                <th className="py-1 text-right font-medium">Median</th>
                <th className="py-1 text-right font-medium">Green</th>
                <th className="py-1 text-right font-medium">+10% wks</th>
                <th className="py-1 text-right font-medium">Avg month</th>
                <th className="py-1 text-right font-medium">Worst week</th>
                <th className="py-1 text-right font-medium">Max drop</th>
                <th className="py-1 text-right font-medium">End</th>
              </tr>
            </thead>
            <tbody>
              {[...p.levels, ...(p.judged ? [p.judged] : []), ...(p.convicted ? [p.convicted] : []), ...(p.sniped ? [p.sniped] : []), o].map((k) => (
                <tr key={k.label} className={`border-t border-line ${k === o ? 'text-muted' : ''}`}>
                  <td className="py-1.5 text-ink">{k === o ? 'Before the upgrade (1%)' : k === p.judged ? `With the signal judge (1%${judgeOn ? '' : ', judge not on yet'})` : k === p.convicted ? 'Bigger size when sure (1%, sure 1.5×, very sure 2×)' : k === p.sniped ? `With the sniper (1%, ${k.label.replace(/^sniper \(|\)$/g, '')})` : k.label.includes('(') ? k.label.replace(' risk', '') : `${k.baseRiskPct}%`}</td>
                  <td className={`py-1.5 text-right ${tone(k.avgWeekPct)}`}>{signed(k.avgWeekPct)}%</td>
                  <td className={`py-1.5 text-right ${tone(k.medianWeekPct)}`}>{signed(k.medianWeekPct)}%</td>
                  <td className="py-1.5 text-right">{k.greenWeeksPct}%</td>
                  <td className="py-1.5 text-right">{k.bigWeeksPct}%</td>
                  <td className={`py-1.5 text-right ${tone(k.avgMonthPct)}`}>{signed(k.avgMonthPct)}%</td>
                  <td className="py-1.5 text-right text-down">{signed(k.worstWeekPct)}%</td>
                  <td className="py-1.5 text-right">−{k.maxDdPct}%</td>
                  <td className={`py-1.5 text-right font-semibold ${k.blown ? 'text-down' : tone(k.finalX - 1)}`}>{k.blown ? 'wiped' : `${k.finalX}×`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {one.mc && (
          <p className="rounded-xl border border-line bg-surface-2/40 p-3 text-sm text-ink-2">
            <span className="font-semibold text-ink">Next 3 months at 1% risk</span> (2,000 reshuffles of these weeks): middle case <span className={tone(one.mc.quarterMedian)}>{signed(one.mc.quarterMedian)}%</span>, bad case (1 in 10) <span className={tone(one.mc.quarterP10)}>{signed(one.mc.quarterP10)}%</span>, good case (1 in 10) <span className={tone(one.mc.quarterP90)}>{signed(one.mc.quarterP90)}%</span>. Chance of ending down {one.mc.pLoss}%, of a 20%+ drop on the way {one.mc.pDd20}%.
          </p>
        )}
        <p className="text-xs text-muted">
          The bot before this upgrade (no checks, every trade 1%, no currency limit) on the same weeks: {signed(o.avgWeekPct)}% a week, worst week {signed(o.worstWeekPct)}%, biggest drop −{o.maxDdPct}%. Slots were full {one.skipped.full.toLocaleString()} times, {one.skipped.ccy} trades were skipped for piling onto one currency{one.skipped.strategy ? ` and ${one.skipped.strategy} because one strategy already had 3 open` : ''}. Past weeks don't promise future ones; the paper results are the real test.
        </p>
        {p.walkForward && <WalkForwardBox w={p.walkForward} />}
        <div>
          <Button size="sm" variant="ghost" onClick={() => setShowPicked(!showPicked)}>{showPicked ? 'Hide' : 'Show'} the {p.picked.length} strategies it picked</Button>
          {showPicked && (
            <Rows className="mt-2">
              {p.picked.map((x) => (
                <Row key={`${x.id}:${x.tf}`} label={`${x.name} · ${x.tf}`} sub={`${FILTER_SHORT[x.filter]}${x.exit && x.exit !== 'designed' ? ` · ${EXIT_SHORT[x.exit]}` : ''} · first 70%: ${x.inN} trades, ${signed(x.inAvgR, 2)}R each`} value={`${x.unseenN} unseen trades`} />
              ))}
            </Rows>
          )}
        </div>
      </Stack>
    </Card>
  );
}

/** Rolling test: strategies re-picked every month from the months before, over the whole history. */
function WalkForwardBox({ w }: { w: WalkForward }) {
  const k = w.result;
  return (
    <div className="rounded-xl border border-line p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-sm font-semibold text-ink">Rolling test: {k.weeks} weeks, re-picked every month</div>
        <div className={`tabular text-sm font-semibold ${tone(k.totalPct)}`}>{signed(k.totalPct, 0)}% at 1% risk</div>
      </div>
      <p className="mt-1 text-xs text-muted">At the start of every month it picks the strategies whose trades in the previous {w.lookbackMonths} months were good, and trades only those that month. Nothing a month uses comes from that month or later, so this is a much longer fair test ({day(w.from)} → {day(w.to)}).</p>
      <div className="mt-2 grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
        <div><div className="text-xs text-muted">Avg week</div><div className={`tabular font-semibold ${tone(k.avgWeekPct)}`}>{signed(k.avgWeekPct)}%</div></div>
        <div><div className="text-xs text-muted">Green weeks</div><div className="tabular font-semibold text-ink">{k.greenWeeksPct}%</div></div>
        <div><div className="text-xs text-muted">Avg month</div><div className={`tabular font-semibold ${tone(k.avgMonthPct)}`}>{signed(k.avgMonthPct)}%</div></div>
        <div><div className="text-xs text-muted">Worst month</div><div className="tabular font-semibold text-down">{signed(k.worstMonthPct)}%</div></div>
        <div><div className="text-xs text-muted">Biggest drop</div><div className="tabular font-semibold text-ink">−{k.maxDdPct}%</div></div>
      </div>
      {k.equity.length > 1 && <Sparkline points={k.equity} width={600} height={44} tone={k.finalX >= 1 ? 'up' : 'down'} className="mt-2 w-full" />}
    </div>
  );
}

/** Risk the bot carries right now, per currency, against the cap. */
export function RiskCard({ r }: { r: RiskSummary | null | undefined }) {
  if (!r) return null;
  return (
    <Card title="Risk right now" subtitle={`What the bot loses if every stop is hit, per currency. Buying EUR/USD is a bet on EUR and against USD, so two dollar trades are one bigger bet; no currency may carry more than ${r.capPct}% of the account in one direction.`}>
      {!r.exposure.length ? (
        <p className="text-sm text-ink-2">No risk on: nothing open, or every stop is already in profit.</p>
      ) : (
        <ul className="space-y-2">
          {r.exposure.map((x) => {
            const full = Math.min(100, (Math.abs(x.pct) / r.capPct) * 100);
            return (
              <li key={x.ccy} className="grid grid-cols-[3rem_1fr_6.5rem] items-center gap-2 text-sm">
                <span className="font-semibold text-ink">{x.ccy}</span>
                <div className="h-2.5 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
                  <div className={`h-full rounded-full ${full >= 90 ? 'bg-critical' : full >= 60 ? 'bg-warning' : 'bg-accent'}`} style={{ width: `${Math.max(3, full)}%` }} />
                </div>
                <span className="tabular text-right text-ink-2">{x.pct > 0 ? 'long' : 'short'} {Math.abs(x.pct).toFixed(2)}%</span>
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-3 grid grid-cols-3 gap-3 text-sm">
        <div><div className="text-xs text-muted">Open risk</div><div className="tabular font-semibold text-ink">{r.openRiskPct.toFixed(2)}%</div></div>
        <div><div className="text-xs text-muted">Under its peak</div><div className={`tabular font-semibold ${r.ddPct > 8 ? 'text-down' : 'text-ink'}`}>{r.ddPct.toFixed(1)}%</div></div>
        <div><div className="text-xs text-muted">New trade size</div><div className={`tabular font-semibold ${r.ddFactor < 1 ? 'text-warning' : 'text-ink'}`}>×{r.ddFactor}</div></div>
      </div>
    </Card>
  );
}

/** Small trend arrows for the 1h / 4h / daily charts. */
export function TrendArrows({ mtf }: { mtf: { h1: number; h4: number; d1: number } | undefined }) {
  if (!mtf) return null;
  const a = (x: number) => (x > 0 ? <span className="text-up">▲</span> : x < 0 ? <span className="text-down">▼</span> : <span className="text-muted">–</span>);
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-ink-2" title="Trend on the 1-hour, 4-hour and daily chart">
      1h {a(mtf.h1)} 4h {a(mtf.h4)} 1D {a(mtf.d1)}
    </span>
  );
}

/** Sparkline helper for the equity of a level (exported for reuse). */
export function EquityLine({ points }: { points: number[] }) {
  return <Sparkline points={points} width={260} height={48} tone={points[points.length - 1]! >= 1 ? 'up' : 'down'} className="w-full" />;
}

/** v15.2: bigger size + leverage when the bot is more sure — per chart group, only once proven on unseen data. */
export function ConvictionCard({ c }: { c: Partial<Record<'hourly' | '15m' | '1m', ConvictionReport | null>> | null | undefined }) {
  const groups = (['hourly', '15m', '1m'] as const).map((k) => [k, c?.[k] ?? null] as const).filter(([, v]) => v);
  return (
    <Card
      title="Bigger size when it's more sure"
      subtitle="How sure = how many things back the entry at the candle close: the stronger currency, the bigger charts' trend, the market mood, and on the hourly / 4-hour charts the signal judge's score. 'Sure' (3+) trades 1.5× bigger at 50× leverage, 'very sure' 2× (max 2% of the account) at 100× — but only after those trades made clearly more (≥ 0.1R each, 60+ trades) on history the bot never saw."
    >
      {!groups.length ? (
        <p className="text-sm text-ink-2">Measured with the next hourly update.</p>
      ) : (
        <Stack>
          {groups.map(([k, r]) => (
            <div key={k}>
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <span className="font-medium text-ink">{k === 'hourly' ? 'Hourly + 4-hour charts' : k === '15m' ? '15-minute chart' : '1-minute chart'}</span>
                <Badge tone={r!.active ? 'up' : 'neutral'}>{r!.active ? 'On: bigger size when sure' : 'Off: normal size'}</Badge>
              </div>
              <p className="text-sm text-ink-2">{r!.why}.</p>
              {r!.all.outN > 0 && (
                <div className="mt-2 overflow-x-auto">
                  <table className="tabular w-full min-w-[30rem] text-sm">
                    <thead>
                      <tr className="text-left text-xs text-muted">
                        <th className="py-1 font-medium">Trades</th>
                        <th className="py-1 text-right font-medium">Checks agreeing</th>
                        <th className="py-1 text-right font-medium">Unseen R / trade</th>
                        <th className="py-1 text-right font-medium">Size · leverage</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-t border-line">
                        <td className="py-1.5 text-ink">All</td>
                        <td className="py-1.5 text-right text-muted">any</td>
                        <td className={`py-1.5 text-right ${tone(r!.all.outAvgR)}`}>{signed(r!.all.outAvgR, 2)}R <span className="text-xs text-muted">({r!.all.outN})</span></td>
                        <td className="py-1.5 text-right text-ink-2">1× · 30×</td>
                      </tr>
                      {r!.tiers.map((t) => (
                        <tr key={t.tier} className={`border-t border-line ${t.active ? 'font-semibold' : ''}`}>
                          <td className="py-1.5 text-ink">{t.label === 'sure' ? 'Sure' : 'Very sure'}{t.active ? ' ✓' : ''}</td>
                          <td className="py-1.5 text-right text-muted">{t.from}+</td>
                          <td className={`py-1.5 text-right ${tone(t.outAvgR)}`}>{signed(t.outAvgR, 2)}R <span className="text-xs font-normal text-muted">({t.outN})</span></td>
                          <td className="py-1.5 text-right text-ink-2">{t.active ? `${t.mult}× · ${t.lev}×` : 'normal'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
        </Stack>
      )}
    </Card>
  );
}

export interface SniperLevel { k: number; inN: number; inAvgR: number; outN: number; outAvgR: number; outPf: number | null }
export interface SniperReport { active: boolean; k: number | null; levels: SniperLevel[]; all: { inN: number; inAvgR: number; outN: number; outAvgR: number }; riskPct: number; leverage: number; why: string }

/** v16: the sniper — one big bet only when many independent checks agree, and only once that proved itself. */
export function SniperCard({ s }: { s: SniperReport | null | undefined }) {
  return (
    <Card
      title="Sniper: one big bet when everything agrees"
      subtitle="Every trade gets a vote from each independent check at the candle close: stronger currency, bigger charts, market mood, momentum on 1 / 5 / 20 days, carry (interest-rate gap), the volatility forecast, the trend / chop measure, hedge-fund positioning (CFTC), room to the next round number, and the signal judge. A vote level is picked on the first 70% of the history; the sniper only turns on if those trades also made 0.3R+ each (profit factor 1.5+) on the 30% it never saw. Then such a trade risks the sniper size, one at a time."
    >
      {!s ? (
        <p className="text-sm text-ink-2">Graded with the next hourly update.</p>
      ) : (
        <Stack>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={s.active ? 'up' : 'neutral'}>{s.active ? `On: ${s.k}+ checks → ${s.riskPct}% risk at ${s.leverage}×` : 'Off: not proven yet, normal size'}</Badge>
          </div>
          <p className="text-sm text-ink-2">{s.why}.</p>
          {s.all.outN > 0 && (
            <div className="overflow-x-auto">
              <table className="tabular w-full min-w-[30rem] text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted">
                    <th className="py-1 font-medium">Checks agreeing</th>
                    <th className="py-1 text-right font-medium">First 70%</th>
                    <th className="py-1 text-right font-medium">Unseen 30%</th>
                    <th className="py-1 text-right font-medium">Profit factor</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-t border-line">
                    <td className="py-1.5 text-ink">All trades</td>
                    <td className={`py-1.5 text-right ${tone(s.all.inAvgR)}`}>{signed(s.all.inAvgR, 2)}R <span className="text-xs text-muted">({s.all.inN})</span></td>
                    <td className={`py-1.5 text-right ${tone(s.all.outAvgR)}`}>{signed(s.all.outAvgR, 2)}R <span className="text-xs text-muted">({s.all.outN})</span></td>
                    <td className="py-1.5 text-right text-muted">—</td>
                  </tr>
                  {s.levels.filter((l) => l.inN > 0 || l.outN > 0).map((l) => (
                    <tr key={l.k} className={`border-t border-line ${s.k === l.k ? 'font-semibold' : ''}`}>
                      <td className="py-1.5 text-ink">{l.k}+{s.k === l.k ? (s.active ? ' ✓' : ' (picked)') : ''}</td>
                      <td className={`py-1.5 text-right ${tone(l.inAvgR)}`}>{signed(l.inAvgR, 2)}R <span className="text-xs font-normal text-muted">({l.inN})</span></td>
                      <td className={`py-1.5 text-right ${tone(l.outAvgR)}`}>{signed(l.outAvgR, 2)}R <span className="text-xs font-normal text-muted">({l.outN})</span></td>
                      <td className="py-1.5 text-right">{l.outPf ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-muted">At {s.riskPct}% risk one sniper loss costs {s.riskPct}% of the account and a 4R winner makes about {s.riskPct * 4}%. Few trades means a lot of luck either way: the paper account decides.</p>
        </Stack>
      )}
    </Card>
  );
}
