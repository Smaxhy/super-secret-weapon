/**
 * v17.14 (owner: "an active diagnosis of what the goal of the trade is, or an AI that scans all active trades and
 * actively analyses the price action"): per open trade
 * - the LIVE READ (rules, free, every 15 s): the goal in words, a stop ← entry → target track with the price, the best
 *   price and the profit lock on it, the moves over 5 / 15 / 60 minutes, and what it notices (pace, trend, levels, news);
 * - the AI READ (Claude, every 15 min while forex is open, sooner when the trade gets close to its stop / target; "Ask
 *   now" any time): a verdict, a headline, 2–3 sentences, what to watch, and how its read changed.
 * Both are display only — the bot's tested exits run by themselves.
 */
import { useState } from 'react';
import { useApi } from '../hooks/useApi';
import { api } from '../lib/api';
import { Badge, Button } from './ui';

export type ReadStatus = 'closing' | 'near_target' | 'near_stop' | 'pressure' | 'locked' | 'early' | 'stalling' | 'on_track' | 'holding';
export interface TradeReadT {
  id: string;
  status: ReadStatus;
  label: string;
  goal: string;
  why: string | null;
  pips: { now: number; target: number | null; stop: number | null; lockAt: number | null; best: number | null; worst: number | null };
  progressPct: number | null;
  move: { m5: number | null; m15: number | null; m60: number | null };
  sinceBestMin: number | null;
  etaMin: number | null;
  thesisOk: boolean | null;
  lines: string[];
  ageMin: number;
}
export type AiVerdict = 'on_track' | 'watch' | 'at_risk';
export interface AiReadT {
  verdict: AiVerdict;
  headline: string;
  read: string;
  watch: string[];
  confidence: number;
  model: string;
  at: number;
  px: number;
  why: 'new' | 'time' | 'change' | 'asked';
  history: Array<{ at: number; verdict: AiVerdict; headline: string }>;
}
export interface AiInfo { on: boolean; reason: string | null; model: string; spentTodayUsd: number; budgetUsd: number; everyMin: number; lastError: string | null }
export interface ReadRow { id: string; pair: string; read: TradeReadT; ai: AiReadT | null }
export interface ReadsData { trades: ReadRow[]; ai: AiInfo | null }

type Tone = 'neutral' | 'accent' | 'up' | 'down' | 'warn';
export const READ_TONE: Record<ReadStatus, Tone> = { closing: 'warn', near_target: 'up', near_stop: 'down', pressure: 'down', locked: 'up', early: 'neutral', stalling: 'warn', on_track: 'up', holding: 'warn' };
const AI_LABEL: Record<AiVerdict, { text: string; tone: Tone }> = { on_track: { text: 'On track', tone: 'up' }, watch: { text: 'Watch', tone: 'warn' }, at_risk: { text: 'At risk', tone: 'down' } };

/** every open trade's live read + AI read (every 15 s; nothing while there is no trade) */
export function useTradeReads(acct: 'bot' | 'me', on: boolean) {
  return useApi<ReadsData>(on ? `/api/forex/trades/read?acct=${acct}` : null, 15_000);
}

const pipTxt = (x: number) => (Math.abs(x) < 10 ? Math.abs(x).toFixed(1).replace(/\.0$/, '') : String(Math.round(Math.abs(x))));
const signed = (x: number) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${pipTxt(x)}`;
const pipTone = (x: number | null) => (x === null ? 'text-muted' : x > 0 ? 'text-up' : x < 0 ? 'text-down' : 'text-ink-2');
const agoMin = (t: number) => {
  const m = Math.max(0, Math.round((Date.now() - t) / 60_000));
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`;
};
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function ReadChip({ read, ai, onClick }: { read: TradeReadT; ai?: AiReadT | null; onClick?: () => void }) {
  const chip = (
    <Badge tone={READ_TONE[read.status]} title={read.lines[0]}>
      {read.label}
      {ai && <span className="font-normal opacity-80"> · AI: {AI_LABEL[ai.verdict].text.toLowerCase()}</span>}
    </Badge>
  );
  return onClick ? (
    <button type="button" onClick={onClick} className="rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
      {chip}
    </button>
  ) : (
    chip
  );
}

/** stop ← entry → target on one line, with the price now, the best price and where the profit lock arms */
export function ReadTrack({ r }: { r: TradeReadT }) {
  const p = r.pips;
  const ends = [p.now, 0, p.stop ?? p.worst ?? p.now, p.target ?? p.best ?? p.now, p.best ?? 0, p.worst ?? 0].filter((x): x is number => x !== null && Number.isFinite(x));
  let lo = Math.min(...ends);
  let hi = Math.max(...ends);
  if (hi - lo < 1) {
    lo -= 1;
    hi += 1;
  }
  const pad = (hi - lo) * 0.04;
  lo -= pad;
  hi += pad;
  const x = (v: number) => `${((v - lo) / (hi - lo)) * 100}%`;
  const fillFrom = Math.min(0, p.now);
  const fillTo = Math.max(0, p.now);
  return (
    <div className="select-none" aria-label={`Price ${signed(p.now)} pips from the entry${p.stop !== null ? `, stop ${signed(p.stop)}` : ''}${p.target !== null ? `, target ${signed(p.target)}` : ''}`}>
      <div className="relative h-7">
        <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-surface-2" />
        <div className={`absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full ${p.now >= 0 ? 'bg-good/70' : 'bg-critical/70'}`} style={{ left: x(fillFrom), width: `calc(${x(fillTo)} - ${x(fillFrom)})` }} />
        {p.stop !== null && <Tick at={x(p.stop)} cls="bg-[#ef4444]" title={`stop ${signed(p.stop)} pips`} />}
        {p.target !== null && <Tick at={x(p.target)} cls="bg-[#22c55e]" title={`target ${signed(p.target)} pips`} />}
        <Tick at={x(0)} cls="bg-[#6366f1]" title="entry" />
        {p.lockAt !== null && <Tick at={x(p.lockAt)} cls="bg-[#f59e0b]" dashed title={`profit lock arms at ${signed(p.lockAt)} pips`} />}
        {p.best !== null && p.best > p.now + 0.4 && <span className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-good bg-surface" style={{ left: x(p.best) }} title={`best ${signed(p.best)} pips`} />}
        <span className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface bg-[#6366f1] shadow" style={{ left: x(p.now) }} title={`now ${signed(p.now)} pips`} />
      </div>
      <div className="mt-0.5 flex justify-between text-[11px] text-muted">
        <span className="tabular">{p.stop !== null ? `stop ${signed(p.stop)}` : 'no stop'}</span>
        <span className={`tabular font-semibold ${pipTone(p.now)}`}>now {signed(p.now)} pips</span>
        <span className="tabular">{p.target !== null ? `target ${signed(p.target)}` : 'trailing'}</span>
      </div>
    </div>
  );
}

function Tick({ at, cls, title, dashed = false }: { at: string; cls: string; title: string; dashed?: boolean }) {
  return <span title={title} className={`absolute top-0.5 bottom-0.5 w-0.5 -translate-x-1/2 rounded ${cls} ${dashed ? 'opacity-70' : ''}`} style={{ left: at }} />;
}

function Move({ label, v }: { label: string; v: number | null }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-2 py-1.5 text-center">
      <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted">{label}</div>
      <div className={`tabular text-sm font-semibold ${pipTone(v)}`}>{v === null ? '—' : `${signed(v)}`}</div>
    </div>
  );
}

/** the live read + the AI read of one trade */
export function TradeReadPanel({ row, info, acct, onAsked }: { row: ReadRow; info: AiInfo | null; acct: 'bot' | 'me'; onAsked: () => void }) {
  const r = row.read;
  return (
    <div className="space-y-3">
      <section className="rounded-xl border border-line bg-surface-2/40 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-muted">Live read</span>
          <Badge tone={READ_TONE[r.status]}>{r.label}</Badge>
          {r.thesisOk === false && <Badge tone="warn" title="The market no longer looks like the reason the trade was taken">reason weaker</Badge>}
          <span className="ml-auto text-[11px] text-muted">updates every 15 s</span>
        </div>
        <p className="mt-2 text-sm text-ink"><span className="font-semibold">Goal: </span>{r.goal}</p>
        <div className="mt-3"><ReadTrack r={r} /></div>
        <div className="mt-3 grid grid-cols-3 gap-2">
          <Move label="5 min" v={r.move.m5} />
          <Move label="15 min" v={r.move.m15} />
          <Move label="1 hour" v={r.move.m60} />
        </div>
        <p className="mt-1 text-center text-[11px] text-muted">pips the price moved, + = the trade's way</p>
        <ul className="mt-2.5 space-y-1">
          {/* the move line is already the three tiles above */}
          {r.lines.filter((l) => !/^(Moving its way|Moving against it|Going sideways):/.test(l)).map((l, k) => (
            <li key={k} className="flex gap-2 text-sm text-ink-2">
              <span aria-hidden="true" className="mt-0.5 shrink-0 text-muted">•</span>
              <span>{l}</span>
            </li>
          ))}
        </ul>
        {r.why && <p className="mt-2 text-xs text-muted">Why it took the trade: {r.why}</p>}
      </section>
      <AiBox row={row} info={info} acct={acct} onAsked={onAsked} />
    </div>
  );
}

function AiBox({ row, info, acct, onAsked }: { row: ReadRow; info: AiInfo | null; acct: 'bot' | 'me'; onAsked: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [past, setPast] = useState(false);
  const a = row.ai;
  const ask = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await api<{ ok: boolean; error?: string }>('/api/forex/trades/ai', { method: 'POST', body: JSON.stringify({ id: row.id, acct }) });
      if (!res.ok) setMsg(res.error ?? 'The AI read failed.');
      onAsked();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const off = info && !info.on;
  return (
    <section className="rounded-xl border border-line p-3" style={{ background: 'color-mix(in srgb, var(--accent) 5%, var(--surface))' }}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-muted">AI read</span>
        {a && <Badge tone={AI_LABEL[a.verdict].tone}>{AI_LABEL[a.verdict].text}</Badge>}
        {a && (
          <span className="text-[11px] text-muted" title={`confidence ${a.confidence} of 5 · ${a.model}`}>
            {agoMin(a.at)} · <span aria-label={`confidence ${a.confidence} of 5`}>{'●'.repeat(a.confidence)}<span className="opacity-30">{'●'.repeat(5 - a.confidence)}</span></span>
          </span>
        )}
        {!off && (
          <Button size="sm" variant="outline" className="ml-auto" disabled={busy} onClick={() => void ask()}>
            {busy ? 'Reading the chart…' : a ? 'Ask again' : 'Ask AI now'}
          </Button>
        )}
      </div>
      {a ? (
        <>
          <p className="mt-2 text-[15px] font-semibold leading-snug text-ink">{a.headline}</p>
          {a.read && <p className="mt-1 text-sm text-ink-2">{a.read}</p>}
          {!!a.watch.length && (
            <div className="mt-2">
              <div className="text-xs font-semibold text-ink-2">Watch</div>
              <ul className="mt-0.5 space-y-0.5">
                {a.watch.map((w, k) => (
                  <li key={k} className="flex gap-2 text-sm text-ink-2">
                    <span aria-hidden="true" className="mt-0.5 shrink-0 text-accent-text">›</span>
                    <span>{w}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!!a.history.length && (
            <div className="mt-2">
              <button type="button" className="text-xs font-medium text-accent-text" onClick={() => setPast(!past)} aria-expanded={past}>
                {past ? 'Hide' : 'Show'} how its read changed ({a.history.length})
              </button>
              {past && (
                <ul className="mt-1 space-y-0.5">
                  {a.history.map((h, k) => (
                    <li key={k} className="flex gap-2 text-xs text-muted">
                      <span className="tabular shrink-0">{clock(h.at)}</span>
                      <Badge tone={AI_LABEL[h.verdict].tone}>{AI_LABEL[h.verdict].text}</Badge>
                      <span className="min-w-0">{h.headline}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      ) : (
        <p className="mt-2 text-sm text-ink-2">
          {off
            ? `AI reads are off: ${info?.reason ?? 'not set up'}.${/ANTHROPIC/.test(info?.reason ?? '') ? ' Put ANTHROPIC_API_KEY in the server\'s .env to switch them on — the live read above works without it.' : ''}`
            : `No AI read yet — it reads every open trade every ${info?.everyMin ?? 15} min while forex is open, sooner when the trade nears its stop or target.`}
        </p>
      )}
      {msg && <p className="mt-2 text-sm text-down">{msg}</p>}
      <p className="mt-2 text-[11px] text-muted">
        AI opinion, not a tested rule — the bot doesn't act on it.{info?.on ? ` ${info.model.replace(/^claude-/, '')} · $${info.spentTodayUsd.toFixed(3)} of $${info.budgetUsd.toFixed(2)} today.` : ''}
      </p>
    </section>
  );
}
