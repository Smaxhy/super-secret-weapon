/**
 * Positions — what it holds right now.
 *  - Four summary tiles (open, SOL in trades, unrealised, banked).
 *  - Tabs: Invested now / Bigger coins (swing list + watchlist) / Waiting for a dip.
 *  - Invested now: a sortable table on desktop (coin, size, MC in → now, multiple, P&L, age, stop → target bar,
 *    actions); compact cards on phones. A row opens the details drawer (chart, exit plan, why it bought, Sell).
 *  - `?q=` (from the top-bar search) filters by symbol, name or mint.
 */
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { DipWatch, type DipRow } from '../components/DipWatch';
import { isFresh, LiveDot, mcIn, mcNow, PnlChip, PositionCard, PositionDetails, posPct, RangeBar, sellPosition } from '../components/PositionRow';
import { McChange } from '../components/McCompare';
import { SwingCoins, type SwingData } from '../components/SwingCoins';
import { Badge, Button, Chip, Drawer, Empty, ErrorBox, Loading, PageHeader, Pnl, StatTile, Table, Tabs, Th, tdCls, theadCls, trCls, useStored } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { useLivePositions, type LivePosition } from '../hooks/useLivePositions';
import { ago, multiple, sol, STRATEGY_LABEL } from '../lib/format';
import type { Overview } from '../lib/types';

type Tab = 'invested' | 'bigger' | 'dips';
type SortKey = 'symbol' | 'size' | 'multiple' | 'pnl' | 'age';
type Group = 'all' | 'small' | 'big';

const isBig = (p: LivePosition) => p.strategy === 'SWING';
const rangeText = (p: LivePosition) => {
  const next = p.targets.takeProfits.find((t) => !t.hit);
  const stop = p.entryPriceSol > 0 ? p.targets.stopLossPrice / p.entryPriceSol : null;
  return `stop ${stop ? multiple(stop) : '—'} · ${next ? `next ${next.multiple}×` : 'trailing'}`;
};
const left = (p: LivePosition) => (p.sizeSol * p.remainingPct) / 100;

export function Positions() {
  const { positions, error, loading, reload } = useLivePositions();
  const swing = useApi<SwingData>('/api/swing', 20_000);
  const dips = useApi<DipRow[]>('/api/dip-watch', 5_000);
  const ov = useApi<Overview>('/api/overview', 30_000, ['trade']);
  const [tab, setTab] = useStored<Tab>('solbot.positionsTab', 'invested', ['invested', 'bigger', 'dips']);
  const [group, setGroup] = useStored<Group>('solbot.positionsGroup', 'all', ['all', 'small', 'big']);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'age', dir: 1 });
  const [openId, setOpenId] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();
  const q = (params.get('q') ?? '').trim().toLowerCase();

  const list = positions ?? [];
  const inSol = list.reduce((s, p) => s + left(p), 0);
  const unreal = list.reduce((s, p) => s + (p.unrealizedPnlSol ?? 0), 0);
  const banked = list.reduce((s, p) => s + p.realizedPnlSol, 0);
  const swingLive = (swing.data?.coins ?? []).filter((c) => c.live).length;
  const bigOpen = list.filter(isBig).length;

  const shown = useMemo(() => {
    const val = (p: LivePosition): number | string =>
      sort.key === 'symbol' ? p.symbol.toLowerCase() : sort.key === 'size' ? left(p) : sort.key === 'multiple' ? (p.multiple ?? 0) : sort.key === 'pnl' ? (p.unrealizedPnlSol ?? 0) : -new Date(p.openedAt).getTime();
    return list
      .filter((p) => (group === 'all' ? true : group === 'big' ? isBig(p) : !isBig(p)))
      .filter((p) => !q || p.symbol.toLowerCase().includes(q) || p.name.toLowerCase().includes(q) || p.mint.toLowerCase() === q)
      .slice()
      .sort((a, b) => {
        const av = val(a);
        const bv = val(b);
        return (av < bv ? -1 : av > bv ? 1 : 0) * sort.dir;
      });
  }, [list, group, q, sort]);
  const opened = list.find((p) => p.id === openId) ?? null;
  const by = (key: SortKey) => () => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === 'symbol' || key === 'age' ? 1 : -1 }));
  const th = (key: SortKey) => ({ active: sort.key === key, dir: sort.dir, onClick: by(key) });

  return (
    <>
      <PageHeader title="Positions" subtitle="What it holds right now. Prices update live on every trade." />

      <section aria-label="Invested now summary" className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile compact label="Open trades" value={`${list.length}${ov.data ? ` / ${ov.data.maxPositions}` : ''}`} sub={bigOpen ? `${bigOpen} on bigger coins` : 'slots in use'} />
        <StatTile compact label="In trades" value={sol(inSol, 2)} sub={ov.data ? `${sol(ov.data.balanceSol, 2)} free` : undefined} />
        <StatTile compact label="Unrealised" value={<Pnl value={list.length ? unreal : null} />} sub="if sold now, after fees" tone={unreal > 0 ? 'up' : unreal < 0 ? 'down' : undefined} />
        <StatTile compact label="Banked" value={<Pnl value={list.length ? banked : null} />} sub="partial sells so far" />
      </section>

      <Tabs
        tabs={[
          { key: 'invested', label: 'Invested now', badge: list.length },
          { key: 'bigger', label: 'Bigger coins', badge: swingLive },
          { key: 'dips', label: 'Waiting for a dip', badge: dips.data?.length ?? 0 },
        ]}
        value={tab}
        onChange={setTab}
        sticky
        label="Positions"
      />

      {tab === 'invested' && (
        <>
          {error && <ErrorBox message={error} />}
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="no-scrollbar flex gap-1.5 overflow-x-auto" role="group" aria-label="Show">
              <Chip active={group === 'all'} onClick={() => setGroup('all')} count={list.length}>All</Chip>
              <Chip active={group === 'small'} onClick={() => setGroup('small')} count={list.length - bigOpen}>New coins</Chip>
              <Chip active={group === 'big'} onClick={() => setGroup('big')} count={bigOpen}>Bigger</Chip>
            </div>
            {q && (
              <span className="inline-flex items-center gap-2 text-sm text-ink-2">
                Matching “{params.get('q')}”
                <button type="button" className="font-medium text-accent-text hover:underline" onClick={() => setParams({})}>clear</button>
              </span>
            )}
            <label className="flex items-center gap-1.5 text-sm text-ink-2 md:hidden">
              Sort
              <select value={`${sort.key}:${sort.dir}`} onChange={(e) => { const [k, d] = e.target.value.split(':'); setSort({ key: k as SortKey, dir: Number(d) as 1 | -1 }); }} className="min-h-10 rounded-xl border border-line-strong bg-surface px-2 text-sm text-ink">
                <option value="age:1">Newest</option>
                <option value="multiple:-1">Best first</option>
                <option value="multiple:1">Worst first</option>
                <option value="size:-1">Biggest</option>
              </select>
            </label>
          </div>
          {loading && !positions ? (
            <Loading kind="table" />
          ) : !list.length ? (
            <Empty action={<Button variant="outline" size="sm" onClick={() => setTab('bigger')}>See the coins it watches</Button>}>Not invested in anything right now. The bot buys when a coin passes every rule.</Empty>
          ) : !shown.length ? (
            <Empty action={<Button variant="outline" size="sm" onClick={() => { setGroup('all'); setParams({}); }}>Show all</Button>}>No open trades match.</Empty>
          ) : (
            <>
              <ul className="stagger grid gap-3 md:hidden">
                {shown.map((p) => (
                  <PositionCard key={p.id} p={p} onOpen={() => setOpenId(p.id)} />
                ))}
              </ul>
              <div className="hidden md:block">
                <Table minWidth={980}>
                  <thead className={theadCls}>
                    <tr>
                      <Th {...th('symbol')}>Coin</Th>
                      <Th right {...th('size')}>In trade</Th>
                      <Th right>Market cap in → now</Th>
                      <Th right {...th('multiple')}>Multiple</Th>
                      <Th right {...th('pnl')}>P&amp;L</Th>
                      <Th right {...th('age')}>Age</Th>
                      <Th className="w-48">Stop → next target</Th>
                      <Th right>
                        <span className="sr-only">Actions</span>
                      </Th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((p) => (
                      <tr key={p.id} className={`${trCls} cursor-pointer`} onClick={() => setOpenId(p.id)}>
                        <td className={tdCls}>
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-ink">{p.symbol}</span>
                            {isFresh(p) && <LiveDot />}
                          </div>
                          <div className="mt-0.5 flex items-center gap-1.5">
                            <Badge>{STRATEGY_LABEL[p.strategy] ?? p.strategy}</Badge>
                            {p.learning && <Badge tone="accent">learning</Badge>}
                          </div>
                        </td>
                        <td className={`${tdCls} text-right text-ink-2`}>
                          {sol(left(p), 3)}
                          <div className="text-xs text-muted">{Math.round(p.remainingPct)}% left</div>
                        </td>
                        <td className={`${tdCls} text-right`}>
                          <span className="text-ink-2">{mcIn(p)}</span> <span className="text-muted" aria-hidden="true">→</span> <span className="font-medium text-ink">{mcNow(p)}</span>
                          <div className="text-xs"><McChange value={p.mcChangePct} className="text-xs" /></div>
                        </td>
                        <td className={`${tdCls} text-right text-base font-semibold ${p.multiple === null ? 'text-ink-2' : p.multiple >= 1 ? 'text-up' : 'text-down'}`}>{multiple(p.multiple)}</td>
                        <td className={`${tdCls} text-right`}>
                          <Pnl value={p.unrealizedPnlSol} />
                          <div className="mt-0.5"><PnlChip value={posPct(p)} /></div>
                        </td>
                        <td className={`${tdCls} text-right text-ink-2`}>{ago(p.openedAt).replace(' ago', '')}</td>
                        <td className={`${tdCls} w-48`}>
                          <RangeBar p={p} compact />
                          <div className="tabular mt-2 truncate text-xs text-muted">{rangeText(p)}</div>
                        </td>
                        <td className={`${tdCls} text-right`} onClick={(e) => e.stopPropagation()}>
                          <div className="flex justify-end gap-1.5">
                            <Button size="sm" variant="ghost" onClick={() => setOpenId(p.id)}>Details</Button>
                            <Button size="sm" variant="outline" onClick={() => sellPosition(p, () => void reload())}>Sell</Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            </>
          )}
        </>
      )}

      {tab === 'bigger' && <SwingCoins data={swing.data} reload={swing.reload} />}
      {tab === 'dips' && <DipWatch rows={dips.data} />}

      <Drawer open={!!opened} onClose={() => setOpenId(null)} title={opened?.symbol ?? ''} subtitle={opened ? `${STRATEGY_LABEL[opened.strategy] ?? opened.strategy} · opened ${ago(opened.openedAt)}` : undefined} wide>
        {opened && <PositionDetails p={opened} onSold={() => { setOpenId(null); void reload(); }} />}
      </Drawer>
    </>
  );
}
