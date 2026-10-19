/** Forex practice account: fake money, live prices, leverage, stop-loss / take-profit, margin call.
 * v17.9: pair prices, bid / ask, open P&L and equity move with the bot's live price push (metals keep polling). */
import { useEffect, useMemo, useState } from 'react';
import { useApi } from '../hooks/useApi';
import { FRESH_MS, liveExit, liveOf, livePnl, useFxLive } from '../hooks/useFxLive';
import { api } from '../lib/api';
import { ago } from '../lib/format';
import { LiveBadge, LivePrice } from './LivePrice';
import { TvChart } from './TvChart';
import { MarketChart, type ChartDrawings } from './MarketChart';
import { Badge, Button, Card, Chip, NumberInput, Row, Rows, Stack, StatTile, useStored } from './ui';

interface Quote { id: string; mid: number; bid: number; ask: number; t: number; dayChangePct: number | null; source: 'oanda' | 'yahoo' | 'dukascopy'; tradeable?: boolean }
interface Pos { id: string; pair: string; side: 1 | -1; units: number; entry: number; marginUsd: number; leverage: number; stop: number | null; target: number | null; openedAt: number; px: number; pnlUsd: number; pnlPct: number; /** v17.9 */ pnlPerPx?: number; closePending?: { reason: string; at: number } | null }
interface Closed { id: string; pair: string; side: 1 | -1; entry: number; exit: number; leverage: number; marginUsd: number; pnlUsd: number; reason: string; closedAt: number }
interface Acct { startUsd: number; balanceUsd: number; equityUsd: number; marginUsedUsd: number; freeMarginUsd: number; marginLevelPct: number | null; positions: Pos[]; closed: Closed[] }
interface Data { account: Acct | null; quotes: Record<string, Quote> }

const PAIRS = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF', 'NZDUSD', 'EURJPY', 'GBPJPY', 'EURGBP', 'XAUUSD', 'XAGUSD'];
const LEVS = [1, 10, 30, 50, 100, 200, 500];
const TFS: Array<[string, string]> = [['1', '1m'], ['5', '5m'], ['15', '15m'], ['60', '1h'], ['240', '4h'], ['D', '1D']];
const dp = (id: string) => (id.includes('JPY') ? 3 : id === 'XAUUSD' ? 2 : id === 'XAGUSD' ? 3 : 5);
const pipOf = (id: string) => (id.includes('JPY') ? 0.01 : id === 'XAUUSD' ? 0.01 : id === 'XAGUSD' ? 0.001 : 0.0001);
const usd = (x: number) => `${x < 0 ? '−' : ''}$${Math.abs(x).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const tone = (x: number) => (x > 0 ? 'text-up' : x < 0 ? 'text-down' : 'text-ink-2');

export function FxTrade() {
  const { data, reload } = useApi<Data>('/api/forex/practice', 4_000);
  const [pair, setPair] = useStored<string>('fx.pair', 'EURUSD', PAIRS);
  const [tf, setTf] = useStored<string>('fx.chartTf', '5', TFS.map((t) => t[0]));
  const [amount, setAmount] = useState('100');
  const [lev, setLev] = useStored<string>('fx.lev', '30', LEVS.map(String));
  const [stopPips, setStopPips] = useState('20');
  const [tpPips, setTpPips] = useState('40');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useStored<'tv' | 'bot'>('fx.chartView', 'tv', ['tv', 'bot']);
  const lab = useApi<{ last: { markets?: Array<{ id: string; bars: number[][]; drawings: ChartDrawings }> } | null }>(view === 'bot' ? '/api/forex' : null, 60_000);
  // v17.9: live prices over the 4-second poll
  const fx = useFxLive();
  const now = Date.now();
  const liveQ = (id: string): Quote | undefined => {
    const x = data?.quotes?.[id];
    const t = liveOf(fx, id, FRESH_MS, now);
    return x && t ? { ...x, mid: t.mid, bid: t.bid, ask: t.ask } : x;
  };
  const acct = data?.account ?? null;
  const dEq = acct ? acct.positions.reduce((s, x) => s + (Number.isFinite(x.pnlUsd) ? livePnl(x, fx, now) - x.pnlUsd : 0), 0) : 0;
  const a = acct && dEq ? { ...acct, equityUsd: acct.equityUsd + dEq, freeMarginUsd: acct.freeMarginUsd + dEq, marginLevelPct: acct.marginUsedUsd > 0 ? Math.round(((acct.equityUsd + dEq) / acct.marginUsedUsd) * 1000) / 10 : acct.marginLevelPct } : acct;
  const q = liveQ(pair);
  const qLive = !!liveOf(fx, pair, FRESH_MS, now);
  const p = pipOf(pair);
  const notional = (Number(amount) || 0) * Number(lev);
  // what 1 pip is worth for this size (approx., USD-quoted pairs exact)
  const pipValue = useMemo(() => {
    if (!q) return null;
    const units = pair.startsWith('USD') ? notional : notional / (pair === 'XAUUSD' || pair === 'XAGUSD' ? q.mid : (data?.quotes?.[`${pair.slice(0, 3)}USD`]?.mid ?? q.mid));
    const quote = pair.slice(3);
    const qUsd = quote === 'USD' ? 1 : quote === 'JPY' ? 1 / (data?.quotes?.USDJPY?.mid ?? 150) : quote === 'GBP' ? (data?.quotes?.GBPUSD?.mid ?? 1.25) : 1 / (data?.quotes?.[`USD${quote}`]?.mid ?? 1);
    return units * p * qUsd;
  }, [q, pair, notional, p, data]);

  const place = async (side: 1 | -1) => {
    if (!q) return;
    setBusy(true);
    setMsg(null);
    try {
      const px = side === 1 ? q.ask : q.bid;
      const sp = Number(stopPips);
      const tp = Number(tpPips);
      await api('/api/forex/practice/open', {
        method: 'POST',
        body: JSON.stringify({ pair, side, marginUsd: Number(amount), leverage: Number(lev), stop: sp > 0 ? px - side * sp * p : null, target: tp > 0 ? px + side * tp * p : null }),
      });
      setMsg({ ok: true, text: `${side === 1 ? 'Bought' : 'Sold'} ${pair}` });
      await reload();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const close = async (id: string) => {
    const r = await api<{ ok: boolean; error?: string }>('/api/forex/practice/close', { method: 'POST', body: JSON.stringify({ id }) }).catch((e: Error) => {
      setMsg({ ok: false, text: e.message });
      return null;
    });
    // v17: no live price right now → it closes at the first real one (never a made-up price)
    if (r?.ok && r.error) setMsg({ ok: true, text: r.error });
    await reload();
  };
  const reset = async () => {
    if (!confirm('Reset the practice account to $1,000? All positions and history are cleared.')) return;
    await api('/api/forex/practice/reset', { method: 'POST', body: JSON.stringify({ startUsd: 1000 }) });
    await reload();
  };
  useEffect(() => setMsg(null), [pair]);

  return (
    <Stack>
      {a && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile compact label="Equity" value={usd(a.equityUsd)} sub={`balance ${usd(a.balanceUsd)} · started ${usd(a.startUsd)}`} tone={a.equityUsd > a.startUsd ? 'up' : a.equityUsd < a.startUsd ? 'down' : undefined} />
          <StatTile compact label="Profit" value={usd(a.equityUsd - a.startUsd)} sub={`${(((a.equityUsd / a.startUsd) - 1) * 100).toFixed(1)}%`} tone={a.equityUsd >= a.startUsd ? 'up' : 'down'} />
          <StatTile compact label="Margin used" value={usd(a.marginUsedUsd)} sub={`free ${usd(a.freeMarginUsd)}`} />
          <StatTile compact label="Margin level" value={a.marginLevelPct === null ? '—' : `${a.marginLevelPct}%`} sub="margin call at 50%" tone={a.marginLevelPct !== null && a.marginLevelPct < 100 ? 'down' : undefined} />
        </div>
      )}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <Card padded={false}>
        <div className="flex gap-1.5 overflow-x-auto px-4 pt-4 pb-2 sm:px-5">
          {PAIRS.map((id) => {
            const x = liveQ(id);
            return (
              <button key={id} type="button" onClick={() => setPair(id)} className={`shrink-0 rounded-xl border px-3 py-1.5 text-left text-xs ${pair === id ? 'border-accent bg-accent/10' : 'border-line'}`}>
                <div className="font-semibold text-ink">{id}</div>
                <div className="tabular text-muted">{x ? <LivePrice value={x.mid} digits={dp(id)} /> : '…'} {x?.dayChangePct != null && <span className={tone(x.dayChangePct)}>{x.dayChangePct > 0 ? '+' : ''}{x.dayChangePct}%</span>}</div>
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 px-4 pb-3 sm:px-5">
          <Chip active={view === 'tv'} onClick={() => setView('tv')}>TradingView</Chip>
          <Chip active={view === 'bot'} onClick={() => setView('bot')}>Bot's view</Chip>
          {view === 'tv' && <span className="mx-1 h-4 w-px bg-line" />}
          {view === 'tv' && TFS.map(([k, label]) => (
            <Chip key={k} active={tf === k} onClick={() => setTf(k)}>{label}</Chip>
          ))}
        </div>
        <div className="px-2 pb-2 sm:px-3">
          {view === 'tv' ? (
            <TvChart pair={pair} interval={tf} height={typeof window !== 'undefined' && window.innerWidth >= 768 ? Math.max(560, Math.round(window.innerHeight * 0.68)) : 460} />
          ) : (() => {
            const m = lab.data?.last?.markets?.find((x) => x.id === pair);
            if (!m) return <p className="p-4 text-sm text-muted">The bot's chart fills in after its hourly update.</p>;
            const mine = (a?.positions ?? []).filter((x) => x.pair === pair).map((x) => ({ side: x.side, entryT: x.openedAt, entry: x.entry, stop: x.stop ?? x.entry, target: x.target, strategy: 'you' }));
            return (
              <div className="rounded-xl border border-line bg-surface p-2">
                <MarketChart bars={m.bars} drawings={m.drawings} trades={mine} digits={dp(pair)} />
                <p className="px-2 pb-1 text-xs text-muted">Hourly candles with the bot's trendlines and levels, and your open trades (blue entry, red stop, green target).</p>
              </div>
            );
          })()}
        </div>
      </Card>
      <div className="xl:sticky xl:top-20 xl:self-start">
      <Card title={`Trade ${pair}`} action={<LiveBadge fx={fx} />} subtitle={q ? `Bid ${q.bid.toFixed(dp(pair))} · Ask ${q.ask.toFixed(dp(pair))} · spread ${((q.ask - q.bid) / p).toFixed(1)} pips · ${qLive ? 'live price, several times a second' : q.source === 'oanda' ? 'live OANDA price' : q.source === 'dukascopy' ? 'Dukascopy backup price (Yahoo failed)' : 'Yahoo price (slower, up to ~20 s behind)'}` : 'Loading price…'}>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
          <NumberInput label="Amount (margin)" value={amount} onChange={setAmount} min={1} step={10} unit="$" />
          <div>
            <div className="mb-1 text-xs font-medium text-ink-2">Leverage</div>
            <div className="flex flex-wrap gap-1.5">
              {LEVS.map((l) => (
                <Chip key={l} active={lev === String(l)} onClick={() => setLev(String(l))}>{l}×</Chip>
              ))}
            </div>
          </div>
          <NumberInput label="Stop loss" value={stopPips} onChange={setStopPips} min={0} step={1} unit="pips" />
          <NumberInput label="Take profit" value={tpPips} onChange={setTpPips} min={0} step={1} unit="pips" />
        </div>
        <p className="mt-3 text-xs text-muted">
          Position {usd(notional)}{pipValue ? ` · 1 pip ≈ ${usd(pipValue)}` : ''}
          {pipValue && Number(stopPips) > 0 ? ` · stop risks ≈ ${usd(pipValue * Number(stopPips))} (${((pipValue * Number(stopPips) * 100) / Math.max(1, a?.equityUsd ?? 1000)).toFixed(1)}% of the account)` : ''}
          {pipValue && Number(tpPips) > 0 ? ` · target ≈ +${usd(pipValue * Number(tpPips))}` : ''}
        </p>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <Button size="lg" variant="primary" disabled={busy || !q} className="!bg-up" onClick={() => void place(1)}>Buy {q ? q.ask.toFixed(dp(pair)) : ''}</Button>
          <Button size="lg" variant="danger" disabled={busy || !q} onClick={() => void place(-1)}>Sell {q ? q.bid.toFixed(dp(pair)) : ''}</Button>
        </div>
        {msg && <p className={`mt-2 text-sm ${msg.ok ? 'text-up' : 'text-down'}`}>{msg.text}</p>}
      </Card>
      </div>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
      <Card title="Open positions" action={a?.positions.length ? <Button size="sm" variant="outline" onClick={() => void close('all')}>Close all</Button> : undefined}>
        {!a?.positions.length ? (
          <p className="text-sm text-ink-2">No open positions.</p>
        ) : (
          <ul className="divide-y divide-line">
            {a.positions.map((x) => {
              const pnl = livePnl(x, fx, now);
              const pct = x.marginUsd > 0 && pnl !== x.pnlUsd ? Math.round((pnl / x.marginUsd) * 1000) / 10 : x.pnlPct;
              return (
              <li key={x.id} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Badge tone={x.side === 1 ? 'up' : 'down'}>{x.side === 1 ? 'Buy' : 'Sell'}</Badge>
                    <span className="font-medium text-ink">{x.pair}</span>
                    <span className="text-xs text-muted">{x.leverage}× · {usd(x.marginUsd)}</span>
                    {x.closePending && <Badge tone="warn">closing at the next price</Badge>}
                  </div>
                  <div className="mt-0.5 text-xs text-muted">
                    {x.entry.toFixed(dp(x.pair))} → <LivePrice value={liveExit(x, fx, now) ?? x.px} digits={dp(x.pair)} />
                    {x.stop !== null && ` · SL ${x.stop.toFixed(dp(x.pair))}`}
                    {x.target !== null && ` · TP ${x.target.toFixed(dp(x.pair))}`} · {ago(new Date(x.openedAt).toISOString())}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className={`tabular font-semibold ${tone(pnl)}`}>{usd(pnl)}</div>
                  <div className={`text-xs ${tone(pct)}`}>{pct > 0 ? '+' : ''}{pct}%</div>
                </div>
                <Button size="sm" variant="outline" onClick={() => void close(x.id)}>Close</Button>
              </li>
              );
            })}
          </ul>
        )}
      </Card>
      <Card title="History" action={<Button size="sm" variant="ghost" onClick={() => void reset()}>Reset to $1,000</Button>}>
        {!a?.closed.length ? (
          <p className="text-sm text-ink-2">No closed trades yet.</p>
        ) : (
          <Rows>
            {a.closed.slice(0, 50).map((x) => (
              <Row key={x.id} label={`${x.side === 1 ? 'Buy' : 'Sell'} ${x.pair} ${x.leverage}×`} sub={`${x.entry.toFixed(dp(x.pair))} → ${x.exit.toFixed(dp(x.pair))} · ${x.reason} · ${ago(new Date(x.closedAt).toISOString())}`} value={<span className={tone(x.pnlUsd)}>{usd(x.pnlUsd)}</span>} />
            ))}
          </Rows>
        )}
      </Card>
      </div>
    </Stack>
  );
}
