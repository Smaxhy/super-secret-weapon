/**
 * v28 Replay (owner: "look into FX Replay … the bot better and faster"): FX Replay's idea, built on the bot's own data.
 * Pick a market, a chart and a stretch of history; press play and the candles come in one by one while the picked
 * strategies take their trades as the lab tests them (same filter, exit, way in, costs). Each trade appears when it
 * happens, its stop / target ride on the price axis while it is open, and the tally counts it when it closes. The
 * future stays hidden. Trades after the lab's 70/30 line are marked "unseen" — the part the verdicts were graded on.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '../hooks/useApi';
import { useWidth } from '../hooks/useWidth';
import { useStored, Badge, Button, Card, Chip, Empty, ErrorBox, Loading, Select, Stack } from './ui';
import { FastChart, type FastLine, type FastMarker } from './FastChart';
import { Segmented } from './FxActiveTrade';
import { Icon } from './Icon';
import { apiBase } from '../lib/ws';
import { digitsOf } from '../lib/markets';

interface Pick { id: string; name: string; tf: string; verdict: 'edge' | 'maybe' | 'no'; live: boolean; on?: boolean; outN: number; outAvgR: number; filter: string; exit: string; entry: string }
interface RTrade { strategy: string; side: 1 | -1; entryT: number; entry: number; exitT: number; exit: number; stop0: number; target: number | null; r: number; reason: string }
interface ReplayData { pair: string; tf: string; from: number; to: number; oosFrom: number | null; bars: number[][]; trades: RTrade[]; picks: Pick[]; markets: string[]; note?: string; error?: string }

const SPAN_DAYS: Record<string, Array<[string, string]>> = {
  '15m': [['2', '2 days'], ['4', '4 days'], ['10', '10 days']],
  '1h': [['7', '1 week'], ['14', '2 weeks'], ['30', '1 month']],
  '4h': [['30', '1 month'], ['60', '2 months'], ['120', '4 months']],
};
const SPEEDS: Array<[string, string]> = [['2', '2/s'], ['5', '5/s'], ['12', '12/s'], ['30', '30/s']];
const REASON: Record<string, string> = { stop: 'stop', target: 'target', trail: 'trailing stop', time: 'out of time', exit: 'its exit rule', open: 'still open', breakeven: 'break-even', weekend: 'weekend' };
const VERDICT: Record<Pick['verdict'], string> = { edge: 'Edge', maybe: 'Maybe', no: 'no edge' };

const fmtT = (t: number) => new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtR = (r: number) => `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r).toFixed(2)}R`;
const dayStart = (iso: string) => (iso ? new Date(`${iso}T00:00:00`).getTime() : NaN);

/** Where the replay stands at candle `i`: trades taken, open, closed (with R), and the markers + lines to draw. Pure. */
export function replayState(bars: number[][], trades: RTrade[], i: number, oosFrom: number | null) {
  const nowT = bars[Math.min(i, bars.length - 1)]?.[0] ?? 0;
  const barEnd = nowT + (bars.length > 1 ? bars[1]![0]! - bars[0]![0]! : 0);
  const seen = trades.filter((t) => t.entryT < barEnd);
  const closed = seen.filter((t) => t.reason !== 'open' && t.exitT < barEnd);
  const open = seen.filter((t) => !closed.includes(t));
  const wins = closed.filter((t) => t.r > 0).length;
  const totalR = closed.reduce((s, t) => s + t.r, 0);
  const markers: FastMarker[] = [];
  for (const t of seen) markers.push({ t: t.entryT, kind: t.side === 1 ? 'buy' : 'sell', text: t.strategy });
  for (const t of closed) markers.push({ t: t.exitT, kind: 'exit', text: fmtR(t.r), color: t.r > 0 ? '#16a34a' : t.r < 0 ? '#dc2626' : undefined });
  const cur = open[open.length - 1] ?? null;
  const lines: FastLine[] = cur
    ? [
        { price: cur.entry, color: '#6366f1', title: `${cur.strategy} in`, style: 'solid' },
        { price: cur.stop0, color: '#ef4444', title: 'stop', style: 'dashed', width: 2 },
        ...(cur.target !== null ? [{ price: cur.target, color: '#22c55e', title: 'target', style: 'dashed' as const, width: 2 as const }] : []),
      ]
    : [];
  const unseen = oosFrom !== null ? closed.filter((t) => t.entryT >= oosFrom) : [];
  return { nowT, seen, closed, open, wins, totalR, markers, lines, unseenR: unseen.reduce((s, t) => s + t.r, 0), unseenN: unseen.length };
}

export function FxReplay() {
  const [pair, setPair] = useStored<string>('fx.replay.pair', '');
  const [tf, setTf] = useStored<'15m' | '1h' | '4h'>('fx.replay.tf', '1h', ['15m', '1h', '4h']);
  const [days, setDays] = useState('14');
  const [start, setStart] = useState('');
  const [picked, setPicked] = useState<string[] | null>(null);
  const spans = SPAN_DAYS[tf]!;
  const dayN = spans.some(([d]) => d === days) ? Number(days) : Number(spans[1]![0]);
  const from0 = dayStart(start);
  const q = new URLSearchParams({ tf });
  if (pair) q.set('pair', pair);
  if (Number.isFinite(from0)) {
    q.set('from', String(from0));
    q.set('to', String(Math.min(Date.now(), from0 + dayN * 86_400_000)));
  } else q.set('from', String(Math.floor((Date.now() - dayN * 86_400_000) / 3_600_000) * 3_600_000));
  if (picked?.length) q.set('pick', picked.join(','));
  const { data, error, loading } = useApi<ReplayData>(`${apiBase()}/replay?${q.toString()}`);
  const d = data && !data.error ? data : null;
  const bars = d?.bars ?? [];
  const trades = d?.trades ?? [];

  // the player
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState('5');
  const dataKey = `${d?.pair}|${d?.tf}|${bars[0]?.[0]}|${bars.length}|${trades.length}`;
  const lastKey = useRef('');
  useEffect(() => {
    if (lastKey.current === dataKey) return;
    lastKey.current = dataKey;
    setPlaying(false);
    setI(Math.min(Math.max(0, bars.length - 1), 80));
  }, [dataKey, bars.length]);
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      setI((x) => {
        if (x >= bars.length - 1) {
          setPlaying(false);
          return x;
        }
        return x + 1;
      });
    }, 1000 / Number(speed));
    return () => clearInterval(id);
  }, [playing, speed, bars.length]);

  const shown = useMemo(() => bars.slice(0, i + 1), [bars, i]);
  const st = useMemo(() => replayState(bars, trades, i, d?.oosFrom ?? null), [bars, trades, i, d?.oosFrom]);
  const nextTrade = trades.find((t) => t.entryT > st.nowT);
  const jumpNext = () => {
    if (!nextTrade) return;
    const k = bars.findIndex((b) => b[0]! >= nextTrade.entryT);
    if (k >= 0) setI(Math.min(bars.length - 1, k + 1));
  };
  const markets = d?.markets ?? [];
  const pairNow = d?.pair ?? pair;
  const picks = d?.picks ?? [];
  const onIds = picks.filter((p) => p.on).map((p) => p.id);
  const toggle = (id: string) => {
    const base = picked ?? onIds;
    const next = base.includes(id) ? base.filter((x) => x !== id) : [...base, id].slice(-8);
    setPicked(next.length ? next : null);
  };
  const atEnd = bars.length > 0 && i >= bars.length - 1;
  const digits = digitsOf(pairNow || 'EURUSD');
  const [box, width] = useWidth<HTMLDivElement>();
  const phone = width > 0 && width < 560;

  return (
    <Stack>
      <Card padded={false}>
        <div className="flex flex-wrap items-end gap-3 p-4 sm:p-5">
          {markets.length > 0 && <Select label="Market" value={pairNow} onChange={(v) => { setPair(v); setPicked(null); }} options={markets.map((m) => [m, m])} className="min-w-36" />}
          <div>
            <div className="mb-1 text-xs font-semibold text-muted">Candles</div>
            <Segmented label="Candle size" value={tf} onChange={(v) => { setTf(v as '15m' | '1h' | '4h'); setPicked(null); }} options={[['15m', '15m'], ['1h', '1h'], ['4h', '4h']]} />
          </div>
          <div>
            <div className="mb-1 text-xs font-semibold text-muted">How much</div>
            <Segmented label="Length" value={String(dayN)} onChange={setDays} options={spans} />
          </div>
          <label className="text-xs font-semibold text-muted">
            <span className="mb-1 block">Start from</span>
            <input type="date" value={start} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setStart(e.target.value)} className="min-h-9 rounded-lg border border-line-strong bg-surface px-2 text-sm font-normal text-ink" aria-label="Start date (empty = the latest stretch)" />
          </label>
          {start && <Button size="sm" variant="ghost" onClick={() => setStart('')}>Latest</Button>}
        </div>
        {picks.length > 0 && (
          <div className="border-t border-line px-4 py-3 sm:px-5">
            <div className="mb-2 text-xs font-semibold text-muted">Strategies in this replay (up to 8 · ● = the bot trades it now)</div>
            <div className="flex flex-wrap gap-1.5">
              {picks.slice(0, 24).map((p) => (
                <Chip key={p.id} active={(picked ?? onIds).includes(p.id)} onClick={() => toggle(p.id)}>
                  <span title={`${p.name} · ${VERDICT[p.verdict]} · unseen ${p.outN} trades, ${fmtR(p.outAvgR)} each · filter ${p.filter}, exit ${p.exit}, in ${p.entry}`}>
                    {p.live ? '● ' : ''}{p.id}
                  </span>
                </Chip>
              ))}
            </div>
          </div>
        )}
      </Card>

      {error && <ErrorBox message={error} />}
      {data?.error && <ErrorBox message={data.error} />}
      {!data && !error && <Loading kind="tiles" />}
      {d && !bars.length && <Empty icon={<Icon name="play" size={20} />}>{d.note ?? 'No candles for that stretch.'}</Empty>}

      {d && bars.length > 0 && (
        <Card padded={false}>
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-4 sm:px-5">
            <div className="min-w-0">
              <div className="text-lg font-semibold leading-tight text-ink">{d.pair} · {d.tf}</div>
              <div className="tabular text-sm text-ink-2" aria-live="polite">{fmtT(st.nowT)}</div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {st.open.length > 0 && <Badge tone="accent">{st.open.length} open</Badge>}
              {d.oosFrom !== null && st.nowT >= d.oosFrom && <Badge tone="warn" title="past the lab's 70/30 line: the part the strategies' verdicts were graded on (never used to pick them)">unseen part</Badge>}
              {loading && <Badge tone="neutral">loading…</Badge>}
            </div>
          </div>
          <div ref={box} className="px-1.5 pt-2 sm:px-3">
            <FastChart bars={shown} digits={digits} height={phone ? 360 : 440} lines={st.lines} markers={st.markers} visible={phone ? 50 : 110} fitKey={dataKey} label={`Replay of ${d.pair} ${d.tf}`} />
          </div>
          <div className="flex flex-wrap items-center gap-2 px-4 pb-2 pt-3 sm:px-5">
            <Button size="sm" variant="outline" aria-label="One candle back" disabled={i <= 0} onClick={() => { setPlaying(false); setI((x) => Math.max(0, x - 1)); }}>‹</Button>
            <Button size="sm" aria-label={playing ? 'Pause' : 'Play'} onClick={() => { if (atEnd) setI(Math.min(bars.length - 1, 80)); setPlaying((p) => !p); }}>
              <Icon name={playing ? 'pause' : 'play'} size={14} />
              {playing ? 'Pause' : atEnd ? 'Replay again' : 'Play'}
            </Button>
            <Button size="sm" variant="outline" aria-label="One candle forward" disabled={atEnd} onClick={() => { setPlaying(false); setI((x) => Math.min(bars.length - 1, x + 1)); }}>›</Button>
            <Button size="sm" variant="ghost" disabled={!nextTrade} onClick={() => { setPlaying(false); jumpNext(); }}>Next trade</Button>
            <span className="ml-auto"><Segmented label="Speed (candles a second)" value={speed} onChange={setSpeed} options={SPEEDS} /></span>
          </div>
          <div className="px-4 pb-4 sm:px-5">
            <input type="range" min={0} max={Math.max(0, bars.length - 1)} value={i} onChange={(e) => { setPlaying(false); setI(Number(e.target.value)); }} className="w-full accent-[var(--accent)]" aria-label="Replay position" />
            <div className="tabular flex justify-between text-[11px] text-muted"><span>{fmtT(bars[0]![0]!)}</span><span>{i + 1} / {bars.length} candles</span><span>{fmtT(bars[bars.length - 1]![0]!)}</span></div>
          </div>
        </Card>
      )}

      {d && bars.length > 0 && (
        <Card title="So far" subtitle="Counted as each trade closes. 1R = what the trade risked at its stop; costs (spread, fees, financing) are already in.">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Tile label="Trades closed" value={String(st.closed.length)} sub={`${st.open.length} open`} />
            <Tile label="Won" value={st.closed.length ? `${Math.round((st.wins / st.closed.length) * 100)}%` : '—'} sub={`${st.wins} of ${st.closed.length}`} />
            <Tile label="Total" value={st.closed.length ? fmtR(st.totalR) : '—'} sub={st.closed.length ? `${fmtR(st.totalR / st.closed.length)} a trade` : ''} tone={st.totalR} />
            <Tile label="Unseen part" value={st.unseenN ? fmtR(st.unseenR) : '—'} sub={st.unseenN ? `${st.unseenN} trades after the 70/30 line` : 'none yet'} tone={st.unseenR} />
          </div>
          {st.seen.length > 0 && (
            <ol className="mt-3 max-h-72 space-y-1 overflow-y-auto pr-1">
              {[...st.seen].reverse().map((t) => {
                const done = st.closed.includes(t);
                return (
                  <li key={`${t.strategy}:${t.entryT}`} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm odd:bg-surface-2/50">
                    <Badge tone={t.side === 1 ? 'up' : 'down'}>{t.side === 1 ? 'Buy' : 'Sell'}</Badge>
                    <span className="min-w-0 flex-1 truncate text-ink-2" title={t.strategy}>{t.strategy}</span>
                    <span className="tabular hidden text-xs text-muted sm:inline">{fmtT(t.entryT)}</span>
                    {done ? (
                      <span className={`tabular w-24 text-right font-semibold ${t.r > 0 ? 'text-up' : t.r < 0 ? 'text-down' : 'text-ink-2'}`} title={REASON[t.reason] ?? t.reason}>{fmtR(t.r)} <span className="text-[11px] font-normal text-muted">{REASON[t.reason] ?? t.reason}</span></span>
                    ) : (
                      <span className="w-24 text-right text-xs text-muted">running…</span>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
          {!trades.length && <p className="mt-3 text-sm text-muted">No trades from the picked strategies in this stretch. Pick others above or a longer stretch.</p>}
        </Card>
      )}
    </Stack>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: number }) {
  return (
    <div className="rounded-xl bg-surface-2/60 px-3 py-2">
      <div className="text-[11px] font-medium text-muted">{label}</div>
      <div className={`tabular text-lg font-semibold ${tone === undefined || tone === 0 ? 'text-ink' : tone > 0 ? 'text-up' : 'text-down'}`}>{value}</div>
      <div className="tabular truncate text-[11px] text-muted">{sub}</div>
    </div>
  );
}
