/**
 * Forex → Auto-bot (the forex home page, v15): the bot trades its own $1,000 practice account by itself. This page
 * shows what it holds and the plan for each trade, what it is watching and waiting for on every market, and every
 * check it made (also the quiet ones).
 * v17.8 (owner: "see much easier if the bot is in a trade … the active trade and graph it's in … a PnL and calendar
 * view"): a big "In a trade" / "Not in a trade" header, the selected trade's live chart + plan, then profit and loss.
 * v17.9 (owner: "see the price actively change"): open P&L and prices move with the bot's live price push.
 */
import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { liveOf, livePnl, useFxLive } from '../hooks/useFxLive';
import { api } from '../lib/api';
import { ago } from '../lib/format';
import { FxActiveTrade, fxUsd, sinceOpen } from './FxActiveTrade';
import { FxPnl } from './FxPnl';
import { ReadChip, useTradeReads, type ReadsData } from './FxTradeRead';
import { Icon } from './Icon';
import { LiveBadge, LivePrice } from './LivePrice';
import { Badge, Button, Card, Empty, Row, Rows, Stack, StatTile, Tabs, Timeline, useTab } from './ui';
import { AdvancedFold, FxBrief } from './FxBrief';
import { ConvictionCard, DeskCard, PortfolioCard, RiskCard, RollingCard, SniperCard, type ConvictionReport, type DeskReport, type JudgeReport, type Ledger, type PortfolioReport, type RiskSummary, type RollReport, type SniperReport } from './FxInsights';

interface Conviction { tier: 'normal' | 'sure' | 'verySure'; conf: number; of: number; mult: number; lev: number | null }
interface Pos { id: string; pair: string; side: 1 | -1; entry: number; px: number; /** v17.9 */ pnlPerPx?: number; units?: number; marginUsd: number; leverage: number; stop: number | null; target: number | null; openedAt: number; pnlUsd: number; pnlPct: number; strategy?: string; riskPct?: number; tf?: string; conviction?: Conviction | null; sniper?: { votes: number; of: number } | null; closePending?: { reason: string; at: number } | null; /** v17.11 profit lock */ lock?: { at: number; to: number; gap: number } | null; locked?: boolean }
interface Closed { id: string; pair: string; side: 1 | -1; entry: number; exit: number; pnlUsd: number; reason: string; closedAt: number; strategy?: string; tf?: string }
interface Order { id: string; pair: string; side: 1 | -1; limit: number; kind: 'limit' | 'pullback'; placedAt: number; expiresAt: number; strategy: string; tf?: string; stop: number; target: number | null; riskPct: number }
interface Acct { startUsd: number; balanceUsd: number; equityUsd: number; marginUsedUsd: number; freeMarginUsd: number; marginLevelPct: number | null; positions: Pos[]; closed: Closed[]; /** v18.4 resting limit orders */ orders?: Order[] }
interface PlanSignal { tf: string; name: string; side: 1 | -1; verdict: string; tone: 'go' | 'wait' | 'no' }
interface PlanMarket { id: string; label: string; price: number | null; status: 'trading' | 'waiting' | 'blocked' | 'watching'; headline: string; lean: { side: 1 | -1 | 0; why: string }; signals: PlanSignal[]; blocks: string[]; watchers: Record<string, number> }
interface PlanLine { k: string; text: string; done?: boolean }
interface PlanTrade { id: string; pair: string; side: 1 | -1; strategy: string; name: string; tf: string; entry: number; px: number; pnlUsd: number; riskPct: number | null; lines: PlanLine[] }
interface RunNote { t: number; tf: string; signals: number; chosen: number; opened: number; skipped: number; waits: number; holding: number; note: string }
interface BotPlan { at: number; summary: string; next: Array<{ tf: string; at: number }>; markets: PlanMarket[]; trades: PlanTrade[]; timeline: RunNote[]; trading: Record<string, number> }
type RiskMode = 'normal' | 'aggressive' | 'max';
interface RiskLimits { label: string; riskPct: number; leverage: number; maxOpen: number; ccyCapPct: number; maxPerStrategy: number; convMaxRiskPct: number }
interface Data { labError?: { t: number; msg: string } | null; desk?: DeskReport | null; rolling?: RollReport | null; chooser?: string; ledger?: Ledger; names?: Record<string, string>; sniper?: SniperReport | null; riskMode?: RiskMode; riskModes?: Record<RiskMode, RiskLimits>; plan?: BotPlan | null; account: Acct | null; risk?: RiskSummary | null; portfolio?: PortfolioReport | null; judge?: JudgeReport | null; conviction?: Partial<Record<'hourly' | '15m' | '1m', ConvictionReport | null>> | null; log: Array<{ t: number; e: string }>; chosen: string[]; dropped?: string[] }

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
  // v17.8: 5 s — the "in a trade" header and the open trade's P&L are live
  const { data, reload } = useApi<Data>('/api/forex/bot', 5_000);
  const [sel, setSel] = useState<string | null>(null);
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
  const positions = a?.positions ?? [];
  const selected = positions.find((p) => p.id === sel) ?? positions[0] ?? null;
  // v17.14: every open trade's live read + AI read
  const reads = useTradeReads('bot', positions.length > 0);
  // tapping a trade in the header shows it in the chart card (scrolled into view when that card is off screen)
  const pick = (id: string) => {
    setSel(id);
    requestAnimationFrame(() => {
      const el = document.getElementById('fx-active-trade');
      const top = el?.getBoundingClientRect().top ?? 0;
      if (el && (top < 0 || top > window.innerHeight * 0.55)) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };
  // the old account tiles: only when the server has no P&L report yet (older bot)
  const tiles = a ? (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatTile compact label="Equity" value={usd(a.equityUsd)} sub={`started ${usd(a.startUsd)}`} tone={a.equityUsd > a.startUsd ? 'up' : a.equityUsd < a.startUsd ? 'down' : undefined} />
      <StatTile compact label="Profit" value={usd(a.equityUsd - a.startUsd)} sub={`${((a.equityUsd / a.startUsd - 1) * 100).toFixed(1)}%`} tone={a.equityUsd >= a.startUsd ? 'up' : 'down'} />
      <StatTile compact label="Closed trades" value={`${closedN}`} sub={closedN ? `${Math.round((wins / closedN) * 100)}% won` : 'none yet'} />
      <StatTile compact label="Open" value={`${a.positions.length}`} sub={`margin ${usd(a.marginUsedUsd)}`} />
    </div>
  ) : null;
  return (
    <Stack>
      <BotHero plan={plan} a={a ?? null} loaded={!!data} selectedId={selected?.id ?? null} onPick={pick} reads={reads.data} />
      {positions.length > 0 && <FxActiveTrade positions={positions} selectedId={selected?.id ?? null} onSelect={setSel} plan={plan?.trades ?? []} onClose={(id) => void close(id)} reads={reads.data} onReadsChanged={() => void reads.reload()} />}
      <FxBrief plan={plan} riskMode={data?.riskMode ?? 'normal'} modes={data?.riskModes} equityUsd={a?.equityUsd ?? null} orders={a?.orders ?? []} names={data?.names} labError={data?.labError ?? null} />
      <FxPnl acct="bot" fallback={tiles} />
      <RiskModeCard mode={data?.riskMode ?? 'normal'} modes={data?.riskModes} portfolio={data?.portfolio ?? null} onChange={() => void reload()} />
      <MarketsCard plan={plan} />
      <ChecksCard plan={plan} log={data?.log ?? []} />
      <AdvancedFold>
        <RollingCard r={data?.rolling} chooser={data?.chooser} ledger={data?.ledger} names={data?.names} />
        <SniperCard s={data?.sniper} />
        <ConvictionCard c={data?.conviction} />
        <PortfolioCard p={data?.portfolio} judgeOn={!!data?.judge?.active} />
        <DeskCard d={data?.desk} />
        <RiskCard r={data?.risk} />
        <HowItWorks judgeOn={!!data?.judge?.active} dropped={data?.dropped ?? []} plan={plan} />
      </AdvancedFold>
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

/** v17.8: the first thing on the page — is the bot in a trade, how are its trades doing, what it does next. */
function BotHero({ plan, a, loaded, selectedId, onPick, reads }: { plan: BotPlan | null; a: Acct | null; loaded: boolean; selectedId: string | null; onPick: (id: string) => void; reads?: ReadsData | null }) {
  const pos = a?.positions ?? [];
  const n = pos.length;
  // v17.9: live P&L between the 5-second refreshes (falls back to the polled numbers)
  const fx = useFxLive();
  const now = Date.now();
  const pnlOf = (p: Pos) => livePnl(p, fx, now);
  const open = pos.reduce((s, p) => s + (Number.isFinite(pnlOf(p)) ? pnlOf(p) : 0), 0);
  const name = (p: Pos) => plan?.trades.find((t) => t.id === p.id)?.name ?? p.strategy ?? 'bot';
  if (n > 0)
    return (
      // a green-washed card (inline: the .card rule sets its own background and border)
      <section className="card min-w-0 p-4 sm:p-5" style={{ background: 'color-mix(in srgb, var(--good) 7%, var(--surface))', borderColor: 'color-mix(in srgb, var(--good) 45%, transparent)' }}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <LiveDot />
            <h2 className="text-[26px] font-bold leading-none tracking-tight text-ink">{n === 1 ? 'In a trade' : `In ${n} trades`}</h2>
          </div>
          <div className="shrink-0 text-right">
            <div className={`text-[26px] font-bold leading-none tracking-tight ${tone(open)}`}>
              <LivePrice value={open} text={fxUsd(open, true)} />
            </div>
            {/* v17.9: the badge sits by the total (next to the heading it wraps "In 3 trades" on 360 px phones) */}
            <div className="mt-1 flex items-center justify-end gap-1.5 text-xs text-muted">
              <LiveBadge fx={fx} />
              open P&L
            </div>
          </div>
        </div>
        <p className="mt-1 text-sm text-ink-2">The bot trades by itself{a ? ` · ${usd(a.marginUsedUsd)} margin in use` : ''}. Tap a trade for its chart.</p>
        <ul className={`mt-3 grid grid-cols-1 gap-1.5 ${n > 1 ? 'lg:grid-cols-2 2xl:grid-cols-3' : ''}`}>
          {pos.map((p) => {
            const on = p.id === selectedId && n > 1;
            return (
              <li key={p.id} className="min-w-0">
                <button type="button" onClick={() => onPick(p.id)} aria-pressed={on} className={`flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left transition-colors duration-150 ${on ? 'border-accent bg-surface shadow-sm' : 'border-line bg-surface/70 hover:bg-surface'}`}>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                      <Badge tone={p.side === 1 ? 'up' : 'down'}>{p.side === 1 ? 'Long' : 'Short'}</Badge>
                      <span className="font-semibold text-ink">{p.pair}</span>
                      {p.tf && <Badge tone="neutral">{p.tf}</Badge>}
                      {(() => {
                        const r = reads?.trades.find((x) => x.id === p.id);
                        return r ? <ReadChip read={r.read} ai={r.ai} /> : p.locked ? <Badge tone="up" title="The stop is past the entry and trails the best price">profit locked</Badge> : null;
                      })()}
                    </div>
                    <div className="mt-0.5 truncate text-xs text-muted">
                      {p.closePending && <span className="font-semibold text-warning">closing · </span>}
                      <span className="tabular">{sinceOpen(p.openedAt)}</span> · {name(p)}
                    </div>
                  </div>
                  <span className={`tabular shrink-0 text-[15px] font-semibold ${tone(pnlOf(p))}`}>{fxUsd(pnlOf(p), true)}</span>
                  <Icon name="chevron" size={16} className={`shrink-0 ${on ? 'text-accent-text' : 'text-muted'}`} />
                </button>
              </li>
            );
          })}
        </ul>
        {plan && <p className="mt-3 text-sm text-ink-2">{plan.summary}</p>}
        <NextChecks plan={plan} />
      </section>
    );
  const next = plan?.next.filter((x) => x.at > Date.now()).sort((x, y) => x.at - y.at)[0] ?? null;
  return (
    <Card>
      <div className="flex items-start gap-3">
        <span className="mt-2 h-3 w-3 shrink-0 rounded-full border-2 border-muted/70" aria-hidden="true" />
        <div className="min-w-0">
          <h2 className="text-[22px] font-semibold leading-tight tracking-tight text-ink">{loaded ? 'Not in a trade' : 'Checking the bot…'}</h2>
          <p className="mt-1 text-sm text-ink-2">{plan?.summary ?? (loaded ? 'Getting its first look at the markets…' : '')}</p>
          {next && (
            <p className="mt-1 text-xs text-muted">
              Next check {clock(next.at)} on the {next.tf} chart ({Math.max(1, Math.round((next.at - Date.now()) / 60_000))} min). It trades by itself; you don't need to do anything.
            </p>
          )}
        </div>
      </div>
      <NextChecks plan={plan} />
    </Card>
  );
}

function LiveDot() {
  return (
    <span className="relative flex h-3.5 w-3.5 shrink-0" aria-hidden="true">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-good opacity-60" />
      <span className="relative inline-flex h-3.5 w-3.5 rounded-full bg-good" />
    </span>
  );
}

function NextChecks({ plan }: { plan: BotPlan | null }) {
  if (!plan?.next.length) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {plan.next.map((n) => (
        <Badge key={n.tf} tone={plan.trading[n.tf] ? 'accent' : 'neutral'} title={plan.trading[n.tf] ? `${plan.trading[n.tf]} strategies it trades on this chart` : 'no strategy has passed its test on this chart yet'}>
          {n.tf} next {clock(n.at)} · {plan.trading[n.tf] ? `${plan.trading[n.tf]} setup${plan.trading[n.tf] === 1 ? '' : 's'}` : 'none passed yet'}
        </Badge>
      ))}
    </div>
  );
}

function MarketsCard({ plan }: { plan: BotPlan | null }) {
  const [open, setOpen] = useState<string | null>(null);
  const fx = useFxLive();
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
                  {m.price !== null && <LivePrice value={liveOf(fx, m.id)?.mid ?? m.price} digits={dp(m.id)} className="block w-fit text-xs text-muted" />}
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
                    <div className="mb-1 text-xs font-semibold text-muted">Which way it leans</div>
                    <p className="text-sm text-ink-2">{m.lean.side === 0 ? 'No side. ' : m.lean.side === 1 ? 'Buy. ' : 'Sell. '}{m.lean.why}.</p>
                  </div>
                  <div>
                    <div className="mb-1 text-xs font-semibold text-muted">Signals on the latest closes</div>
                    {!m.signals.length ? (
                      <p className="text-sm text-ink-2">Nothing fired on the newest 15-minute, hourly or 4-hour candle. It checks again at the next close.</p>
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
                      <div className="mb-1 text-xs font-semibold text-muted">What can hold it back</div>
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
        It checks every market on three charts (15-minute, hourly and 4-hour) right after each candle closes, but it <span className="font-semibold text-ink">only trades the hourly and 4-hour charts</span> — the 15-minute chart is lab-tested, nothing more, and the 1-minute chart is switched off. A strategy is only used on a chart where it passed its test on that chart's unseen history (and the four with published evidence on the hourly / 4-hour charts). After a strategy closes a trade on a market it <span className="font-semibold text-ink">waits 3 candles</span> (3 h on the hourly, 12 h on the 4-hour) before it may re-enter that market. When one fires and its checks agree (stronger currency, bigger chart, market mood — whichever that strategy proved it needs), the bot opens the trade with that strategy's stop and exits. Fake money, real prices.
      </p>
      <p className="mt-2 text-sm text-ink-2">
        Exits: each strategy uses the exit that tested best for it. Where it tests as well, that is a <span className="font-semibold text-ink">trailing stop-loss</span>: the stop moves up with the trade from the start (break-even at +1R, +1R locked at +2R…) and never back, so a winner that turns around still closes in profit — and at the target it keeps trailing instead of closing. Next choice: a <span className="font-semibold text-ink">trailing take-profit</span> (the stop locks in profit at the target and trails from there). Others take half off at the target, use a bigger target, or move the stop to break-even.
      </p>
      <p className="mt-2 text-sm text-ink-2">
        Size: about <span className="font-semibold text-ink">1% of the account at risk</span> per trade, more for proven strategies, less for unproven ones, half when a market is far wilder than normal, smaller after the account drops 8%+. When it is more sure of an entry (3+ checks agree) it trades <span className="font-semibold text-ink">bigger at higher leverage</span> — 1.5× at 50×, 2× at 100×, never more than 2% of the account — but only once those trades proved themselves on unseen history (see "Bigger size when it's more sure"). Never more than 2.2% on one currency, 3 trades per strategy, 8 in total. The signal judge {judgeOn ? <span className="font-semibold text-ink">is on</span> : 'is off until it proves itself'} for hourly / 4-hour signals.
      </p>
      <p className="mt-2 text-sm text-ink-2">It waits around big news and speeches, skips bank holidays, price shocks and the daily rollover, opens nothing in the last 2 hours of the week, pauses everything 30 min before the Friday close and re-opens what is still running after Monday's open. A strategy that lost money over 12+ of its trades on a chart is dropped there.</p>
      <p className="mt-2 text-xs text-muted">On the 1-minute chart the spread is a big part of every move: a strategy only trades there if it still wins after paying it.{plan ? ` Setups in use: ${Object.entries(plan.trading).map(([tf, n]) => `${tf} ${n}`).join(' · ') || 'none yet'}.` : ''}</p>
      {!!dropped.length && <p className="mt-2 text-xs text-down">Dropped for losing: {dropped.join(', ')}</p>}
    </Card>
  );
}
