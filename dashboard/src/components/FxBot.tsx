/**
 * Forex → Auto-bot (the forex home page, v15): the bot trades its own $1,000 practice account by itself. This page
 * shows what it holds and the plan for each trade, what it is watching and waiting for on every market, and every
 * check it made (also the quiet ones).
 */
import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { api } from '../lib/api';
import { ago } from '../lib/format';
import { Icon } from './Icon';
import { Badge, Button, Card, Empty, Row, Rows, Stack, StatTile, Tabs, Timeline, useTab } from './ui';
import { ConvictionCard, PortfolioCard, RiskCard, RollingCard, SniperCard, type ConvictionReport, type JudgeReport, type Ledger, type PortfolioReport, type RiskSummary, type RollReport, type SniperReport } from './FxInsights';

interface Conviction { tier: 'normal' | 'sure' | 'verySure'; conf: number; of: number; mult: number; lev: number | null }
interface Pos { id: string; pair: string; side: 1 | -1; entry: number; px: number; marginUsd: number; leverage: number; stop: number | null; target: number | null; openedAt: number; pnlUsd: number; pnlPct: number; strategy?: string; riskPct?: number; tf?: string; conviction?: Conviction | null }
interface Closed { id: string; pair: string; side: 1 | -1; entry: number; exit: number; pnlUsd: number; reason: string; closedAt: number; strategy?: string; tf?: string }
interface Acct { startUsd: number; balanceUsd: number; equityUsd: number; marginUsedUsd: number; freeMarginUsd: number; marginLevelPct: number | null; positions: Pos[]; closed: Closed[] }
interface PlanSignal { tf: string; name: string; side: 1 | -1; verdict: string; tone: 'go' | 'wait' | 'no' }
interface PlanMarket { id: string; label: string; price: number | null; status: 'trading' | 'waiting' | 'blocked' | 'watching'; headline: string; lean: { side: 1 | -1 | 0; why: string }; signals: PlanSignal[]; blocks: string[]; watchers: Record<string, number> }
interface PlanLine { k: string; text: string; done?: boolean }
interface PlanTrade { id: string; pair: string; side: 1 | -1; strategy: string; name: string; tf: string; entry: number; px: number; pnlUsd: number; riskPct: number | null; lines: PlanLine[] }
interface RunNote { t: number; tf: string; signals: number; chosen: number; opened: number; skipped: number; waits: number; holding: number; note: string }
interface BotPlan { at: number; summary: string; next: Array<{ tf: string; at: number }>; markets: PlanMarket[]; trades: PlanTrade[]; timeline: RunNote[]; trading: Record<string, number> }
type RiskMode = 'normal' | 'aggressive' | 'max';
interface RiskLimits { label: string; riskPct: number; leverage: number; maxOpen: number; ccyCapPct: number; maxPerStrategy: number; convMaxRiskPct: number }
interface Data { rolling?: RollReport | null; chooser?: string; ledger?: Ledger; names?: Record<string, string>; sniper?: SniperReport | null; riskMode?: RiskMode; riskModes?: Record<RiskMode, RiskLimits>; plan?: BotPlan | null; account: Acct | null; risk?: RiskSummary | null; portfolio?: PortfolioReport | null; judge?: JudgeReport | null; conviction?: Partial<Record<'hourly' | '15m' | '1m', ConvictionReport | null>> | null; log: Array<{ t: number; e: string }>; chosen: string[]; dropped?: string[] }

const dp = (id: string) => (id.includes('JPY') ? 3 : id === 'XAUUSD' ? 2 : id === 'XAGUSD' ? 3 : 5);
const usd = (x: number) => `${x < 0 ? '−' : ''}$${Math.abs(x).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const tone = (x: number) => (x > 0 ? 'text-up' : x < 0 ? 'text-down' : 'text-ink-2');
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const REASON: Record<string, string> = { partial: 'part taken', weekend: 'paused for the weekend', signal: 'strategy exit', 'stop-out': 'margin call', stop: 'stop', target: 'target' };
const STATUS: Record<PlanMarket['status'], { label: string; tone: 'up' | 'warn' | 'neutral' | 'down' }> = {
  trading: { label: 'In a trade', tone: 'up' },
  waiting: { label: 'Waiting', tone: 'warn' },
  watching: { label: 'Watching', tone: 'neutral' },
  blocked: { label: 'Paused', tone: 'down' },
};

export function FxBot() {
  const { data, reload } = useApi<Data>('/api/forex/bot', 10_000);
  const a = data?.account;
  const plan = data?.plan ?? null;
  const wins = a ? a.closed.filter((x) => x.pnlUsd > 0 && x.reason !== 'partial').length : 0;
  const closedN = a ? a.closed.filter((x) => x.reason !== 'partial').length : 0;
  const reset = async () => {
    if (!confirm("Reset the bot's account to $1,000? Its positions and history are cleared.")) return;
    await api('/api/forex/practice/reset', { method: 'POST', body: JSON.stringify({ startUsd: 1000, acct: 'bot' }) });
    await reload();
  };
  const close = async (id: string) => {
    if (!confirm('Close this trade now at the market price? The bot normally closes it by itself.')) return;
    await api('/api/forex/practice/close', { method: 'POST', body: JSON.stringify({ id, acct: 'bot' }) });
    await reload();
  };
  return (
    <Stack>
      <PlanHero plan={plan} />
      {a && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile compact label="Equity" value={usd(a.equityUsd)} sub={`started ${usd(a.startUsd)}`} tone={a.equityUsd > a.startUsd ? 'up' : a.equityUsd < a.startUsd ? 'down' : undefined} />
          <StatTile compact label="Profit" value={usd(a.equityUsd - a.startUsd)} sub={`${((a.equityUsd / a.startUsd - 1) * 100).toFixed(1)}%`} tone={a.equityUsd >= a.startUsd ? 'up' : 'down'} />
          <StatTile compact label="Closed trades" value={`${closedN}`} sub={closedN ? `${Math.round((wins / closedN) * 100)}% won` : 'none yet'} />
          <StatTile compact label="Open" value={`${a.positions.length}`} sub={`margin ${usd(a.marginUsedUsd)}`} />
        </div>
      )}
      <RiskModeCard mode={data?.riskMode ?? 'normal'} modes={data?.riskModes} portfolio={data?.portfolio ?? null} onChange={() => void reload()} />
      <TradesCard plan={plan} positions={a?.positions ?? []} onClose={(id) => void close(id)} />
      <MarketsCard plan={plan} />
      <ChecksCard plan={plan} log={data?.log ?? []} />
      <RollingCard r={data?.rolling} chooser={data?.chooser} ledger={data?.ledger} names={data?.names} />
      <SniperCard s={data?.sniper} />
      <ConvictionCard c={data?.conviction} />
      <PortfolioCard p={data?.portfolio} judgeOn={!!data?.judge?.active} />
      <RiskCard r={data?.risk} />
      <HowItWorks judgeOn={!!data?.judge?.active} dropped={data?.dropped ?? []} plan={plan} />
      <Card title="Closed trades" action={<Button size="sm" variant="ghost" onClick={() => void reset()}>Reset to $1,000</Button>}>
        {!a?.closed.length ? <p className="text-sm text-ink-2">None yet.</p> : (
          <Rows>
            {a.closed.slice(0, 60).map((x) => (
              <Row key={x.id} label={`${x.side === 1 ? 'Long' : 'Short'} ${x.pair} · ${x.strategy ?? 'manual'}${x.tf ? ` (${x.tf})` : ''}`} sub={`${x.entry.toFixed(dp(x.pair))} → ${x.exit.toFixed(dp(x.pair))} · ${REASON[x.reason] ?? x.reason} · ${ago(new Date(x.closedAt).toISOString())}`} value={<span className={tone(x.pnlUsd)}>{usd(x.pnlUsd)}</span>} />
            ))}
          </Rows>
        )}
      </Card>
    </Stack>
  );
}

const MODE_NOTE: Record<RiskMode, string> = {
  normal: 'Steady: small losses, slow growth.',
  aggressive: 'Three times the risk: aims for 10%+ months, and losing months get three times bigger too.',
  max: 'Five times the risk: big months and big drops. A bad streak can halve the account.',
};

/** v15.6: how hard the bot trades — same strategies and checks, only the size and how many trades at once change. */
function RiskModeCard({ mode, modes, portfolio, onChange }: { mode: RiskMode; modes?: Record<RiskMode, RiskLimits>; portfolio: PortfolioReport | null; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  if (!modes) return null;
  const pick = async (m: RiskMode) => {
    if (m === mode || busy) return;
    if (m !== 'normal' && !confirm(`${modes[m].label}: ${modes[m].riskPct}% of the account at risk on every trade, up to ${modes[m].maxOpen} trades at once. Losing streaks hit ${modes[m].riskPct}× harder. Switch?`)) return;
    setBusy(true);
    try {
      await api('/api/forex/bot/mode', { method: 'POST', body: JSON.stringify({ mode: m }) });
      onChange();
    } finally {
      setBusy(false);
    }
  };
  const test = (m: RiskMode) => portfolio?.levels.find((x) => x.baseRiskPct === modes[m].riskPct) ?? null;
  const pct = (x: number) => `${x > 0 ? '+' : ''}${x.toFixed(1)}%`;
  return (
    <Card title="How hard it trades" subtitle="Same strategies and safety checks in every mode. Only the risk per trade, the leverage and how many trades it holds at once change. New trades use the new mode; open ones keep their size.">
      <div className="grid grid-cols-3 gap-2">
        {(Object.keys(modes) as RiskMode[]).map((m) => (
          <Button key={m} size="sm" variant={m === mode ? 'primary' : 'outline'} disabled={busy} onClick={() => void pick(m)}>
            {modes[m].label}
          </Button>
        ))}
      </div>
      <p className="mt-3 text-sm text-ink">{MODE_NOTE[mode]}</p>
      <Rows>
        {(Object.keys(modes) as RiskMode[]).map((m) => {
          const t = test(m);
          return (
            <Row
              key={m}
              label={`${modes[m].label}${m === mode ? ' (on)' : ''}: ${modes[m].riskPct}% a trade, ${modes[m].leverage}×, up to ${modes[m].maxOpen} at once`}
              sub={t ? `Honest test on unseen weeks: average month ${pct(t.avgMonthPct)}, worst month ${pct(t.worstMonthPct)}, biggest drop −${t.maxDdPct.toFixed(0)}%${t.blown ? ', account wiped out' : ''}` : 'Honest test: waiting for the next hourly run'}
              value={t ? <span className={tone(t.avgMonthPct)}>{pct(t.avgMonthPct)}/mo</span> : null}
            />
          );
        })}
      </Rows>
    </Card>
  );
}

function PlanHero({ plan }: { plan: BotPlan | null }) {
  return (
    <Card accent>
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent/15 text-accent-text">
          <Icon name="cpu" size={18} />
        </span>
        <div className="min-w-0">
          <div className="font-semibold text-ink">The bot trades by itself. You don't need to do anything.</div>
          <p className="mt-0.5 text-sm text-ink-2">{plan?.summary ?? 'Getting its first look at the markets…'}</p>
        </div>
      </div>
      {plan && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {plan.next.map((n) => (
            <Badge key={n.tf} tone={plan.trading[n.tf] ? 'accent' : 'neutral'} title={plan.trading[n.tf] ? `${plan.trading[n.tf]} strategies it trades on this chart` : 'no strategy has passed its test on this chart yet'}>
              {n.tf} next {clock(n.at)} · {plan.trading[n.tf] ? `${plan.trading[n.tf]} setups` : 'none passed yet'}
            </Badge>
          ))}
        </div>
      )}
    </Card>
  );
}

function TradesCard({ plan, positions, onClose }: { plan: BotPlan | null; positions: Pos[]; onClose: (id: string) => void }) {
  const trades = plan?.trades ?? [];
  return (
    <Card title="Its trades and the plan for each" subtitle="Every rule that can close the trade, in order. The bot does all of it by itself.">
      {!positions.length ? (
        <p className="text-sm text-ink-2">No trade open. It opens one when a strategy that passed its test fires on a candle close and its checks agree (see the markets below).</p>
      ) : (
        <ul className="divide-y divide-line">
          {(trades.length ? trades : positions.map((p) => ({ id: p.id, pair: p.pair, side: p.side, strategy: p.strategy ?? 'bot', name: p.strategy ?? 'bot', tf: p.tf ?? '1h', entry: p.entry, px: p.px, pnlUsd: p.pnlUsd, riskPct: p.riskPct ?? null, lines: [] as PlanLine[] }))).map((t) => (
            <li key={t.id} className="py-3 first:pt-0 last:pb-0">
              <div className="flex items-center gap-2">
                <Badge tone={t.side === 1 ? 'up' : 'down'}>{t.side === 1 ? 'Long' : 'Short'}</Badge>
                <span className="font-medium text-ink">{t.pair}</span>
                <Badge tone="neutral">{t.tf}</Badge>
                {(() => {
                  const cv = positions.find((p) => p.id === t.id)?.conviction;
                  return cv && cv.mult > 1 ? <Badge tone="accent">{cv.tier === 'verySure' ? 'very sure' : 'sure'} · {cv.mult}×</Badge> : null;
                })()}
                <span className="min-w-0 flex-1 truncate text-xs text-muted">{t.name}</span>
                <span className={`tabular shrink-0 font-semibold ${tone(t.pnlUsd)}`}>{usd(t.pnlUsd)}</span>
              </div>
              <div className="mt-0.5 text-xs text-muted">
                in {t.entry.toFixed(dp(t.pair))} → now {t.px.toFixed(dp(t.pair))}{t.riskPct !== null ? ` · risked ${t.riskPct}% of the account` : ''}
              </div>
              {!!t.lines.length && (
                <ol className="mt-2 space-y-1">
                  {t.lines.map((l, k) => (
                    <li key={k} className={`flex gap-2 text-sm ${l.done ? 'text-muted' : 'text-ink-2'}`}>
                      <span aria-hidden="true" className={`mt-0.5 shrink-0 ${l.done ? 'text-up' : 'text-muted'}`}>{l.done ? '✓' : '•'}</span>
                      <span>{l.text}</span>
                    </li>
                  ))}
                </ol>
              )}
              <div className="mt-2 flex justify-end">
                <Button size="sm" variant="ghost" onClick={() => onClose(t.id)}>Close now</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function MarketsCard({ plan }: { plan: BotPlan | null }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!plan) return null;
  return (
    <Card title="What it's watching and waiting for" subtitle="Every market, what the bot is doing there, which way its checks lean and what fired on the latest candle closes. Tap a market for details." padded={false}>
      <ul className="divide-y divide-line border-t border-line">
        {plan.markets.map((m) => {
          const on = open === m.id;
          return (
            <li key={m.id}>
              <button type="button" onClick={() => setOpen(on ? null : m.id)} className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-surface-2/60 sm:px-5" aria-expanded={on}>
                <div className="w-20 shrink-0">
                  <div className="font-medium text-ink">{m.label}</div>
                  {m.price !== null && <div className="tabular text-xs text-muted">{m.price.toFixed(dp(m.id))}</div>}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={STATUS[m.status].tone}>{STATUS[m.status].label}</Badge>
                    {m.lean.side !== 0 && <Badge tone={m.lean.side === 1 ? 'up' : 'down'}>leans {m.lean.side === 1 ? 'buy ▲' : 'sell ▼'}</Badge>}
                    {m.signals.length > 0 && <span className="text-xs text-muted">{m.signals.length} signal{m.signals.length > 1 ? 's' : ''}</span>}
                  </div>
                  <div className="mt-1 text-sm text-ink-2">{m.headline}</div>
                </div>
                <Icon name="chevron" size={16} className={`mt-1 shrink-0 text-muted transition-transform ${on ? '-rotate-90' : 'rotate-90'}`} />
              </button>
              {on && (
                <div className="space-y-3 px-4 pb-4 sm:px-5">
                  <div>
                    <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Which way it leans</div>
                    <p className="text-sm text-ink-2">{m.lean.side === 0 ? 'No side. ' : m.lean.side === 1 ? 'Buy. ' : 'Sell. '}{m.lean.why}.</p>
                  </div>
                  <div>
                    <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Signals on the latest closes</div>
                    {!m.signals.length ? (
                      <p className="text-sm text-ink-2">Nothing fired on the newest 1-minute, 15-minute, hourly or 4-hour candle. It checks again at the next close.</p>
                    ) : (
                      <ul className="space-y-1.5">
                        {m.signals.map((s, k) => (
                          <li key={k} className="flex items-start gap-2 text-sm">
                            <Badge tone="neutral">{s.tf}</Badge>
                            <span className={s.side === 1 ? 'text-up' : 'text-down'}>{s.side === 1 ? '▲' : '▼'}</span>
                            <span className="min-w-0">
                              <span className="text-ink">{s.name}</span>
                              <span className={s.tone === 'go' ? 'text-up' : s.tone === 'wait' ? 'text-warning' : 'text-muted'}> — {s.verdict}</span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  {!!m.blocks.length && (
                    <div>
                      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">What can hold it back</div>
                      <ul className="space-y-1 text-sm text-ink-2">
                        {m.blocks.map((b, k) => (
                          <li key={k}>• {b}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function ChecksCard({ plan, log }: { plan: BotPlan | null; log: Array<{ t: number; e: string }> }) {
  const [tab, setTab] = useTab('fx.bot.checks', ['checks', 'decisions'] as const, 'checks');
  const runs = plan?.timeline ?? [];
  return (
    <Card title="What it did" subtitle="Every check on a candle close (also when nothing happened) and every decision, newest first.">
      <Tabs tabs={[{ key: 'checks', label: 'Checks', badge: runs.length || null }, { key: 'decisions', label: 'Decisions', badge: log.length || null }]} value={tab} onChange={setTab} className="mb-3" />
      {tab === 'checks' ? (
        !runs.length ? <Empty icon={<Icon name="clock" size={18} />}>No checks yet. The first comes on the next candle close.</Empty> : (
          <Timeline
            items={runs.slice(0, 30).map((r, k) => ({
              key: `${r.t}:${r.tf}:${k}`,
              when: clock(r.t),
              title: (
                <span>
                  <Badge tone="neutral" className="mr-1.5">{r.tf === '1h' ? '1h + 4h' : r.tf}</Badge>
                  {r.note}
                </span>
              ),
              tone: r.opened ? 'up' : r.waits || r.skipped ? 'accent' : 'muted',
            }))}
          />
        )
      ) : !log.length ? (
        <Empty icon={<Icon name="clock" size={18} />}>No decisions yet.</Empty>
      ) : (
        <Rows>
          {log.slice(0, 30).map((l, k) => (
            <Row key={k} label={l.e} value={<span className="text-xs text-muted">{ago(new Date(l.t).toISOString())}</span>} />
          ))}
        </Rows>
      )}
    </Card>
  );
}

function HowItWorks({ judgeOn, dropped, plan }: { judgeOn: boolean; dropped: string[]; plan: BotPlan | null }) {
  return (
    <Card title="How it trades">
      <p className="text-sm text-ink-2">
        It checks every market on four charts: <span className="font-semibold text-ink">1-minute, 15-minute, hourly and 4-hour</span>, right after each candle closes. A strategy is only used on a chart where it passed its test on that chart's unseen history (and the four with published evidence on the hourly / 4-hour charts). When one fires and its checks agree (stronger currency, bigger chart, market mood — whichever that strategy proved it needs), the bot opens the trade with that strategy's stop and exits. Fake money, real prices.
      </p>
      <p className="mt-2 text-sm text-ink-2">
        Exits: each strategy uses the exit that tested best for it. Where it tests as well, that is a <span className="font-semibold text-ink">trailing stop-loss</span>: the stop moves up with the trade from the start (break-even at +1R, +1R locked at +2R…) and never back, so a winner that turns around still closes in profit — and at the target it keeps trailing instead of closing. Next choice: a <span className="font-semibold text-ink">trailing take-profit</span> (the stop locks in profit at the target and trails from there). Others take half off at the target, use a bigger target, or move the stop to break-even.
      </p>
      <p className="mt-2 text-sm text-ink-2">
        Size: about <span className="font-semibold text-ink">1% of the account at risk</span> per trade, more for proven strategies, less for unproven ones, half when a market is far wilder than normal, smaller after the account drops 8%+. When it is more sure of an entry (3+ checks agree) it trades <span className="font-semibold text-ink">bigger at higher leverage</span> — 1.5× at 50×, 2× at 100×, never more than 2% of the account — but only once those trades proved themselves on unseen history (see "Bigger size when it's more sure"). Never more than 2.2% on one currency, 3 trades per strategy, 3 on the 15-minute chart, 2 on the 1-minute chart, 8 in total. The signal judge {judgeOn ? <span className="font-semibold text-ink">is on</span> : 'is off until it proves itself'} for hourly / 4-hour signals.
      </p>
      <p className="mt-2 text-sm text-ink-2">It waits around big news and speeches, skips bank holidays, price shocks and the daily rollover, opens nothing in the last 2 hours of the week, pauses everything 30 min before the Friday close and re-opens what is still running after Monday's open. A strategy that lost money over 12+ of its trades on a chart is dropped there.</p>
      <p className="mt-2 text-xs text-muted">On the 1-minute chart the spread is a big part of every move: a strategy only trades there if it still wins after paying it.{plan ? ` Setups in use: ${Object.entries(plan.trading).map(([tf, n]) => `${tf} ${n}`).join(' · ') || 'none yet'}.` : ''}</p>
      {!!dropped.length && <p className="mt-2 text-xs text-down">Dropped for losing: {dropped.join(', ')}</p>}
    </Card>
  );
}
