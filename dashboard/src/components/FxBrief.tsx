/**
 * v18.1 "Today" brief for the Auto-bot page (owner: "I need to know what the bot's thinking, what trades it's leading
 * into; it's all hard to index"). One card, plain words: the daily goal and where today stands, what a winning trade
 * pays in each risk mode, which way the bot leans right now, the trades it is closest to taking, the open trades in one
 * line each, and when it looks again. Display only.
 */
import { CheckPips, WhyLine, type PlanCheck, type PlanMode, type WhyReport } from './ControlRoom';
import { useEffect, useState } from 'react';
import { useApi } from '../hooks/useApi';
import { Badge, Card } from './ui';
import { botAcct } from '../lib/ws';

interface PlanSignal { tf: string; name: string; side: 1 | -1; verdict: string; tone: 'go' | 'wait' | 'no' }
interface PlanMarket { id: string; label: string; status: 'trading' | 'waiting' | 'blocked' | 'watching'; headline: string; lean: { side: 1 | -1 | 0; why: string }; checks?: PlanCheck[]; plan?: string; signals: PlanSignal[]; blocks: string[] }
interface PlanLine { k: string; text: string; done?: boolean }
interface PlanTrade { id: string; pair: string; side: 1 | -1; name: string; tf: string; pnlUsd: number; lines: PlanLine[] }
interface Plan { at: number; summary: string; mode?: PlanMode; nextLook?: { tf: string; at: number; does: string }; next: Array<{ tf: string; at: number }>; markets: PlanMarket[]; trades: PlanTrade[] }
type RiskMode = 'normal' | 'aggressive' | 'max' | 'turbo';
interface RiskLimits { label: string; riskPct: number; leverage: number; maxOpen: number }
interface Order { id: string; pair: string; side: 1 | -1; limit: number; kind: 'limit' | 'pullback'; expiresAt: number; strategy: string; tf?: string; riskPct: number }
interface PnlData { equityUsd: number; startUsd: number; periods: { today: { pnlUsd: number; trades: number; wins: number }; week: { pnlUsd: number; trades: number; wins: number } } }

const usd = (x: number) => `${x < 0 ? '−' : x > 0 ? '+' : ''}$${Math.abs(x).toFixed(2)}`;
const tone = (x: number) => (x > 0 ? 'text-up' : x < 0 ? 'text-down' : 'text-ink-2');
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const GOAL_KEY = 'fx.goal';
const readGoal = () => {
  try {
    const v = Number(localStorage.getItem(GOAL_KEY));
    return Number.isFinite(v) && v > 0 ? v : 50;
  } catch {
    return 50;
  }
};

/** v18.12: the next hourly / 4-hour check on the UTC grid (candle close + 90 s), when the server's plan is missing. */
export function localNextLook(now = Date.now()): { tf: string; at: number } {
  const H = 3_600_000;
  const grid = (period: number) => Math.floor((now - 90_000) / period) * period + period + 90_000;
  const h1 = grid(H);
  const h4 = grid(4 * H);
  return h4 <= h1 ? { tf: '4h', at: h4 } : { tf: '1h', at: h1 };
}

export function FxBrief({ plan, riskMode, modes, equityUsd, orders = [], names = {}, labError = null, planError = null, loadError = null, why = null }: { why?: WhyReport | null; plan: Plan | null; riskMode: RiskMode; modes?: Record<RiskMode, RiskLimits>; equityUsd: number | null; orders?: Order[]; names?: Record<string, string>; labError?: { t: number; msg: string } | null; planError?: string | null; loadError?: string | null }) {
  const tz = new Date().getTimezoneOffset();
  const { data: pnl } = useApi<PnlData>(`/api/forex/pnl?acct=${botAcct()}&tz=${tz}`, 60_000);
  const [goal, setGoal] = useState(readGoal);
  const [edit, setEdit] = useState(false);
  useEffect(() => {
    try {
      localStorage.setItem(GOAL_KEY, String(goal));
    } catch {
      /* private mode */
    }
  }, [goal]);
  // an older server (or an error page) answers without periods: the card still renders
  const today = pnl?.periods?.today;
  const eq = equityUsd ?? pnl?.equityUsd ?? 1000;
  const done = today?.pnlUsd ?? 0;
  const pct = Math.max(0, Math.min(100, (done / goal) * 100));
  // what one average winner pays: the risk per trade × the account; winners run about 1–1.5 R, so this is the low end
  const winUsd = (m: RiskMode) => (modes ? Math.round((modes[m].riskPct / 100) * eq) : null);
  const need = winUsd(riskMode);
  const leanLong = plan?.markets.filter((m) => m.lean.side === 1) ?? [];
  const leanShort = plan?.markets.filter((m) => m.lean.side === -1) ?? [];
  // closest to a trade: markets with a signal that is waiting on something, then the ones it is watching with a lean
  const close = (plan?.markets ?? [])
    .flatMap((m) => m.signals.filter((s) => s.tone === 'wait').map((s) => ({ m, s })))
    .slice(0, 5);
  const next = plan?.next.slice().sort((a, b) => a.at - b.at)[0] ?? localNextLook();
  return (
    <Card title="Today" subtitle={plan?.summary ?? 'Its plan appears after the first look at the markets.'} className="hero-glow card-accent">
      <div className="space-y-4">
        {/* v20.2: the state in one word, first */}
        {plan?.mode && (
          <div className={`rounded-lg px-3 py-2 ${plan.mode.kind === 'trading' ? 'bg-good/10' : plan.mode.kind === 'nothing_proven' ? 'bg-critical/10' : plan.mode.kind === 'closed' ? 'bg-surface-2' : 'bg-warning/10'}`} role="status">
            <div className={`text-lg font-bold ${plan.mode.kind === 'trading' ? 'text-up' : plan.mode.kind === 'nothing_proven' ? 'text-down' : plan.mode.kind === 'closed' ? 'text-muted' : 'text-warning'}`}>{plan.mode.word}</div>
            <p className="text-sm text-ink-2">{plan.mode.line}</p>
          </div>
        )}
        {why && <WhyLine why={why} />}
        {labError && (
          <div role="alert" className="rounded-lg border border-critical/40 bg-critical/10 px-3 py-2 text-sm text-ink">
            <b>The hourly test failed</b> at {clock(labError.t)}: {labError.msg}. Open trades are still guarded by their stops; no new hourly-chart trades until a run succeeds. Forex → Setup → Data feeds has the details.
          </div>
        )}
        {/* the goal */}
        <div>
          <div className="flex items-baseline justify-between gap-2">
            <div className="text-sm text-ink-2">
              Goal <button type="button" className="font-semibold text-ink underline decoration-dotted" onClick={() => setEdit((v) => !v)} title="tap to change">${goal} a day</button>
            </div>
            <div className={`text-lg font-bold ${tone(done)}`}>{usd(done)} <span className="text-xs font-normal text-muted">today{today ? ` · ${today.trades} trades, ${today.wins} won` : ''}</span></div>
          </div>
          {edit && (
            <div className="mt-2 flex items-center gap-2 text-sm">
              {[20, 50, 100].map((g) => (
                <button key={g} type="button" className={`rounded-full border px-3 py-1 ${g === goal ? 'border-accent text-accent' : 'border-line text-ink-2'}`} onClick={() => { setGoal(g); setEdit(false); }}>${g}</button>
              ))}
              <input type="number" min={1} className="w-20 rounded-md border border-line bg-surface-2 px-2 py-1" defaultValue={goal} onBlur={(e) => { const v = Number(e.target.value); if (v > 0) setGoal(v); setEdit(false); }} />
            </div>
          )}
          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-surface-2">
            <div className={`h-full rounded-full ${done >= goal ? 'bg-good' : done < 0 ? 'bg-critical' : 'bg-accent'}`} style={{ width: `${done < 0 ? 100 : pct}%`, opacity: done < 0 ? 0.35 : 1 }} />
          </div>
          <p className="mt-2 text-xs text-muted">
            {modes ? (
              <>
                In <b className="text-ink">{modes[riskMode].label}</b> mode a winning trade pays about <b className="text-ink">${need}</b> (it risks {modes[riskMode].riskPct}% of ${Math.round(eq)} a trade), so ${goal} needs about {need ? Math.max(1, Math.ceil(goal / need)) : '?'} more wins than losses today.
                {' '}The other modes: {(['normal', 'aggressive', 'max', 'turbo'] as RiskMode[]).filter((m) => m !== riskMode && modes[m]).map((m) => `${modes[m].label} ≈ $${winUsd(m)} a win`).join(', ')} — losing trades scale the same way. Change it in "How hard it trades" below.
              </>
            ) : 'A winning trade pays about the risk it took; losses scale the same way.'}
          </p>
          {pnl?.periods?.week && <p className="mt-1 text-xs text-muted">This week {usd(pnl.periods.week.pnlUsd)} over {pnl.periods.week.trades} trades · account ${Math.round(pnl.equityUsd)} from ${Math.round(pnl.startUsd)}.</p>}
        </div>

        {/* what it thinks */}
        <div>
          <div className="mb-1 text-xs font-semibold text-muted">Which way it leans right now</div>
          {leanLong.length + leanShort.length === 0 ? (
            <p className="text-sm text-ink-2">No clear lean on any market — its checks disagree, so it only takes a trade when a strategy fires with the checks on its side.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {leanLong.map((m) => <Badge key={m.id} tone="up" title={m.lean.why}>▲ {m.label}</Badge>)}
              {leanShort.map((m) => <Badge key={m.id} tone="down" title={m.lean.why}>▼ {m.label}</Badge>)}
            </div>
          )}
          <p className="mt-1 text-xs text-muted">A lean = two or more of its checks (currency strength, the bigger charts, the market mood) point the same way. Tap a badge to see why.</p>
        </div>

        {/* closest to a trade */}
        <div>
          <div className="mb-1 text-xs font-semibold text-muted">Closest to a trade</div>
          {close.length === 0 ? (
            <p className="text-sm text-ink-2">Nothing is waiting on a check right now. {next ? `It looks again at ${clock(next.at)} (${next.tf} chart).` : ''}</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {close.map(({ m, s }, i) => (
                <li key={`${m.id}-${s.name}-${i}`} className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium text-ink">{s.side === 1 ? 'Buy' : 'Sell'} {m.label}</span>
                  <span className="text-ink-2">{s.name} ({s.tf})</span>
                  <span className="text-xs text-muted">— {s.verdict}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* v18.4 resting orders: the tested way in for this strategy is a limit — it waits for the price to come back */}
        {orders.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-semibold text-muted">Orders waiting to fill</div>
            <ul className="space-y-1 text-sm">
              {orders.map((o) => (
                <li key={o.id} className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium text-ink">{o.side === 1 ? 'Buy' : 'Sell'} {o.pair} at {o.limit.toFixed(o.pair.includes('JPY') ? 3 : o.pair === 'XAUUSD' ? 2 : 5)}</span>
                  <span className="text-ink-2">{names[o.strategy] ?? o.strategy}{o.tf ? ` (${o.tf})` : ''}</span>
                  <span className="text-xs text-muted">— {o.kind === 'pullback' ? 'waiting for a pullback' : 'limit at the signal price'}, until {clock(o.expiresAt)} · {o.riskPct}% risk</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* open trades in one line each */}
        {plan && plan.trades.length > 0 && (
          <div>
            <div className="mb-1 text-xs font-semibold text-muted">In trades</div>
            <ul className="space-y-1 text-sm">
              {plan.trades.map((t) => {
                const nextLine = t.lines.find((l) => !l.done && (l.k === 'target' || l.k === 'stop' || l.k === 'lock' || l.k === 'trail'));
                return (
                  <li key={t.id} className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium text-ink">{t.side === 1 ? 'Long' : 'Short'} {t.pair}</span>
                    <span className="text-ink-2">{t.name} ({t.tf})</span>
                    <span className={`font-semibold ${tone(t.pnlUsd)}`}>{usd(t.pnlUsd)}</span>
                    {nextLine && <span className="text-xs text-muted">— {nextLine.text}</span>}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {loadError && <p className="text-sm text-down">Couldn't load the bot's page: {loadError}</p>}
        {!loadError && !plan && <p className="text-sm text-down">{planError ? `No plan right now: ${planError}.` : 'No plan yet: the bot has not finished its first hourly look since it started.'}</p>}
        <p className="text-xs text-muted"><span className="font-semibold text-ink-2">Next look: {clock(next.at)} ({next.tf} candles).</span> {plan?.nextLook?.does ?? 'It checks every chart on every candle close.'}</p>
        {/* v20.2: what it is waiting for, market by market (the leaning ones first) */}
        {plan && plan.markets.some((m) => m.plan) && (
          <div>
            <div className="mb-1 text-xs font-semibold text-muted">What it is waiting for, market by market</div>
            <ul className="divide-y divide-line rounded-lg border border-line">
              {plan.markets
                .slice()
                .sort((a, b) => (b.status === 'trading' ? 2 : b.status === 'waiting' ? 1 : 0) - (a.status === 'trading' ? 2 : a.status === 'waiting' ? 1 : 0) || (b.lean.side ? 1 : 0) - (a.lean.side ? 1 : 0))
                .slice(0, 6)
                .map((m) => (
                  <li key={m.id} className="px-2 py-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-ink">{m.label}</span>
                      {m.lean.side !== 0 && <span className={`text-xs font-semibold ${m.lean.side === 1 ? 'text-up' : 'text-down'}`}>{m.lean.side === 1 ? '▲ leans buy' : '▼ leans sell'}</span>}
                      {m.checks && <CheckPips checks={m.checks} />}
                    </div>
                    <p className="text-xs text-ink-2">{m.plan}</p>
                  </li>
                ))}
            </ul>
            <p className="mt-1 text-xs text-muted">All {plan.markets.length} markets are on the Control room.</p>
          </div>
        )}
      </div>
    </Card>
  );
}

/** v18.1: the research cards, folded away with one line on what each is for. */
export function AdvancedFold({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem('fx.adv') === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('fx.adv', open ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [open]);
  return (
    <div>
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center justify-between rounded-xl border border-line bg-surface-2 px-4 py-3 text-left">
        <div>
          <div className="font-semibold text-ink">Under the hood: the tests that decide what it trades</div>
          <div className="text-xs text-muted">What it learned this week · Sniper · Bigger size when sure · Honest test · The desk · Risk right now · How it trades. These are the bot's exams — you don't need them to follow the trading.</div>
        </div>
        <span className="ml-3 shrink-0 text-ink-2">{open ? '▲' : '▼'}</span>
      </button>
      {open && <div className="mt-3 space-y-3">{children}</div>}
    </div>
  );
}
