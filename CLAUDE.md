# Project handoff — Solana Pump.fun trading bot

Read this first when continuing work in a new session.

## What this is
Autonomous Pump.fun scanner + scorer + paper trader with a web dashboard (installable PWA).
Owner has some coding knowledge; explain simply, keep chat short, spend effort on the bot itself.
Original master plan: 9 phases (scanner → scoring/paper → dashboard → live execution → controls →
smart money → learning engine → ML → social). See README.md.

## ⛔ VERDICT (Oct 18 2026, end of day) — READ BEFORE PROPOSING ANY CHANGE
Every edge the research pointed to was tested on the bot's OWN data (Performance → Money) and lost: coin filters /
score bar (7,365 coins, 11% ever reached break-even, median −5%, perfect exits +3%), the Sniper replay (188 trades,
−5.7 SOL), copying winners and the owner's wallets (2,966 copies, 13% won, −134 SOL, 0 consistent wallets), elite
repeat-graduator deployers at launch (2 / 5 / 15 / 60 s, dip entries, 10 min – 12 h holds: best PF 1.03 on 97 trades,
41 stopped at −67%). The elite signal itself is real (41.9% graduate vs 2.6%) but half of those graduate inside the
launch's first moments — filled in the creation block by the deployer's bundle; only 1 of 97 followable elite launches
graduated. Conclusion, matching the public research: on pump.fun in 2026 a bot that reacts to trades (1–3 s late,
5–8% round trip) is the launch-block snipers' and sandwich bots' exit liquidity. **Do NOT propose rule / bar / exit
tweaks, more filters, more AI or "one more test" of the same kind.** Owner's options were put plainly: (1) stop
spending, keep paper running only as a watch (nothing built until the Money tab shows a group with a POSITIVE MEDIAN
on "Inside your filters"), (2) block-level sniping with Jito bundles against the deployers' own bundles — not
recommended, (3) a different venue (liquid Solana coins / order books) — a different product.

## v12 (Oct 18 2026): TWO SOURCES — crypto keeps running as a data collector, FOREX is the new focus
Owner: "keep the crypto bot running and gathering data, put it in its own tab, focus on forex with a lot more strategies;
once we have a live account we'll see." Crypto code is untouched (still paper, still learning). New, all in `src/forex/`:
- `types.ts` — 12 markets (`INSTRUMENTS`: EUR/USD, GBP/USD, USD/JPY, AUD/USD, USD/CAD, USD/CHF, NZD/USD, EUR/JPY,
  GBP/JPY, EUR/GBP, gold GC=F, silver SI=F) with pip size + typical retail spread; `Bar`, `Signal`, `Trade` (result in R).
- `data.ts` — Yahoo Finance chart API (no key; the sandbox can't reach it, the VPS can): 60m bars, 730 days on the first
  pull, last 7 days merged hourly; forming bar dropped; Redis `fx:bars:<id>` as [t,o,h,l,c] rows.
- `ta.ts` — causal indicators (ATR, Donchian, Supertrend, ADX, confirmed swings with `hiPtr`/`loPtr`, previous-day H/L/C,
  Asian range, 1h→4h aggregation; reuses EMA/RSI/MACD/Bollinger from the crypto TA lib).
- `strategies.ts` — 26 strategies, long + short mirrored: trend (EMA cross, EMA pullback, Supertrend, MACD, ADX,
  trendline break, break of structure), breakout (Donchian 20/55, Bollinger squeeze, Keltner, inside bar, breakout+retest),
  session (London breakout of the Asian range, NY open, previous-day high/low), reversion (RSI dip, RSI(2) Connors,
  Bollinger reversion, daily pivot S1/R1, Fibonacci 50–61.8%), patterns (engulfing, pin bar, double bottom/top, momentum
  candle) + `random` yardstick. Session ones 1h only; the rest run on 1h AND 4h.
- `engine.ts` — signal at the close → fill at the next open ± half spread; stop beats target in the same bar; gaps fill
  at the open; stops slip ¼ spread; trail / time / indicator exits. `equityCurve(trades, riskPct, maxLev 50)`: compounded,
  concurrent trades share equity, leverage capped, weekly results (avg / median / green % / weeks ≥+10% / best / worst),
  max drop, wiped (<10% of peak), median leverage.
- `lab.ts` — `ForexLab` (index.ts, 45 s after start then hourly): refresh data, run everything (~1.5 s), report to Redis
  `fx:report`: per strategy × tf all / first-70% / unseen-30% R stats, risk table 0.5/1/2/5%, per market, verdict
  (`verdictFor`: edge = unseen ≥30 trades, both halves positive, unseen PF ≥1.2, beats random by 0.05R; maybe; no).
  PAPER = trades opened after `fx:paper:since` (set on the first run) — a true forward test, same engine. No real orders.
- API GET `/api/forex`, POST `/api/forex/run`. Dashboard page **Forex** (`pages/Forex.tsx`, tabs Strategies / Paper /
  Setup; tap a strategy → weekly table per risk level). Nav regrouped: Forex / Crypto / Crypto lab / System; phone bar
  Forex · Crypto · Positions · Performance · More. tests/forex.test.ts (incl. a no-peeking test). 896 tests.
- **v12.1 Practice account** (owner: "practice FX trading with leverage, $1k, very accurate to the real market";
  "NOT a broker — payouts + many brokers ban bots"). `src/forex/practice.ts`: ONE simulated account in Redis
  `fx:practice` ($1,000 start, reset any time): open with pair / side / margin $ / leverage 1–500× / SL / TP in price;
  entry at the ask (buy) or bid (sell); P&L converted to USD (`usdPer`, `unitsFor`, `pnlUsd`; metals = oz in USD);
  SL / TP checked every 15 s against each 1-minute high / low since the last check (exit side of the book); stop-out
  closes everything at margin level ≤ 50%; refuses when the market is closed. Prices: **OANDA v20 when a token is
  saved** (`src/forex/oanda.ts`: live bid / ask, all 12 markets in one call every ≤2 s, M1 candles every 20 s) — the
  OANDA DEMO account is a free DATA feed only, nothing is ever sent to it; else Yahoo 1-minute (15–20 s cache, synthetic
  spread). API GET `/api/forex/practice`, POST `/open` `/close` {id|'all'} `/edit` `/reset`; GET `/api/forex/candles`;
  GET/PUT `/api/forex/oanda` (token tested before saving, stored in BotConfig `_oanda`, masked on read). Dashboard:
  Forex → **Practice** tab first (`components/FxTrade.tsx`: account tiles, pair strip with live prices, TradingView
  Advanced Chart widget `components/TvChart.tsx` on `OANDA:<pair>` — display only, TradingView has no data API — order
  ticket with amount / leverage chips / SL + TP in pips, position size, pip value, risk % of the account; open positions
  with live P&L and Close; history; reset). Forex → Setup → "Live price feed" (`components/OandaCard.tsx`).
  tests/forex-practice.test.ts. Real money later = on-chain perps from the owner's own wallet (no broker, no payouts).
- **v12.2 (Oct 19)** (owner: "see live charts of what it's looking at, the bot drawing trendlines, more strategies, better
  layout, research online"). `src/forex/drawings.ts` `drawingsFor(ctx)`: active trendlines through ≥2 respected confirmed
  swing lows (rising support) / highs (falling resistance) with touches + broken flag, horizontal levels where ≥3 swing
  points cluster (0.35 ATR), yesterday's H/L, Asian range. Lab report `markets[]` (per instrument, 1h): price, 24h %,
  72 closes, trend (EMA50 vs 200), RSI, ATR pips, strategies firing on the last closed bar (1h + 4h), open paper trades,
  last 150 bars + drawings. Trades now carry `stop` / `stop0` / `target`. Dashboard: Forex tabs **Live** (default; market
  cards → drawer with `components/MarketChart.tsx`, an SVG chart of candles + trendlines + levels + ranges + the bot's
  open trades, toggles, "what it sees" list, "Trade this yourself") / Practice (TradingView ⇄ "Bot's view" switch, your
  own trades drawn with SL/TP) / Strategies / Paper / Setup. **10 researched strategies** (research report in this
  session; sources: Moskowitz-Ooi-Pedersen TSMOM, SNB WP 2011-04 local hours, BoC SWP 2021-48 fix, Connors-Raschke):
  `tsmom` (120 bars), `tsmom_long` (480), `local_hours`, `fix_flow` (long USD 14–16 UTC), `turtle_soup`, `asian_fade`,
  `psar_adx`, `stoch_trend`, `cci_break`, `williams_r` (36 total + random). Ichimoku skipped (the one FX test found no
  edge). New indicators: PSAR, Stochastic, CCI; `Ctx.pair`. **Going live without a broker** = on-chain perps from the
  owner's wallet: gTrade first (FX 10–1000×, ~0.034% round trip, MIT SDK github.com/GainsNetwork-org), Ostium riskier
  ($23.8M oracle exploit 2026-07-15), Hyperliquid HIP-3 possible. Nothing wired yet; geo / terms unverified.
- **v12.3 (Oct 19)** (owner: "the bot should trade automatically when it sees openings / fixes; crypto layout much cleaner
  in case I add other things; lower the crypto rules so it trades and learns a lot without wasting money; prettier;
  TradingView bigger"). (1) **Forex auto-bot**: `Practice` now holds two accounts (`AcctId` 'me' → Redis `fx:practice`,
  'bot' → `fx:practice:bot`). `ForexLab` runs 90 s after every full hour (candle just closed) and calls
  `practice.syncBot(open lab paper trades)`: chosen = strategies with verdict edge/maybe + `FX_CONFIG.botAlways`
  (tsmom, tsmom_long, local_hours, fix_flow); a chosen lab trade opened ≤2 h ago and not yet held → opened at the live
  bid/ask with the lab's stop / target, size = 1% equity risk at 30× (`BOT`), ≤25% of free margin, max 8 open; a held
  trade the lab no longer has open → closed at market (reason 'signal'); stops / targets between runs by the 15 s
  practice tick. Redis `fx:bot:log` (100) / `fx:bot:chosen`. API GET `/api/forex/bot`; `?acct=bot` / body `acct` on
  practice close / reset. (2) **Crypto = paper data collector**: migration v52 — Sniper off, CURVE_SNIPE / SWING / RUNNER
  on (copy stays off), quiet hours off, dip-only off, score bar 55, edge gate off, maxPositionSol 0.2, 20 positions,
  learning trades margin 15 / 10 open / 40 an hour; guards + owner filters unchanged. (3) **App = two workspaces**
  (`App.tsx` `WS`): a Forex | Crypto switch (sidebar top; phone header), each with its own menu + phone bar, System
  (Scanner, Controls) shared; `/` → last workspace (default Forex, localStorage `ws`); crypto overview moved to
  `/crypto`. Forex routes `/forex` (Live), `/forex/practice`, `/forex/bot` (`components/FxBot.tsx`), `/forex/strategies`,
  `/forex/paper`, `/forex/setup` (page reads `:section`, no inner tabs). Practice: chart + order ticket side by side on
  wide screens, TradingView ≈ 68% of the screen height (≥560 px).
- **v12.4 (Oct 19)** (owner: "does it learn; crypto usage a lot less; forex should know news, holidays, banks; it's the
  weekend"). `src/forex/calendar.ts`: ForexFactory free weekly JSON (`nfs.faireconomy.media/ff_calendar_thisweek.json` +
  `nextweek`, hourly at most, Redis `fx:cal`) → `newsBlock(pair)` (High impact ±30 min for either currency, metals = USD;
  Holiday = whole day) + `marketClock()` (open Sun 17:00 → Fri 17:00 New York, sessions, `noNewTrades` last 2 h, `flattenNow`
  last 30 min). Auto-bot: no opens when blocked / near the close (logged "waited on …"), all bot trades closed at
  `flattenNow` (reason 'weekend'), and **self-pruning**: a strategy with ≥12 closed bot trades and a net loss is dropped
  (`practice.botResults`, Redis `fx:bot:dropped`). GET `/api/forex/calendar`; Forex Live / Practice / Auto-bot show the
  market clock bar (`components/FxNews.tsx` `MarketClockBar`), Live shows "News, central banks and holidays". Crypto costs:
  migration v53 — AI coach + AI meme reader off (Anthropic credits), live dry-run off (RPC), Helius 5k / FluxRPC 50k a day.
  The Chainstack Yellowstone add-on ($49) is the owner's call (free feed works for paper). tests/forex-calendar.test.ts.
- **v12.5 (Oct 19)** (owner: "know when there are presidential speeches or anything that could affect price action").
  `src/forex/headlines.ts`: ForexLive + FXStreet RSS every 5 min (Redis `fx:news`, 300, 3 days) → `classify` (currency
  keyword map incl. Fed/Powell/Trump/ECB/BoJ/intervention…, severity high on breaking / speech / tariff / war / surprise /
  rate-move / named leaders) → `headlineBlock` (high headline on either currency ≤30 min ago → no new bot trade);
  `priceShock` (last 15 one-minute bars' range > 1.5 × the 1h ATR → no new bot trade on that pair). Calendar
  `newsBlock` now also blocks Medium-impact speeches / testimony / press conferences. Bot log says why it waited.
  `/api/forex/calendar` returns `headlines`; Live news card has "Live headlines" + "Calendar" tabs.
  tests/forex-headlines.test.ts.
- **v12.6 (Oct 19) fix: crypto never traded** (owner's Bot health: 2 signals refused "sniper mode: only full-conviction
  setups", meme reader still spending, Helius budget still 25k). v52 / v53 only edited sections SAVED before
  (`applyMigration` skips missing rows), and sniper / meme / aiCoach / usage had never been saved → old defaults kept.
  New `ConfigMigration.create` (missing section → partial row, deep-merged over defaults; upsert) + migration v54 = the
  v52 + v53 values again with create. Lesson: a migration that must change a never-saved section needs `create: true`.
  tests/migration-create.test.ts.
- **v13 (Oct 19): the forex bot thinks wider** (owner: "do it all … make it work": currency strength, bigger-chart
  agreement, market mood, one bet per currency, safer sizing, news drift). All in `src/forex/`, all causal, all tested.
  - **Data**: `STRENGTH_PAIRS` (10 crosses AUDJPY CADJPY NZDJPY CHFJPY EURAUD EURCHF EURCAD GBPCHF GBPAUD AUDNZD, read
    ONLY for the meter, not traded) + `MOOD_SYMBOLS` (DX-Y.NYB, ^TNX, ES=F, ^VIX, CL=F → Redis `fx:bars:mood:<id>`);
    `refreshSeries` (data.ts) generalises `refreshInstrument`; feed rows carry `role` traded / strength / mood.
  - `strength.ts`: per currency the average vol-normalised return of its pairs (24 + 120 bars, ≈ z units) →
    `pairGap` (base − quote; metals = −USD), `gapSeries` per bar at its close. `mtf.ts`: `toDaily` (22:00 UTC days,
    slivers < 6 h dropped), `trendSeries` (close & EMA20 vs EMA50), `alignTrend` (only bigger bars FINISHED by the
    decision). `mood.ts`: risk score = avg(S&P 24 h % ÷ 1, −VIX 24 h % ÷ 7) clamped ±3, ≥ 0.5 risk-on / ≤ −0.5
    risk-off; `RISK_CLASS` AUD/NZD +1, CAD .6, GBP .2, EUR 0, USD −.5, CHF/JPY/XAU −1 → `riskOfLong(pair)`.
  - `filters.ts`: strength (gap ≥ 0.15 the trade's way), mtf (1h: 4h trend with it AND daily not against; 4h: daily
    with it), mood (no risk-on trade in risk-off / haven trade in risk-on, |exposure| > 0.4), all. Engine refactor:
    `signalsFor` once + `simulate(…, allow)` per filter (identical trades to the old runSeries — tested); trades carry
    `volRatio` (ATR ÷ 100-bar median). Lab runs every strategy × tf raw + 4 filters; `chooseFilter` picks on the
    FIRST 70% only (score avgR × √n, must beat raw by max(0.5, 10%), keep ≥ 40 / 25% of trades; last hour's pick
    kept through near-ties, Redis `fx:filters:chosen`); verdict / paper / bot use the chosen variant. `summarizeFilters`
    → report `filters` (Δ R/trade first 70% / unseen, % improved, trades kept, random + filter yardstick).
  - **News drift**: `shockDir` (range ≥ 2.2 ATR, body ≥ 60%, close in the outer quarter) → strategies `news_drift`
    (follow, stop mid-candle, 2R / 24 h) and `news_fade` (shock then a ≥ 35% give-back → target the shock open);
    family 'news'. `news-study.ts` → report `news` (move in ATRs after 1/4/12/24 h + % still past the close, by hour
    bucket, pair and — from the calendar history `fx:cal:hist` (high impact + speeches, 400 days, `mergeHistory`) —
    by kind: rates / CPI / jobs / GDP / PMI / retail / speeches).
  - **Sizing + one bet per currency** (`portfolio.ts` `SIZING`): risk = 1% × strategy factor (edge 1.25 / maybe 1 /
    unproven 0.6; in the honest test from first-70% stats) × wildness (`volFactor`: ratio > 1.4 → .75, > 1.8 → .5) ×
    drawdown (`ddFactor`: > 8% → .75, > 15% → .5; account `peakUsd`), clamped 0.25–1.5%; bot record ≥ 12 trades in
    profit ×1.15. Exposure: each trade = +risk on the bought currency, −risk on the sold one; > 2.2% one way on a
    currency → skip (`exposureBlock`, only when it ADDS to the concentration). Max 8 open, 3 per strategy, best-tested
    signal (`prio`) first. Practice `syncBot` applies all of it, follows the lab's trailing stop (only tighter, only
    while on the losing side), stores `riskPct` per position; `riskSummary` → `/api/forex/bot` `risk`.
  - **Honest whole-bot test** (`simulatePortfolio` + `monteCarlo`): strategies picked on the first 70%
    (`pickedOnInSample`: n ≥ 40, avgR ≥ 0.05, PF ≥ 1.15, + botAlways) traded together on the unseen 30% with margin
    (30×, ≤ 25% of free margin a trade), caps and sizing, at 0.5 / 1 / 2 / 3% base risk, vs the pre-v13 bot (raw
    strategies, flat 1%, no caps); weekly + monthly stats, 13-week block-bootstrap Monte Carlo (seeded). Redis
    `fx:portfolio` → `/api/forex/bot` `portfolio`.
  - Dashboard (`components/FxInsights.tsx`): Live = Currency strength + Market mood cards, market cards show 1h/4h/1D
    arrows, strength line and "held back" signals; Strategies = "Do the new checks help?" + filter badge per row +
    "Checks tried" table in the drawer + "After big moves"; Auto-bot = account tiles → "Honest test" (risk table, old
    vs new, Monte Carlo) → "Risk right now" (exposure vs cap). Setup lists the extra feeds. Lab run ≈ 10 s / hour.
  tests/forex-v13.test.ts (15). Numbers so far were only checked on SYNTHETIC candles (sandbox can't reach Yahoo):
  read the real "Honest test" card on the VPS before trusting anything.
- **v14 (Oct 19): skills pack** (owner: "a lot more skills that give us the edge"). Everything is still picked on the
  first 70% only and graded on the unseen 30%; nothing is used live unless it proves itself.
  - **Engine realism** (`engine.ts`): `spreadMult` (21:00 / 22:00 UTC bars ×3, first bar after a weekend ×4);
    `SimOpts.weekendPause` (default ON, = the live bot): an open trade banks its leg at Friday's close; if Monday's
    open is past the stop / target it ends there (reason 'weekend'), else it re-enters at the open (gap excluded, extra
    spread paid). R accounting with legs (`legEntry`, `frac`, `realized`). Signals may carry `beAtR` (stop → entry +
    costs at +1R, reason 'breakeven') and `scaleAtR` / `scaleFrac` (part off at +1R, then break-even); a candle that
    reaches the level and comes back is assumed to hit the new stop (pessimistic). Trades carry `beAt` / `scaleAt` /
    `scaleFrac` / `scaled`. `volRatioAt` is memoised per ctx (`vrCache`) — it was 50% of the lab's CPU.
  - **Exit lab** (`exits.ts`): designed / breakeven / scale (half at +1R) / tight (0.6× target, or 1.5R) / runner (no
    target, trail 2.5 ATR) / quick (12 bars 1h, 6 bars 4h). Pass 2 per strategy under its chosen filter;
    `chooseVariant` (generic: avgR × √n, margin, ≥ 40 trades, hysteresis — Redis `fx:filters:chosen` now {f, e});
    `summarizeExits` → report `exits`; rows carry `exit` + `exitVariants`.
  - **Regime filter** (`filters.ts` 'regime', `ER_TREND` 0.3 on `ctx.er20` Kaufman efficiency ratio): `styleOf`
    (strategies.ts: trend / revert / pullback / neutral; pullbacks and timing rules pass) → trend rules need ER ≥ 0.3,
    fade rules ER < 0.3.
  - **New strategies**: `ccy_momentum` (Menkhoff et al.: base top-2 vs quote bottom-2 on 5-day strength, newly),
    intermarket catch-ups `oil_cad`, `yield_jpy`, `stocks_jpy`, `dollar_gold` (linked market 24 h z crosses ±1.5 and
    the pair's own `pairZ` hasn't followed; 1.5 ATR, 2R, 24 h), flows `weekend_gap` (gap ≥ 0.5 ATR still open after
    the first hour → back to Friday's close), `month_end_flow` (Melvin & Prins: last weekday, 14→16 UTC, S&P MTD ±2%
    → sell / buy USD), `nr7_break` (Crabel NR7, 07–16 UTC break of yesterday's range, stop mid-range, 2R, flat by 22).
    Families 'intermarket' / 'flow'. `ctx.ext` (`CtxExt`, set by the lab from `intermarket.ts`: `z24Series` (time-based
    24 h log change ÷ rolling sd of ~400 readings, causal), `mtdSeries`, `strengthRanks` / `pairRanks`, `alignAt`).
    `ctx.nr7`, `ctx.er20` in buildCtx.
  - **Signal judge** (`judge.ts`, meta-labeling): 24 context features at the signal bar (`judgeFeatures`: side,
    strength / 4h / daily / mood alignment, wildness, ADX, RSI, ER, ATR %, distance to EMA50 / 200, squeeze, hour, day,
    candle size, style, the row's first-70% avg R, the strategy's last 10 results before entry, JPY / metal, tf, stop
    and target size) → GBDT (crypto `tree-model.ts` `boost` / `cutPoints` / `sigmoid` now exported; depth 3, lr .06,
    min child 20, ≤ 200 rounds, early stop on the newest 20% of the first 70%) → keep share picked there (90…40% by
    avgR × √n) → ONE exam on the unseen 30%: active only if AUC ≥ 0.53, kept avg R ≥ all + 0.03R, ≥ 60 kept. Redis
    `fx:judge` (model) + `fx:judge:report`; live: open paper trades get `judge` {p, ok, need} → `syncBot` skips "the
    signal judge gives it X%". Report `judge`; portfolio `judged` (upgraded bot at 1% with the gate, unseen).
  - **Walk-forward** (`portfolio.walkForward`): every month re-pick strategies (raw rules) on trades closed in the
    previous 6 months (n ≥ 15, avgR ≥ .05, PF ≥ 1.15, + botAlways) → trade only those that month → one long honest
    record (~18 months) at 1% → portfolio `walkForward`.
  - **Bot account** (practice.ts): positions carry `beAt` / `scaleAt` / `scaleFrac` / `scaled` / `be`; `tick` takes the
    part off at `scaleAt` (`closePart`, closed row reason 'partial') and moves the stop to entry; weekend flatten
    stores `account.resume` and `syncBot` re-opens still-running lab trades once `sinceOpenMin ≥ 120` and not in the
    rollover (unless the gap went past stop / target); no new trades in the rollover (`marketClock().rollover`
    20:45–23:15 UTC) or the first 2 h of the week; `botResults` counts partial / weekend legs as money, not trades.
  - Dashboard: Strategies = Signal judge card, "Do other exits help?" card, exit badge + "Exits tried" table; Auto-bot =
    judge + rolling-test rows in the Honest test, half-off / break-even on open trades, explanation updated.
    Report trimmed (`slimTrade`, 7-digit prices, slim per-pair stats): ~410 KB. Lab ≈ 12 s per hourly run (sandbox).
  tests/forex-v14.test.ts (20). Again: verified on SYNTHETIC candles only — read the real cards on the VPS.
- **v15 (Oct 18): more pips, 15m + 1m charts, the bot's plan, auto-bot = home** (owner: "more pips, trailing take
  profit"; "I want to know what the bot is looking to trade and what the plan is"; "I don't wanna make the trades, the
  bot makes them"; "trade on a 15 min timer, 1 min too").
  - **Trailing take-profit** (engine `simulate`): `Signal.tpTrail` (ATR) + `tpFrac`: at the target the trade is NOT
    closed — `tpFrac` of what is left is banked there, the stop locks `tpDist` (= tpTrail × ATR at the signal bar) behind
    the target (never under entry + costs), target / exitWhen / maxBars are cleared, then it trails behind the best
    close. Same candle: green → only its close can hit the new stop, red → its low can. Trades carry `tpTrailPx`,
    `tpFrac`, `tpHit`, `target0` (the judge uses `target0`: the live target would leak the outcome); open trades carry
    `trailAtr` / `maxBars` / `exitWhen` (the plan shows them). Exit lab variants `wide` (target ×1.6 / trail ×1.5 /
    maxBars ×2), `trail_tp` (tpTrail 1.5), `half_trail` (tpTrail 2, half off); a variant that changes nothing for a
    strategy reuses the designed trades; `FX_CONFIG.preferTrailTp`: `preferVariant` (filters.ts) switches to the best
    trailing take-profit when it scores within 5% (or 0.1) of the pick on the FIRST 70% only.
  - **Live edge** (`SimOpts.liveEdge`, default on; `signalsFor` now includes the last bar): a signal on the LAST closed
    bar is an 'open' trade filled at that close (entryT = bar t + bar length). Before, a lab trade only existed after the
    next bar closed → the bot entered a whole bar late. `signalIndex` finds the signal bar of such trades.
  - **Lab refactor** (lab.ts): `evaluateTf` (filters → exits → verdict vs random → paper) is shared with the fast lab;
    `makeSeries(inst, tf, bars, book, big1, big2)`; `ForexLab.book` = the hourly market read (`MarketBook`: strength,
    mood, ranks, z-series, h1 bars). Bot results / `dropped` are keyed `strategy:tf`. `runsOn(s, tf)` (strategies.ts):
    session rules 1h only, `slow` rules (ccy_momentum) 1h / 4h only.
  - **15-minute + 1-minute charts** (`src/forex/fast.ts` `FastLab`, started in index.ts): candles from OANDA when a
    token is saved (paged back with `to`), else Yahoo (15m ≤ 60 days, 1m ≤ 30 days in 7-day pieces), kept in memory +
    Redis `fx:bars:15m:<id>` / `fx:bars:1m:<id>` (210 / 21 days, persisted every 10 min). Hourly test at :31
    (`evaluateTf`, each chart's own 70/30 split, ≤ 20k bars a market) → Redis `fx:fast:report`, `fx:fast:chosen`, paper
    since `fx:fast:since`; the signal judge and the whole-bot test stay 1h / 4h. Live pass `decide(tf)` every 15m close
    + 40 s and every minute + 20 s (OANDA) / 2 minutes (Yahoo), market open only: newest 2,000 bars → what fired (all
    strategies, for the plan) + the chosen strategies' open trades (filter + exit as tested) → `syncBot(…, { scope: [tf] })`.
    Bigger charts: 15m checks 1h + 4h, 1m checks 15m + 1h (`BIGGER_CHARTS`). Same spreads everywhere: on 1m they eat
    most of a move, the test shows what is left. Sandbox can't reach Yahoo / OANDA: verified on SYNTHETIC candles only.
  - **Bot account** (practice.ts): `syncBot(labOpen, blockFor, atr, { scope, report })` only manages positions whose
    ref's chart is in `scope` (the hourly lab passes 1h + 4h) → one chart never closes another's trades; per-chart
    freshness `BOT.freshMsByTf` (1m 2 min, 15m 20 min, 1h / 4h 2 h) and caps `BOT.maxOpenByTf` (1m 2, 15m 3, total 8);
    `SyncReport` (candidates / opened / skipped / waits). `tick`: trailing take-profit at the target (part off, stop
    locked, target null); `syncBot` converts a position when the lab's trade reached its target first (`lab.tpHit`).
    Positions carry `tf`, `tpTrailPx`, `tpFrac`, `tpHit`, `trailAtr`, `maxBars`, `exitWhen` (`planOf`).
  - **The bot's plan** (`src/forex/plan.ts` `buildPlan`, pure; GET `/api/forex/bot` → `plan`): summary line, next check
    per chart (`nextChecks`), per market status (in a trade / waiting / watching / paused), `leanOf` (strength gap,
    4h + daily trend, mood fit: 2+ on one side = a lean), the signals on the newest 1m / 15m / 1h / 4h closes with what
    happened to each (in the trade, waiting: why, held back: which check, already in a trade, not one it trades), news
    coming up (`ForexCalendar.upcoming`), per open trade every exit rule in words (`tradeLines`), and the check timeline
    (`ForexLab.runs`, Redis `fx:bot:runs`, 40 per chart, incl. "nothing fired"). `ForexLab.marketsNow / moodNow /
    labOpen / lastSync / chosen` + `FastLab.firing / chosen / labOpen` feed it.
  - Dashboard: Forex home `/forex` = **Auto-bot** (`FxBot.tsx`: "The bot trades by itself", summary + next checks,
    trades with their plan, "What it's watching and waiting for" (tap a market), "What it did" (Checks / Decisions),
    honest test, risk, how it trades, closed trades); `/forex/live` = Markets; Practice renamed "Trade by hand" (More
    menu); `/forex/bot` redirects home. Strategies / Paper merge the fast rows (chips 1m / 15m / 1h / 4h); Setup shows
    the 15m / 1m candle feed. tests/forex-v15.test.ts (22).
- **v15.1 (Oct 18): trailing stop-loss** (owner: "a trailing TP that moves along with the trade is more a trailing SL
  for safety"). `Signal.trailR`: from the entry on the stop follows the best close at that many R (starting stop
  distances) behind it — break-even at +1R, +1R locked at +2R — never back; engine trails ATR (`trailAtr`) and R
  (`trailPx` = trailR × risk) together, the tighter wins. Exit variant `trail_sl` (trailR 1 + at the target a trailing
  take-profit 1.5 ATR). `OWNER_EXITS` = ['trail_sl', 'trail_tp', 'half_trail'] in that order; `preferVariant` now takes
  the ordered list and compares against the BEST variant with enough trades (first 70% only, within 5% / 0.1): the
  first owner exit that qualifies is used. On synthetic candles the 1R trailing stop-loss cost ≈ −0.25R a trade (cuts
  winners in noise) and was picked by 3 of 70 strategies — real data decides. Bot positions carry `trailPx`; the plan
  says "Trailing stop-loss: follows the price N pips behind…". `FX_CONFIG.preferTrailing` (was preferTrailTp).
- **v15.2 (Oct 18): bigger size + leverage when more sure** (owner: "take bigger leverage trades if it's more sure of
  its entry"). `src/forex/conviction.ts`: confirmations at the signal close = `agreeCount` (strength gap ≥ 0.15 its
  way, next bigger chart with it, the chart above with it, clear mood with real risk exposure its way; 4h max 3) + on
  1h / 4h the judge's score ≥ its first-70% top-30% cut (+1) / top-10% cut (+1) (`judgeCuts`). Tier 'sure' ≥ 3,
  'very sure' ≥ 5 (≥ 4 on 15m / 1m: no judge). `gradeConviction` (picked-on-first-70% strategies' closed trades):
  'sure' active only if on the UNSEEN 30% it made ≥ +0.1R a trade over all trades on ≥ 60 trades (no judge: the first
  70% must point the same way too); 'very sure' must also beat 'sure' by 0.05R. `boostFor` → 'sure' 1.5× risk at 50×,
  'very sure' 2× at 100× (`CONVICTION.maxRiskPct` 2% cap via `clampRisk(…, maxMult)`), else normal (30×). Hourly lab:
  Redis `fx:conviction`, report `conviction`, portfolio `convicted` row ("bigger size when sure" at 1%; `PTrade.maxMult`
  / `lev`); fast lab: `FastReport.conviction['15m' | '1m']`. Bot: `LabOpenTrade.conviction` {tier, conf, of, mult, lev}
  → `syncBot` risk × mult (cap 2%) at that leverage; positions + weekend resume keep it; the plan's first line says
  the size decision. The currency cap (2.2%) still applies, so a 2% trade blocks a second bet on the same currency.
  Dashboard Auto-bot: "Bigger size when it's more sure" card (per chart group: on / off + why, unseen R per tier).
  Synthetic candles: not proven on any chart (sure trades not clearly better) → normal size; real data decides.
- **v15.3 (Oct 18): fixes from an independent review of v15–v15.2.** (1) Fast lab: a 15m / 1m strategy that stops being
  chosen (verdict flip, dropped) no longer gets its running bot trades closed as "strategy exit": `decide` also
  simulates strategies the bot still holds (`Practice.heldRefs`) and passes them with `chosen: false` (manage, never
  open); no fast report → no sync at all. (2) Trade identity = `Trade.keyT` (signal bar's close; `tradeKey` uses it,
  `PTrade.keyT`): a missing bar after a signal no longer renames the trade (= close + re-open, two spreads). (3) Bot
  self-pruning: `PracticeAccount.stats` per `strategy:tf` = newest 40 finished trades [closedAt, USD incl. parts taken
  (`bankedUsd`) and weekend legs (`ResumeItem.bankedUsd`)], `botRecordOf` counts the last 30 days (a dropped combo
  gets another chance after a month); older accounts rebuild it once from the closed list (`ensureStats`). Before,
  fast trades scrolled the 200-row closed list and 1h / 4h combos never reached 12 trades. (4) `preferVariant(…, prev)`:
  last hour's owner exit stays while within 10% / 0.2 (no hourly flips). (5) `syncBot`: when the lab's (tighter) stop
  is already crossed by the price, close at market instead of keeping the looser stop (covers a lab target hit the
  bot's feed missed). (6) Engine: a gap through the target at the open checks the whole candle against the locked
  stop. (7) Engine: scale-out takes a share of what is left (`frac × scaleFrac`). (8) Load: fast test ≤ 14k bars a
  market (was 20k; reviewer measured 23 s / +400 MB heap at 20k), yields after every long simulation. Behaviour notes:
  with the live edge, 4h trades now open for real (before they were always older than the 2 h freshness); the first
  v15 run could switch exits and close some bot trades as "signal" once. If memory stays tight, move the fast test to
  a child process like the replay runner.
- Owner wants weekly / monthly big returns; told plainly that only leverage makes that and the risk table shows the cost.
  Live forex needs an account (Hyperliquid / Ostium on-chain perps, or a broker API) — only after Edge + paper agree.

## FREEZE ENDED (Oct 17 2026 — owner: "the trades are too bad, upgrade everything, make it profitable")
The Oct 15 freeze below is over; v11 (below, "Current state") is the new setup. Judge it on Performance → Mistakes
after 200–300 trades, same rule as before: switch losers OFF, don't tweak.
**v11.7 Sniper mode is the setup to judge now: fewer, bigger trades — judge it after ~100 trades** (Controls → Trading
→ "Sniper mode" shows the ten rules in force; test any change first with the replay). **Oct 18: 0 signals for 14 h and
every near-miss lost (score-gap card) → the question is which KIND of coin pays at all: read Performance → Money (v11.17)
before touching any bar or rule.**

## ⛔ (old) FREEZE (owner's order, Oct 15 2026 — v10.39 was the frozen version)
**Do NOT push ANY change — no new features, no rule / setting / default tweaks, no tuning, no refactors — unless something
is BROKEN** (crash, bug, wrong numbers, bot not trading because of a fault, dashboard error). Owner: "don't accept ANY
updates unless something is broken, no new features or changes." Every push redeploys + restarts the bot, which also
breaks the freeze. If the owner asks for a new feature or a tweak during the freeze, remind them of this rule and ask them
to confirm they want to end the freeze first. Freeze goal: 5–7 days / 200–300 trades on one fixed setup, then judge each
strategy on Performance → Mistakes ("Does each strategy deserve to run?") and switch losers OFF (don't tweak).
Diagnosing (reading code, explaining Bot health, diagnose.sh output) is always fine — it changes nothing.

## Oct 17–18 build queue — DONE (v11 … v11.16, last push 67818ed)
Shipped: v11 overhaul, tape + replay, wallet engine, Sniper mode, research ports, Obsidian brain, deployer history +
holder-growth exits, dashboard colour pass + full LAYOUT rebuild, 4 GB tuning, momentum-gate fix (v11.12, after 11 h
without a buy signal), self-improving loop (v11.13), live execution DORMANT (v11.14), policy tournament (v11.15), AI
meme-reading (v11.16). OFF the list (owner): Bonk.fun, market regime gate.
NEXT (no new features unless the owner asks): watch Bot health (signals per hour, "Live path: N simulated, X% OK"),
the nightly loop's experiments (Brain page), the tournament (Performance → Tests). Open question: the score bar — the
owner was given three replay commands (sniper as-is / momentum fix / + score bar 55 & margin 4); decide from them.
Go/no-go for real money Nov 7 on paper edge (owner's go-live checklist is in the v11.14 bullet). Target: real money by
December (small wallet in Nov only if paper edge is positive).

## Where things run
- **Branch:** `claude/festive-albattani-6aufe6` (all work goes here; the VPS and GitHub Pages follow it).
- **VPS:** Vultr, Ubuntu 24.04, `ssh root@209.250.254.34` (SSH key from the owner's Windows PC).
  Repo at `/root/bot`. `docker compose` runs postgres (TimescaleDB), redis, bot, caddy.
  Cron runs `scripts/auto-update.sh` every minute (GitHub checked every 5 min or on the dashboard's Update button).
  Log: `~/bot-update.log`. Bot logs: `docker compose logs -f bot`.
- **API:** `https://209-250-254-34.sslip.io` (Caddy → bot:8080, Let's Encrypt).
- **Dashboard:** `https://smaxhy.github.io/super-secret-weapon/` built by `.github/workflows/dashboard.yml`
  on pushes to the branch (github-pages environment allows the branch).
- Secrets live only in `/root/bot/.env` on the VPS (never in git).
- **Oct 17: 4 GB VPS tuning** (Vultr resize 2 → 4 GB RAM / 80 GB SSD; all in `docker-compose.yml`, applied by the normal
  auto-update `docker compose up -d --build`): Postgres `-c` flags (shared_buffers 512 MB, effective_cache_size 1.5 GB,
  work_mem 16 MB, maintenance_work_mem 128 MB, max_wal_size 1 GB, 4 Timescale background workers, 8 worker processes,
  2 parallel) + `shm_size` 256 m — command-line flags beat the postgresql.conf timescaledb-tune wrote at first init;
  Redis maxmemory 2 GB (noeviction), appendfsync everysec, lazyfree; bot `NODE_OPTIONS=--max-old-space-size=1536
  --max-semi-space-size=32`; memory caps bot 2 g / postgres 1.5 g / caddy 128 m (Redis: no hard cap — its own maxmemory governs; an AOF rewrite forks and briefly doubles RSS) (soft reservations
  768/512/768/32 m — caps are ceilings, expected use ≈ 2.2 GB; `oom_score_adj` bot +300, databases −500 so the bot
  dies first if the kernel must kill); every service logs rotate at 20 MB × 5. `scripts/diagnose.sh` prints memory
  vs limit per container, the Postgres settings in effect and the TradeTape size / compression.

## Current state (keep this section updated)
- Phases done: 1 (scanner), 2 (scoring + paper trading), 3 (API + dashboard + PWA), 7 (learning:
  outcome labels 1h after each stored evaluation, Bayesian pattern odds, nightly weight tuning 00:05 UTC,
  regime detector every 15 min), plus parts of 6 (PumpSwap/migration strategy, copy-trading tracked
  wallets) and 9 (free metadata socials/keywords). Positions stream live over WebSocket ('positions').
- Mode: **PAPER** (10 SOL fake balance). No wallet key on the server. Phase 4 (live) built DORMANT in v11.14 — see the go-live checklist there.
- **STRATEGY v5 (Oct 10, after the owner's CSV: 26 trades, −0.92 SOL, +3% wins vs −16% losses; based on
  3 research reports — see "v5 research" below).** Diagnosis: (1) USD rules bought late — with SOL ≈ $80,
  $12k MC = 75%+ curve, SOON $20k = ~90% (where holders dump into graduation); (2) entries ~27 s after launch
  = inside the snipers' dump window (exit liquidity); (3) exits needed 84% winners (1.15x 6% trail, BE 1.2x);
  (4) fake peaks (sandwich prints + PumpSwap raw-vault pricing) armed trails → "insta sells"; (5) PumpSwap fee
  0.3% assumed vs real ~1.25%; (6) swing re-buys of the same losers. v5 fixes all six:
  - **NEW PAIRS = CURVE_SNIPE** (`focus.newPair`, `src/evaluator/new-pair.ts`, 55% allocation, max 3 open):
    45 s–12 min old, ≥8 SOL in the curve, MC $3.5k–$15k (owner: no dip wait under $15k), curve ≤85%;
    **absorption**: launch wallets (first 4 s of trading) hold ≤10% or sold ≥50%, dev sold ≤5% & holds ≤10%,
    top-10 ≤30% (and not mostly first-25 buyers once ≥50 buyers), price ≥80% of its held post-launch high;
    **organic demand (60 s, dev/snipers/repeat-size bots excluded)**: ≥12 buyers, ≥8 first-timers, last 30 s ≥
    previous 30 s, net ≥+1.5 SOL, buy/sell ≥1.3 SOL & ≥1.5 count, size CV ≥0.5, ≤25% same size, median ≥0.05,
    no gap >15 s, bot volume ≤40%; **trigger**: ≤7% under the 2-min high, ≤+35% in 30 s, no ≥1%-of-supply
    sell in 5 s, standard 1B supply (Mayhem excluded). No 12 s confirmation, no risky half-size entries,
    score bar −8. `src/scanner/new-pair-watcher.ts` re-checks a coin the moment its flow gets hot (≤1/15 s);
    checkpoints 45…720 s; dead coins / past 12 min → done. Paper buys refuse fills >6% worse than the
    decision price (`maxSlippageBps`, `expectedPriceSol`). E2E: bought after snipers dumped at $4.3k MC →
    40% at 1.4x, initials 2.06x, runner trailed out at 1.76x (+62%); dud → stopped at −12.9%.
  - **SOON**: curve 70–90% only (≥1.65× left), 20% allocation, bar/size normal. **MIGRATION**: 25%, no
    entries in the first 330 s after migration (BOOST: ~17.6 SOL of mechanical buys for 5 min, then
    liquidity drains ~57% to minute 30); checkpoints 330 s…1 h. **COPY: off** (copying 2 s late lost under
    every exit rule in public tests; KOL buys stay a bonus/trigger-to-check only).
  - **Exits v5**: 40% at 1.4x (TP1), initials at 2x, 15% at 5x; trail + break-even floor only from TP1
    (ladder 20% → 25% at 2–3x → 22% at 5x → 20% at 10x, ×0.8–1.2 vol); break must hold 0.5 s (gap = instant);
    stop 12–20% (owner's band, confirmed 2 s; hard limit instant); **time stops** (`exit.timeStop`) new pair
    1.5 min without 1.1x & ≤1.02x → out, **stall** no new high 3 min below TP1 → out (SOON 3/5, MIGRATION
    10/10 min); **BOOST sell** (`exit.boostSell`): curve buys that graduate sell 40% at 60–240 s after
    migration; resistance / risk-in-profit exits only ≥1.5x; smart sell ≥1.6x; max hold 30/45/240 min.
  - **Peaks** = settledHigh (`src/lib/settled-price.ts`): a level counts only after the price HELD it 2.5 s
    (pool price after each trade, `CrowdTrade.pp`); trade-driven exit checks wait 120 ms for the slot to settle.
  - **PumpSwap pricing**: event vault balances aren't the program price (BOOST virtual quote reserves,
    unswept fees) → live-state stores the effective quote reserve implied by each trade (`ammEffectiveQuoteAfter`
    = Δq·B_before/Δb), dust trades apply to it; crowd `pp` = exec × B_before/B_after. **Tiered fees**
    (`pumpSwapFeeBps`, `paper.ammTieredFees`): 1.25% <420 SOL MC, 1.20% <1,470, 1.15% <2,460 … 0.30% ≥98k.
  - **Re-entries**: swing only after a profitable exit (`focus.swing.onlyAfterProfit`), max 1.
  - **Strategy cool-off** (`trading.strategyBreaker`): ≥12 of the last 20 trades (since `_strategySince`)
    averaging < −4% → no entries for 2 h after the last close. One-time upgrade `v5-strategy` reset the trade
    coach and set `_strategySince` (BotConfig `_upgrades`). Config migration v4 pushes all of this into saved rows.
  - **Strategy lab** (`lab` config, `src/learner/strategy-lab.ts`, `/api/lab`, Performance page card): every
    BUY signal (even when the trader is full) + near-misses (rules pass, score ≤6 short) are traded VIRTUALLY by
    6 exit variants through decideExit (same prices/costs): L live, S scalp (50% at 1.25x), B bigger (40% at
    1.5x, 25% at 2x, 30% trail), R runner (nothing before 2x), N no time stops, W wider −25…−30% stop
    (ownerOnly — outside the owner's band, never auto-applied). Auto-apply: ≥40 results, mean−1SE > 0, beats
    live by ≥2 pts → written into the live exit config (≤ once per 6 h). Redis `lab:res:<id>`, `lab:applied`.
  - v5 research (Oct 2026; protocol truth as of Oct 2026 = Chainstack's
    https://github.com/chainstacklabs/pumpfun-bonkfun-bot/blob/main/docs/pumpfun-protocol.md): graduation ~1–2% (0.26–6.7%); median graduate peaks AT graduation (~$31k at
    SOL $80); 81% of survivors fall 90%+; snipers profitable 87%, exit within 5 min; wash ≥17% of trades;
    copy-trading 2 s late lost; tight stops lose to costs (Lo & Remorov); round trip 5–10% at 0.2–0.5 SOL.
    Validate on ≥300 paper trades (positive median AND mean without the top 1%).
- Data source default `DATA_SOURCE=hybrid`: PumpPortal (launches/migrations) + Solana public RPC
  `logsSubscribe` (trades). Helius is only for RPC checks (1M credits/month plan — be frugal).
  Helius logsSubscribe burned ~5%/hour → never default to it.
- Entry pipeline (Oct 9 v3): min coin age 15s; BUY signal → **confirmation** re-check after 12s (price
  −8%…+30%, buy/sell ≥1) → **pre-entry rug screen** in the trader (`src/executor/rug-screen.ts`: insider dump,
  dev selling, bundlers dumping, top-10 jump, liquidity pulled, 1-min dump, whale sell, −15% since signal).
  Manipulation (`entry.manipulation`, crowd log for every coin with slots): fake/wash volume >50%, same-slot
  same-size bundles >30%, top-3 wallets >65% of volume → no buy; smaller amounts + chasing (>20/40% in 3 min)
  → points off; min-volume rule uses organic volume. **Score calibration** (`src/learner/score-calibration.ts`):
  real win rate per strategy per 5-pt band (7d) → −10…+4 pts and ×0.7–1.3 size (stored `preCalibrationScore`).
  **Conviction sizing**: maxPositionSol = average size; ×0.4–1.6 by score margin, band record, crowd; capped at
  ×1.6 and 6% of capital. Insider same-size bursts: same slot only, first 3 min only, terminal presets ignored.
- **v6 (Oct 10): chart-strategy library + live lab + trending tabs** (owner: "learn many more strategies like
  Fibonacci… keep the trending tab in check"). Research: costs (~6% round trip) kill small edges — only big
  moves pay (bursts, deep-pullback reclaims, breakouts); Fibonacci evidence is weak → test it vs control depths;
  judge everything vs a random-entry control; many strategies tested at once → false-discovery control.
  - `src/evaluator/ta/indicators.ts` (EMA/SMA/RSI/MACD/Bollinger/ATR/anchored VWAP±σ/OBV/CVD/Supertrend/
    Heikin-Ashi/StochRSI/swings/`lastImpulse` = last swing leg (stops at an earlier peak ≥20% above)/fib levels)
    and `src/evaluator/ta/strategies.ts`: 28 strategies on completed 15 s candles (gaps filled; `taContext`
    adds 1 m, trades + creator): fib golden pocket (0.5–0.7 reclaim, void <0.786, close > prev high, 1-min
    buy/sell ≥1.2) + CONTROL depths pullback_shallow (0.3–0.45) / pullback_deep (0.7–0.85), fib extension
    breakout, EMA ribbon pullback, Supertrend / Heikin-Ashi flips, MACD cross, RSI oversold bounce, RSI bull
    divergence, StochRSI cross, VWAP reclaim, VWAP −1σ bounce, capitulation wick, climax→retest, Bollinger
    squeeze, Donchian, tight range, Keltner, opening range (3–20 min old), ATH breakout, BOS after a higher low,
    liquidity sweep, bull flag, double bottom, CVD divergence, OBV lead, organic buying burst (≥20 organic
    wallets/min, imbalance ≥40%, ≥3 SOL net, +5…25%). Candles now use the pool price after each trade (`pp`).
  - **TA lab** (`src/learner/ta-lab.ts`, `ta` config, shared engine `src/learner/virtual-book.ts` — the exit
    lab uses it too): every 15 s the ≤150 most active coins (≥6 trades/2 min, MC ≥$3k, top10 ≤50%, dev ≤15%,
    bundles ≤25%) run all strategies; each signal = virtual trade with live exits (once per coin+strategy per
    30 min); `baseline_random` (1 in 40 looks) is the yardstick; external signals `trend_pump` / `trend_gecko`
    (coin newly on a trending tab) are measured the same way. Redis `talab:res:<id>`. **Proven** (provenStrategies):
    ≥60 results, avg ≥ baseline+2 pts, mean−2SE >0, profit factor ≥1.2, positive without its 3 best trades,
    and Benjamini–Hochberg (q 0.1) across all strategies. Proven ones add up to +8 score points (3 × edge/10
    each) and trigger an immediate evaluation when they fire. Nothing is proven by default. ~0.25 s CPU per
    tick, yields every 10 coins. `/api/ta-lab`, dashboard **Strategies** page (explanations + live records).
  - **Trending tabs** (`src/scanner/trending-feeds.ts`, `trending-hub.ts`, `trending` config): pump.fun
    frontend-api-v3 currently-live (real viewer counts `num_participants`) / king-of-the-hill / for-you /
    top-runners (≤6 req/min), GeckoTerminal trending_pools 5m+1h (every 3 min), DexScreener metas/trending →
    hot keywords; circuit breaker (403 HTML → 5 min pause, 429 → reset). New list entry → checkNow + lab
    signal (never a direct buy: lists catch coins after the move). trendScore: +2 per organic list (max +6),
    live ≥50 viewers rising +2, KOTH ≥5 min stalled −3 / accelerating +3, fresh (<1h) + paid + bundled/insiders
    −8 & half size (dev selling → no buy), banned / downranked / Mayhem → no buy; DEX paid bonus only for
    coins ≥1 h old. `/api/trending`, Scanner page "Trending tabs" card. (Sandbox can't reach these hosts; VPS can.)
- **v7 (Oct 10): SWING trading bigger coins + more trades** (owner: "swing more, especially bigger coins like
  $clude that keep bouncing back — allowed to hold bigger MC coins if it sees potential; trade more often, once an
  hour won't teach it anything"). New strategy **SWING** (Prisma enum + every per-strategy map; 30% allocation, max 3
  open; allocation now NEW PAIRS 40 / SWING 30 / MIGRATION 15 / SOON 15; max 8 positions; config migration v5).
  - **Adopting already-migrated coins** (we never saw their launch): `src/lib/pump-pda.ts` derives pump.fun's
    CANONICAL PumpSwap pool (seeds copied from @pump-fun/pump-swap-sdk 2.1 `pda.ts`; live self-check `pdaCheck` on
    every real migration event, shown in /api/swing) → `liveState.adoptPool` (creator `(adopted)`, `adopted`/`adoptedAt`
    in the live hash, ZSET scored by adoption time + `keepAlive`, seed reserves never block the first real trade) +
    `registry.adoptMigrated` (Token row, safety check). Ledger-based rug exits (dev/bundle/top-10) are neutral for
    adopted coins (their ledger only starts at adoption). All PumpSwap trades were already on the stream.
  - **Universe** (`src/scanner/swing-universe.ts`, `swing` config, every 60 s): your watchlist (`swing.watchlist`, mint
    addresses, Positions page "Swing coins" card, POST/DELETE `/api/swing/watchlist`), trending tabs coins that migrated
    (pump.fun complete / GeckoTerminal PumpSwap pools), DexScreener trending pump coins, our own grown coins
    (`leaders.ownTop`). DexScreener `/tokens/v1` (`dex.pairsFor`, ≤60/min) → MC, liquidity, volume, changes and the pair —
    must be the canonical pool (`pickPumpSwapPair`; a dominant non-canonical one only while `pdaCheck.match` is 0).
    Kept: migrated ≥60 min, MC $40k–$25M, liquidity ≥$10k, 24h vol ≥$100k; top 30 (+ watchlist) followed live;
    dropped coins let go after 90 min (`swing:adopted` set survives restarts). GeckoTerminal OHLCV 5m×288 in SOL
    (`currency=token`, ≤4 calls/min, every 20 min) → bounce-back power + 3-hour high.
  - **Decision** (`src/evaluator/swing.ts`, pure): `bounceBack` (dips ≥20% from a running high that won back ≥60% of
    the drop vs failed — ≥60% down or 6 h without recovery; score 0–1 `swingResilience`), `swingSetup` (live 15 s closes:
    12–45% off the recent/3-h high, a higher low that held ≥30 s, bounce 3–12% — not chasing — buy/sell ≥1.15 over 2 min,
    room back to the high), `swingDecision` (hard rules: safety, MC/liquidity/volume/age, ≥20 trades in 10 min, falling
    knife −40%/1h, fake volume, top-3 volume, KOLs dumping, top-10 holders via RPC getTokenLargestAccounts ≤55% (>40% half
    size, pool vault excluded), bounce-back ≥0.25 unless watchlist; score = 40 + resilience 25 + setup 15 (+ confirming
    dip-type TA strategies `swing.taStrategies`) + trend 10 + flow 10 + trending/KOL/proven bonuses; bar 70, watchlist −5,
    + coach + regime; score calibration per strategy). `src/executor/swing-trader.ts` checks live coins every 10 s (cheap
    setup scan first, RPC/DB only on a setup), stores BUY evaluations only (their real trade results feed calibration).
    Explanation `explainSwingBuy`. Launch-scorer learning (weight tuning, Bayesian odds, keywords) ignores SWING rows.
  - **Exits** (`exit.byStrategy.SWING`, layered by `exitRulesFor` everywhere: sell manager, virtual book, positions API):
    30% at 1.25x, 30% at 1.6x, 15% at 3x, trail + break-even floor from 1.25x (ladder 12→15→18→20%), peak hold 4 s, stop
    12–15%, no follow-through 60 min / stall 120 min, max hold 12 h (runner 24 h). **Hold longer** (`exit.holdLonger`,
    all strategies): profit banked + MC ≥$60k + chart uptrend + low risk → no max-hold / stale exit (≤48 h; trail still on).
  - **Re-entries** (`swingReentryReason`): 20 min after a win, 2 h after a loss, ≤4 a day per coin, 2 losses in a row →
    24 h pause, never after a rug. TA lab: bigger coins get phase `big` with SWING exits (Strategies page shows it).
  - **More trades**: **learning trades** (`explore` config): passes every rule, score ≤8 under the bar → ×0.5 size, ≤2
    open, ≤4/hour (entryContext.explore; excluded from the strategy cool-off and the trade coach; calibration learns from
    them). New-pair demand loosened a little (buyers 10, first-timers 6, net +1 SOL, buy/sell 1.2 SOL / 1.3 count, gap 20 s).
  - E2E (/var/lib/e2e/e2e-swing.ts): watchlist coin adopted (canonical pool verified) → bounce-back 0.9 → bought 27%
    under the high after the bounce → 1.25x tier + trail at 1.24x = +20.7%; DUD → −15.6% stop; re-entry cooldown works.
    e2e-explore.ts: score 81 vs bar 84 → learning buy.
- **v8 (Oct 10): stricter, faster swings, vamp guard, coach fix, Positions page redesign** (owner: "watch out for
  vamps — you make money on a coin then buy a vamp and lose it; 10% is good profit; be very strict with swing
  trading, more budget on higher MC, less on lower MC; sell faster on spikes; it says good exit when I closed it
  manually; very hard to see what I'm invested in"). Config migration v6.
  - **Vamp guard** (`src/evaluator/vamp-guard.ts`, `vamp` config): Redis HASH `vamp:orig` (normalised ticker /
    name → original mint, MC, why). Originals = every coin we buy (`trader.onEntered`, + a 3-day backfill at start)
    and bigger coins in the swing universe (MC ≥ $30k; the clearly bigger coin — ≥1.5× MC — wins a ticker).
    Candidates are matched by exact ticker/name AND after stripping vamp dressing (baby/mini/real/the/official/og…,
    …inu/ai/coin/token/classic/v2/2/3/cto/sol/x), ≥3 chars. A different mint → no buy: evaluator rule fail,
    swing trader skip, swing universe drop (same-ticker group → only the biggest), and `trader.vampCheck` as the
    last gate for every strategy (WARN event `vamp_blocked`). Expiry 7 days (MC ≥ $100k) / 3 days; pruned every 30 min.
  - **Swings stricter**: MC ≥ $50k, liquidity ≥ $25k, 24h vol ≥ $250k, ≥40 trades/10 min, pullback 15–35%, bounce
    3–8%, buy/sell ≥1.3, falling knife −30%/1h, downtrend on history (lower lows) blocked unless watchlist, bounce-back
    ≥0.45, top-10 ≤45% (half size >35%), bar 78 (watchlist −3); re-entry 30 min / 4 h after a loss, ≤3 a day, 2
    losses → 48 h pause; no learning trades on swings (`explore.strategies`, explore margin 5).
  - **Swings faster** (`exit.byStrategy.SWING`): 50% at 1.1x, 25% at 1.2x, 15% at 1.5x; trail + break-even floor from
    1.1x (ladder 6→7→9→12%), peak hold 2 s; **spike sell** (`exit.spikeSell`, off globally, on for SWING): ≥+8% within
    2 min (`spikeRisePct`: now vs lowest real trade in the window since entry) and ≥1.04x → sell 50% of what's left,
    once (SPIKE_MARKER −5), and it stands in for the next tier; stop 10–12% (`stopLoss.minPctByStrategy`); no
    follow-through 30 min, stall 45 min, max hold 4 h (runner 8 h), hold-longer cap 8 h.
  - **Size by MC** (`swing.sizeByMarketCap`): ×0.5 <$150k, ×0.8 <$500k, ×1 <$2M, ×1.3 <$10M, ×1.6 above;
    `trading.maxPositionMultipleByStrategy.SWING` 2.5 (cap 0.5 SOL at 0.2 base, still ≤6% of capital).
  - **Coach**: MANUAL exits → verdict `manual_exit` (never "good exit"): ≥2 (or 1 of ≤4) → trail ×0.8 (sell
    sooner), manual losses raise the bar; swing gave-back-profit from 1.1x; swings never loosen the trail on
    "sold too early". Dashboard label "You closed it".
  - **Positions page** (`dashboard/src/pages/Positions.tsx`, `components/PositionRow.tsx`): summary (open trades,
    SOL in trades, unrealised, banked) + tabs Invested now / Bigger coins (swing list + watchlist) / Waiting for a dip
    (remembered per device); every open trade is one compact row (multiple, P&L, MC in → now, size, age, a
    stop→next-target bar, learning badge) — tap for chart, exit plan, why it bought and Sell. Filter All / New
    coins / Bigger, sort newest / best / worst. API: `learning` flag on /api/positions.
  - E2E e2e-swing.ts: spike sale 50% at 1.06x, 25% at 1.2x, trail out 1.31x after 1.46x = +11.4%; DUD −12.3% stop;
    CLUDE / BABYCLUDE vamps refused.
- **v8.1 (Oct 10): "why no trades" + drought fixes** (owner: "it hasn't traded in 1 h"). `src/lib/entry-blockers.ts`
  counts per minute (last hour) why coins were skipped (evaluator + swing trader: first rule fail / score under bar)
  and why buy signals were refused (trader `refuse`) → `/api/system.trading` → Overview banner after 30 min without a
  buy + Scanner page "Bot health" → "Buying (last hour)" lists. Fixes: the `minPositionSol` floor now applies to every
  entry (stacked coach × conviction × regime × hour multipliers silently refused everything); learning trades pass
  the strategy cool-off; no buy for `explore.droughtMinutes` 45 → learning margin `droughtScoreMargin` 10 (all rules
  must still pass). Last entry time is read from the DB at start. FIRST thing to check when it doesn't trade.
- **v8.2 (Oct 10): DexScreener 5-minute hot list** (owner: "very good coins pop up in the past 5 minutes"). Poll every
  30 s (was 60), lists boosts top/latest + profiles + community-takeovers + ads (≤150 coins); `rankTrending(…, 'm5')`
  = ≥$2k 5-min volume, ≥20 trades, price rising, ≥50% buys; `mergeHot` appends 5-min-only coins (`hot5mRank`). A coin
  newly on either list → checkNow; points use the better rank. Scanner card tabs "Last 5 min / Last hour".
  Config migration v7. DexScreener's real trending ranking still isn't in the public API.
- **v8.3 (Oct 10): smoother VPS** (owner: "crashes a lot"; diagnose: 2 GB box, 324 MB free + 618 MB swap, Redis
  446 MB/1 GB noeviction, 48.6k tracked coins, public RPC socket 1006 every ~1 min). Dead launches (≥30 min, <10
  holders, not migrated/adopted, no trade 15 min, not held) are now `forget()`-ed every 5 min (`liveState.deadMints`)
  instead of sitting 26 h in memory + Redis. A socket that was up >30 s reconnects after 250 ms. diagnose.sh prints
  `docker stats` and no longer lists stats lines as errors. Note: every push redeploys → one restart each.
- **v8.4 (Oct 10): clean restarts + paper breaker** — Dockerfile CMD used `sh -c "… && node"`: sh (PID 1) swallowed
  SIGTERM → every update SIGKILLed after 20 s → "killed or crashed" + 15 restarts/24h. Now `exec node`. Owner: "remove
  the limit, get as much data as possible" → PAPER ignores the daily loss breaker AND the strategy cool-off
  (`exit.paperIgnoresLossLimits`, default true; WARN event still logged). LIVE: both always apply (re-check before Phase 4).
- **v8.5 (Oct 10): update button** — Overview "Updates" card (`dashboard/src/components/UpdateCard.tsx`): bot version vs
  newest on GitHub, app version vs `version.json` (written by dashboard.yml; sw.js never caches it), buttons Update bot
  now / Force rebuild / Reload app (clears caches + SW update). API GET/POST `/api/update` → Redis `update:request`
  (EX 600) → `scripts/auto-update.sh` now runs EVERY MINUTE (self-migrates the old */5 cron), checks GitHub every 5 min
  or at once on a request (`force` = `--force-recreate` without new code), writes `update:status` JSON.
- **v8.6 (Oct 10): rug guard v2** (owner: "still gets rugged WAY too much"; `src/executor/rug-watch.ts`,
  `antiRug.rugGuard`). Entry (rug-screen, every strategy, not adopted coins): **dump risk** = constant-product price
  drop if the top holder / top-3 sold everything (`dumpImpactPct`, curve vTok or pool base reserve) > 25% / 45% → no
  buy; **rugger memory** Redis ZSET `rug:wallets` (14 days): creator (counts 2) + top-20 holders + early buyers ≥2 →
  no buy. Exit (sell manager `rugGuard()`): top-15 holders snapshotted at the first check (`rug:holders:<positionId>`,
  3 days) — they sold ≥4% of supply, or one ≥2%-holder sold ≥60% → RUG_DETECTED; **sell cascade** (20 s: −20% from
  the high, sells ≥3× buys, ≥2 sellers, only ≤1.3x) → RUG_DETECTED. Every RUG_DETECTED records the dumpers + dev.
  **Launch-whale pump** (owner: "dev/someone buys A LOT at the start → spike → bunch of new wallets buy";
  `launchPump` / `launchPumpVerdict`, `rugGuard.launchPump`, crowd log must reach the launch): a wallet that bought
  ≥5% of supply in the first 30 s and still holds ≥5% → no buy; or it paid ≥30% of launch buys, spiked ≥1.8x, then
  ≥15 buyers in 3 min with ≥75% "fresh" (no record in `wpnl:n`) → no buy.
- **v8.7 (Oct 10): wallet analyzer (Solscan Pro v2)** — `src/lib/solscan.ts` (`/account/defi/activities`, swap types,
  header `token`; key `SOLSCAN_API_KEY` ONLY in the VPS .env; every call counted `solscan:calls:<day>`, cap
  `SOLSCAN_MAX_CALLS_PER_DAY` 200; owner has ~10M credits — be frugal, never poll) + `src/learner/wallet-report.ts`
  (pure `toSwaps` / `coinTrades` / `simulateCopy` / `analyzeSwaps`: trades/day, buy size, hold, first-sell speed,
  scaling out, win rate, PF, best/worst, copy sims 1 SOL @3/2%, 1 SOL @6/4%, 2 SOL @6/4% worse entry/exit + 2.5% costs
  → verdict). Cached 30 min (`wreport:<addr>:<pages>`). GET `/api/wallets/:address/report?pages=1–10&refresh=1`;
  Wallets page card "Analyze a wallet". Owner's wallet to study: 7BNaxx6KdUYrjACNQZ9He26NBFoFxujQMAfNLnArLGH5.
  The owner's Solscan plan REFUSES `/account/defi/activities` ("upgrade your api key level") → remembered 24 h
  (`solscan:noActivity`) and the report falls back to our RPC: getSignaturesForAddress + getTransactions (batches of
  50; one by one if the plan refuses batches) → `swapFromTx` (SOL/WSOL + single-token balance deltas of the wallet,
  any DEX; fee excluded). ~1 Helius credit per transaction.
- **v8.8 (Oct 10): loss autopsy** (owner: "still losing nonstop — scan what keeps going wrong and learn properly";
  `src/learner/loss-autopsy.ts`, `autopsy` config). Every 30 min: closed PAPER trades since the reset (`learningSince`,
  ISO date) ≤14 days → scoreboard (win rate vs the break-even win rate |L|/(W+|L|), PF), by strategy / exit reason,
  losers that never went ≥1.05x (bad entries) vs were ≥1.15x (gave back), and bands per strategy × MC / coin age / curve
  (or migrated) / score / UTC hour. A band with ≥15 trades, avg + 1SE < −3% and ≤ −0.1 SOL is BLOCKED in the trader
  (`trader.bandCheck` → refusal "this kind of trade keeps losing…"); 1 in 5 goes through as a min-size learning
  "probe" (entryContext.probe) so it can unblock. Redis `autopsy:last`; GET `/api/autopsy`, POST `/api/autopsy/run`;
  Performance page card "What keeps going wrong".
- **v8.9 (Oct 10): the bot tunes itself + KOL follow** (owner: "actively improve; trade more alongside coins many KOLs
  buy; only tell me the end result"). Autopsy `tuneStrategies` (recomputed every run, ≥15 trades): working (avg−SE >2%)
  → bar −3 / size ×1.2; losing with ≥55% never-up losers → bar +6 / ×0.7; losing otherwise → +3 / ×0.85; ≥35% of losers
  were up 15%+ → trail ×0.75. `autopsyTuneFor` is applied in the evaluator threshold + size, swing-trader barDelta +
  size, and sell-manager trailFactor (× coach). New autopsy band `kols` (entryContext.kols). **KOL follow** (`kol.follow`,
  strategy SMART_MONEY_COPY re-used, job `kolFollow`): whale-tracker KOL cluster (≥2) → `scheduleKolFollow` (0/30/90/180 s);
  KOLs still holding ≥2 required; bar −6 (2) / −10 (3+), size ×1 / ×1.3; own limit maxOpen 3; allocation now NEW 35 /
  SWING 25 / MIGRATION 15 / SOON 10 / KOL 15. **Labels fixed**: learning win = 1.4x before 0.85x (was 1.8x / 0.7x —
  the scorer was learning a target the bot never trades). Config migration v8.
- **v9 (Oct 10): AI coach** (owner: "learn from behaviours, not only statistics"; `src/learner/ai-coach.ts`, `aiCoach`
  config, `@anthropic-ai/sdk`). Key `ANTHROPIC_API_KEY` ONLY in the VPS .env (+ optional `AI_MODEL` default
  claude-sonnet-5-5 since Oct 14 (owner: "use Sonnet, better"; was Haiku; server-side fallback "default" on) + once every 24 h a DEEP review (`AI_DEEP_MODEL` default claude-sonnet-5-5, 2× trades, effort high, `ai:lastDeep`; "off" disables; POST body {deep:true}), `AI_DAILY_BUDGET_USD` default 0.5 (owner: cheap while testing), every 2 h, ≥8 new trades, 30 trades × 50 features, prices per model in `priceFor`). Hourly (≥5 new closed trades, budget
  left): beta messages + `fallbacks: "default"` (server-side-fallback-2026-07-01), effort medium, structured output (JSON
  schema) → ≤6 insights + ≤4 rules over the flattened entry features (`flattenFeatures`: market/crowd/manipulation/
  newPair/trending/kol/chart/swing numeric leaves + entry.score/kols/mcUsd/ageMin/hourUtc; invented feature names dropped).
  Rules (Redis HASH `ai:rules`): testing → backtest disagrees → retired; forward ≥8 new trades ≥5 pts better/worse
  (± SE) → live; stops holding → retired (`nextStatus`, refresh every 10 min, no AI call). Live rules in the evaluator
  (`aiRuleVerdict`, same feature shape as the stored evaluation): avoid → rule fail (1 in 5 probes), prefer → bar −4.
  Spend per day from real usage (`ai:spend:<day>`). GET `/api/ai-coach`, POST `/api/ai-coach/run`; Performance card "AI coach".
- **v9.1 (Oct 10): AI sees price action + what keeps going wrong** (owner: "recognise patterns, trends, the spikes it
  moves in, much better entrances"). `src/evaluator/price-shape.ts`: `priceShape` (10 min of 15 s candles before the buy:
  run1m/3m/10m, offHigh10m, fromLow10m, spikes10m/dumps10m (±15% candles), greenStreak, lastCandlePct, wickTopPct,
  volAccel, buyShare2m, rangePct10m) stored as `features.shape` on every evaluation (+ swing) and fed to AI rules
  (`shape.*`); `afterEntry` (pos:hist → min1m, max5m, min5m, peak, secToPeak = early / late / bought the top). AI input
  now includes the autopsy (`whatKeepsGoingWrong`) + `afterBuy` per trade, prompt focuses on entry timing. Autopsy gets
  bands `chase` (run3m) and `entry` (offHigh10m) → chasing / buying-the-top bands get blocked automatically.
- **v9.2 (Oct 10): migrated coins with real volume** (owner: "trade a lot more, especially migrated coins with lots of
  organic volume"). `src/scanner/migrated-scanner.ts` (`focus.migrated.scan`, every 15 s): every migrated coin that
  traded in 2 min (`crowd.activeAmmMints`) → `organicFlow` over 5 min (repeat-size bots, churners, dust <0.01 SOL
  removed) → `scanVerdict`: ≥20 real buyers, ≥5 SOL, buyers ≥55%, ≥60% organic, ≤+35% in 3 min, MC ≥$25k → checkNow
  MIGRATION_MOMENTUM with `rescan` (ignores the finished-schedule done key; once per coin per 5 min, ≤8 per tick, not
  held). Before this a migrated coin was only checked in its first hour. Allocation now NEW 30 / MIGRATION 25 / SWING 20 /
  KOL 15 / SOON 10, MIGRATION max 4 open, 10 positions total. Config migration v9.
- **v9.3 (Oct 10): staircase charts + autopsy blocks → small size** — `staircase()` (price-shape.ts, 1-min candles
  over 15 min: ≥6 one-way candles, ≥80% green, no red >3%, step CV ≤0.6, wicks ≤35%, +25%, AND top-3 wallets ≥50% of
  buys / ≤12 buyers / ≤15% sells) → rule fail in the evaluator + rug-screen refusal (all strategies), `shape.staircase`
  feature for the AI. Autopsy: a band covering ≥90% of a strategy's trades (e.g. "migrated" for MIGRATION) is never
  blocked (strategy tuning handles it); `autopsy.blockMode` 'small' (default) = losing kinds still trade at the minimum
  size as learning trades instead of being refused; tuning adds "badly losing" (avg+SE < −10%) → bar +10, size ×0.4.
- **v9.4 (Oct 10): RUNNER strategy + potential hold** (owner: "stop skipping coins that go 2–4× after we skip them, swing
  them more"; "it sells too early in the minus — hold longer if it sees potential"). New Prisma enum value RUNNER (all
  per-strategy maps, explain, dashboard labels, Controls). Runner scanner = `MigratedScanner` mode 'runner'
  (`crowd.activeCurveMints`, curve 15–92%, `runner.scan`: ≥25 real buyers, ≥4 SOL, buyers ≥58%, ≥60% organic, MC ≥$8k;
  once per coin per 4 min) → checkNow RUNNER `rescan`. Evaluator RUNNER: bar −20 (`runner.scoreThresholdDelta`), size
  ×0.8, flow re-checked (`runner flow faded`), curve coins only; stretched → dip watcher as usual. Exits
  `exit.byStrategy.RUNNER` (35% 1.3x, 25% 1.7x, 15% 3x, trail 14→18→20% from 1.3x, spike sell +25%/60 s), stop max 14%,
  time stop 4 / stall 6 / max hold 60 / stale 15 min. Allocation NEW 25 / MIG 25 / RUNNER 20 / SWING 15 / KOL 10 /
  SOON 5, RUNNER max 4, 12 positions (migration v10). **Potential hold** (`exit.potentialHold`): organic flow over 120 s
  (≥8 buyers, ≥60% buys, ≥1.5 SOL) and no rug signal → soft stop, early risk exit, stale and time stops wait (time
  stops ≤10 min longer); the hard limit always fires.
- **v9.5 (Oct 10): X check per coin** (owner: "check X communities and tweets"; `src/evaluator/x-check.ts`, `x.check`).
  Free: `parseXLink` (profile / post / community / none) + reuse of the same community / post id (`reuse:xc:` / `reuse:xp:`,
  recorded in social-analyzer `fetchAndStore`) and handle (`reuse:tw:`). Live (TWITTER_BEARER_TOKEN, only when every rule
  passes and the score is within 12 of the bar, cached 30 min `x:check:<mint>`, ≤300 reads/day `x:reads:<day>`): users/by/
  username, tweets/:id (+author), communities/:id (member_count — endpoint availability depends on the X plan), search/
  recent for the CONTRACT ADDRESS. `xVerdict` −8…+10 points (lowers/raises the bar), notes "X: …" in the buy
  explanation, `features.x` + AI section `x`. Untested against the live X API (sandbox can't reach it).
- **v9.6 (Oct 10): trade more** (owner: "it isn't trading enough"): `entry.minSafetyScore` 70 → 55 (soft insider flags
  burst 10 / transfer 10 / dev-slot sells 15 stacked busy coins under 70; hard fails still block, rug guard covers the
  rest); learning trades `explore` margin 8, maxOpen 4, maxPerHour 10. Config migration v11.
- **v9.7 (Oct 10): migrated coins a lot more** (owner: "≥$2k liquidity, ≥$25k MC, ≥9 SOL fees — trade A LOT more"):
  those three stay the migrated rules; `focus.migrated.scoreThresholdDelta` −15, `minActiveWallets5m` 15, migrated scan
  looser (≥12 real buyers, ≥3 SOL, buys ≥52%, ≥50% organic, every 3 min, 12 per tick); MIGRATION 30% / 6 open, 14
  positions; NEW 20 / MIG 30 / RUNNER 20 / SWING 15 / KOL 10 / SOON 5. Config migration v12.
- **v9.8 (Oct 10): running coins feeder** (owner: "check coins already running, not only super new ones";
  `src/scanner/running-coins.ts`, every 120 s + 30 s after start): pump coins on the trending lists (TrendingHub
  snapshot + DexScreener incl. 5-min hot, `dexId` now kept) that we don't follow → curve / unknown: `registry.want(mint)`
  (adopted from its next curve trade, 15 min); migrated (pump.fun complete / gecko pumpswap / dex `pumpswap`, or unknown
  with MC ≥$69k) with MC ≥$25k: `adoptMigrated` on the canonical pool (≤25 per run). Evaluator: late-joined coins
  (`view.adopted` or no creator) skip the fee / volume / holder minimums (our ledger only starts at the join).
- **v9.9 (Oct 10): bigger + more trades, then FREEZE** (owner: "raise the size, keep everything as it is, I won't
  update more, but more trades"): `trading.minPositionSol` 0.1 (0.05 lost ~6% to gas+tips per round trip),
  `entry.minCombinedScore` 65, explore maxOpen 6 / maxPerHour 20, runner scan ≥18 buyers / ≥3 SOL / buys ≥55%.
  Migration v13. Owner wants NO further changes for now — let it collect 200–300 trades, then tune from the autopsy.
- **v9.10 (Oct 10): "legit never trading" fix** — the rug guard v2 dump-risk check (v8.6) refused nearly every
  migrated / late-curve / runner coin: a fresh PumpSwap pool holds only ~20% of the supply, so ONE normal 3% holder
  "could dump it 25%". Now top-1 > 60% / top-3 > 80% impact (≈ a 10%+ / 25%+ holder on a fresh pool). Rugger memory
  counted early buyers (sniper bots are in every launch and get recorded as dumpers) → now only the top-10 holders,
  3 needed (dev still counts 2). Config migration v14. If it still doesn't trade: Scanner → Bot health → top refusals.
- **v9.11: health banner fixes** — "VPS runs older code than this site" was a false alarm: dashboard.yml only
  rebuilds on `dashboard/**` changes, so the site's SHA lags. Banner/panel now compare the bot to GitHub
  (`/api/update` last.remote). Restarts: every push redeploys (44 pushes ≈ 41 restarts) → crashes counted apart
  (`bot:crashes`, `crashes24h`); the banner warns on ≥3 crashes, not on restarts.
- **v9.12: best times to trade** (owner: "check which hours / days are best to trade, most motion"; `src/learner/timing.ts`,
  `timing` config). Every minute the stats timer records trades / PumpSwap trades / launches / migrations per UTC hour
  (Redis `timing:d:<date>`, 35 days; minutes with 0 trades = stream down, skipped). Every 15 min `buildProfile`: activity
  per hour (≥3 days) and weekday vs average + our closed PAPER trades (30 days) per hour / weekday (avg, win rate, edge
  shrunk n/(n+20), ≥8 trades). `timingNow()` → size ×0.75–1.25 (trader, × hour factor) and bar −3…+4 (evaluator +
  swing trader); never blocks. Autopsy band `day` (dowUtc), AI features `entry.dowUtc` + input `bestTimesUtc`.
  GET `/api/timing`; Performance card "Best times to trade" (hour bars in the viewer's time zone + result strip + days).
- **v9.13: add paper SOL without a reset** (owner: "if it runs out I can't fix it without resetting"). `paper.addedSol`
  (top-ups since the last reset; reset sets 0): balance = start + addedSol − buys + sells; POST `/api/controls/add-funds`
  {sol 0.01–1000} (`addPaperFunds`, event `paper_topup`); % / drawdown use start + added (a top-up is capital, not profit).
  Overview profit card ⋯ menu → "+ Add paper SOL…" (`components/AddFunds.tsx`).
- **v9.14: shadow trades + gRPC stream (off)** (owner: "speed up the learning"). `src/learner/shadow-trades.ts`
  (`shadow` config): pretend trades (VirtualBook, live exits + costs, no money) on coins it didn't buy — `refused`
  (trader said no), `near` (rules pass, score under the bar), `skipped` (a rule failed, score within 20 of the bar;
  only while the book is <80% full); once per coin + strategy per 30 min, ≤250 open, Redis `shadow:res` (3000).
  Refused + near (`wouldHaveTaken`) count at weight 0.5 in the loss autopsy bands + tuning (`shadowSource`,
  `shadowAsClosed`; headline numbers stay real), best-times results, and AI rule forward tests (+ skipped by an AI
  rule); AI input gets `shadowTrades` (skippedByRule = what each filter costs). GET `/api/shadow`; dashboard page
  **Shadow trades** (`pages/Shadow.tsx`, sidebar / phone More menu). **gRPC**: `src/scanner/grpc-listener.ts`
  (@triton-one/yellowstone-grpc 7.0.1, native, loaded on demand) — switch on with DATA_SOURCE=grpc + GRPC_ENDPOINT
  (https://…:443) + GRPC_TOKEN in the VPS .env; PumpPortal still gives launches; the free public stream is paused while
  gRPC is up and comes back after 10 s down. Owner plans Chainstack (Growth plan + $49 Yellowstone add-on).
- **v9.15: data feed from the dashboard** (owner bought Chainstack Growth, "add it for me, I'm in bed"). Controls page card
  "Data feed" (`components/DataFeed.tsx`) → PUT `/api/controls/feed` {tradesWsUrl (wss://), grpcEndpoint (https://…:443),
  grpcToken, useGrpc} → BotConfig row `_feed` (this server's DB only, never git; "_" rows are never served by the config
  API) → SIGTERM → Docker restarts → `effectiveFeed` (dashboard over .env) at start. GET shows masked values only
  (`maskUrl`); `redactUrl` now also hides path keys (Chainstack wss://host/<key>) and user:pass@. Without the Yellowstone
  add-on the paid Chainstack WebSocket is used by the normal logsSubscribe stream (check its request-unit usage).
- **v9.16: the bot changes HOW it enters + shows what it changed** (owner: "it sees the error but nothing changes").
  `src/learner/entry-style.ts`: from the autopsy pool (real + shadow trades it would have taken), per losing strategy
  (≥ autopsy.minTrades; cleared when avg−SE > +2%): `minOffHighPct` 6 when ≥50% of losers never went up; 3 / 10 when
  entries <3% / <10% under the 10-min high lose (avg+SE < −3, ≥ half minTrades) and the rest do ≥5 pts better;
  `maxRun3mPct` 100 / 50 / 20 (loosest that works) when chasing loses vs calmer entries. Evaluator: a BUY that breaks
  the style → DipWatcher (chart zone or `pullbackZone`) instead of buying now (CURVE_SNIPE under $15k: skip, owner's
  no-dip-wait rule); dip re-checks + learning trades are exempt. `src/lib/change-log.ts` (Redis `changes:log`, 200):
  autopsy tuning + entry-style diffs per run, AI rules going live / off, exit-lab switches. GET `/api/changes`;
  Performance card "What the bot changed" (current rules per strategy + change log).
- **v10 (Oct 11): the brain — self-improving learners** (owner: "upgrade the learning as much as possible so it actually
  thinks"; built by a multi-agent workflow, each module adversarially reviewed + fixed + re-verified). `src/learner/brain.ts`
  (`brain.enabled`, default on) runs three learners on ONE training set `learn-rows.ts` (closed PAPER trades since the reset
  ≤30 days, newest 5,000, + shadow trades; weights real 1 / learning 0.8 / shadow would-take 0.5 / skipped 0.3; rows younger
  than the strategy's max hold are embargoed so the newest slice isn't biased toward quick losers):
  - **Win model** (`win-model.ts`, Redis `model:win`, hourly): weighted L2 logistic regression on the flat entry features
    (≤60 by point-biserial, median/IQR scaling, missing flags, strategy intercepts), λ picked on an inner time split, ONE exam on
    the newest 25%; ACTIVE only if effective n ≥150, ≥15 effective winners, STRATIFIED (per-strategy) AUC ≥0.58 and ≥ the score's
    stratified AUC + 0.02. Evaluator: `threshold -= predict().points` (±10), note in the buy explanation, `features.winModel`.
    Async with yields (max stall ~30 ms), validated JSON restore.
  - **Rule search** (`policy-search.ts`, hourly from brain): single + paired feature thresholds per strategy and globally,
    Welch t with a fat-tail-safe p, BH-FDR q 0.1 over ALL tested candidates, holdout (newest 30%) must repeat the full action test,
    drop-best-trade robustness, dedup incl. complements → `aiCoach.addDiscoveredRules` (source 'search', status testing → the
    normal forward test before live; ≤6 open, known/retired ideas not re-added).
  - **Allocator** (`allocator.ts`, Redis `alloc:last`, 30 min): Normal-Inverse-Gamma posterior per strategy (prior −2%, 10
    trades, winsorised, 7-day half-life) → multiplier 0.5–1.6 from P(mean>0) + P(best); total shrinks when everything loses;
    effN <10 → ×1. Trader budget × `trader.allocFactor`.
  - AI coach memory: `ai:reviews` (its past reviews + results before/AFTER each) + `otherLearners` (brain.snapshot(true)) in
    the prompt. Change log gets model on/off, rules found, budget moves ≥0.1. GET `/api/brain`; dashboard page **Brain**.
- **v10.1: phone notifications** (owner: "notify me when a trade is in profit with the amount"). `src/lib/push.ts` (web-push
  3.6.7): VAPID keys made once and stored in BotConfig `_push` (DB only); subscriptions Redis `push:subs`, settings `push:settings`
  (default: profit closes ON, min 0 SOL; losses / take-profit tiers OFF); listens to bus 'trade' events → `messageFor` →
  `sendAll` (404/410 subs dropped). API GET `/api/push`, POST `/api/push/subscribe|unsubscribe|test`, PUT `/api/push/settings`.
  `dashboard/public/sw.js` handles push + notificationclick (opens `#/history`). Controls page card "Notifications" (iPhone:
  only in the home-screen app, iOS 16.4+).
- **v10.2 (Oct 11): credits, buy rules, tips to the brain** (owner: "Chainstack burns 1.8M requests/hour; let me change
  each strategy's buy limits; let me give the brain tips it acts on"). Credits: gRPC mode = paid gRPC for PumpSwap
  (migrated) only + free node for the curve, the paid WebSocket is never used; hybrid with a paid `tradesWsUrl` = paid
  node subscribes to PumpSwap only, curve on the free `TRADES_WS_URL`. **Buy rules** (`src/config/editable.ts` list of
  owner-editable paths with limits, `src/config/apply-edit.ts`): GET/PUT `/api/controls/rules` {key, value} → Controls
  card "Buy rules per strategy" (`components/BuyRules.tsx`, grouped: migrated / soon / new pairs / runners / swing+KOL /
  every coin / size & risk); every change → change log (source owner). **Tips** (`aiCoach.addTip`, Redis `ai:tips` ≤30):
  a tip forces a Haiku review (never deep); prompt section `ownerTips` + `editableSettings` + `allFeatureNames`; the AI
  returns `tipResponses` + `settingChanges` (applied via applyEdit) + rules with `tipId` (source 'owner' → LIVE at once,
  stay live until the tip is removed; DELETE retires them). Pending tips also force the hourly review. API GET/POST
  `/api/brain/tips`, DELETE `/api/brain/tips/:id`; Brain page card "Talk to the brain" (`components/BrainTips.tsx`).
- **v10.3 (Oct 11): timeframes** (owner: "add timeframes it can trade on or check — 5 s, 30 s, 1 min, 5 min, 1 h").
  `src/evaluator/timeframes.ts`: `candlesFromTrades` (exact candles from the crowd trade log, pool price `pp`, gaps
  filled) + `tfStats` (lastPct, prevPct, run3Pct, offHighPct, green, rsi, volAccel, buyShare) for s5/s15/s30/m1/m5/h1 →
  `features.tf.*` on every evaluation + swing buy (AI coach / rule search / win model / shadow trades see them; flatten
  section 'tf'). Owner limits `entry.timeframes.{maxLastCandlePct,maxRun3Pct,maxLastDropPct}.<tf>` (0 = off, default
  off) → rule fail in the evaluator and SKIP in the swing trader; editable on Controls → Buy rules → "Timeframes" and by
  brain tips. TA lab now tests every strategy on 15 s + 5 s + 1 min candles (`ta.timeframes`, ids `<id>@5s` / `<id>@1m`,
  `runStrategiesTf`, `labIds`, `taName`; proven ones work in the evaluator per timeframe; maxOpen 1500; ~0.26 s CPU per
  tick for 150 coins). Strategies page: timeframe filter chips.
- **v10.4 (Oct 11): exit timers editable + self-tuning** (owner: "the brain can't change stale exits; more concrete data;
  new rules on its own with minimal Claude credits"). Editable (Controls → Buy rules → "Exit timers — <strategy>", and via
  brain tips): `exit.timeStop.minutes/stallMinutes`, `exit.staleMinutes`, `exit.maxHoldMinutes` per strategy +
  `exit.timeStop.minPeakMultiple/maxMultiple`. **Exit tuner** (`src/learner/exit-tuner.ts`, `exitTuner` config, no AI):
  every 5 min, PAPER positions closed 30–55 min ago by a time-based exit (sell reason text → `timerOf`: no follow-through
  / stalled / no movement / max hold) → `afterExit` from the crowd trade log (max / min / end × exit price, 30 min) →
  Redis `exitafter:res` (2000). `judgeTimers` per strategy × timer (7 days): ≥12 exits, ≥40% ran +25% after → that timer
  ×1.25 (≤3× default); ≤15% ran and median end ≤0.95x → ×0.85 (≥0.5× default); ≤ once per 6 h, only exits since the last
  change count (`exitafter:chg:*`), via `applyEdit` source 'exit-tuner' → change log. AI input `exitsAfterSelling`;
  Brain snapshot `exitTimers` → Brain page card "Exit timers — what coins did after it sold".
- **v10.5 (Oct 11): owner's "big update" ported** (owner pushed `1474c87 big update` to `main`, built on the Oct 9 code
  81 commits back — a plain merge would have reverted v5…v10.4, so the NEW parts were rebuilt on the current bot;
  `main` itself is untouched and is NOT what the VPS runs). Ported: **price action** `src/evaluator/price-action.ts`
  (log-trend slope + R², extension above the trend line, defended support / resistance, setup BREAKOUT / PULLBACK /
  GRIND / EXTENDED / CHOP / DISTRIBUTION / BREAKDOWN, strength, manipulation; input = crowd log via `tapeFromCrowd`,
  `priceActionFor` cached 1.5 s per coin) → `features.pa.*` (evaluator + swing; AI section 'pa') + `entry.priceAction`
  rules in the evaluator (block BREAKDOWN / DISTRIBUTION, manipulation >0.6, <5 trades / <4 buyers in 60 s, >45% under
  the recent high for CURVE_SNIPE / RUNNER / SOON, room to resistance < 2× round-trip cost) + stretched (+40% in 60 s /
  30% over the trend line / EXTENDED) → DipWatcher (not under $15k new pairs, not learning trades). **Exits**
  (`exit.priceAction`, decideExit `chart` + `liquiditySol` inputs, live sell manager + virtual book): structure stop
  (peak ≥1.3x, close 3% under the last swing low > entry×0.9 → TRAILING_STOP "structure break"), momentum fade (≥1.25x,
  12% off the peak, buyers <45% + net selling → sell 50% once, FADE_MARKER −6, counts as banked), trail × 0.85–1.15 by
  chart strength, whale exit (one sell ≥15% of liquidity while 10% off the peak → RUG), dev with ≥2% of supply: any 2%+
  sell → RUG. **Tape archive** (`learner/tape-archiver.ts`, Prisma `TokenTape`, every 10 min, paper-traded coins of the
  last 6 h, −15 min…+45 min after the sell, ≤6,000 trades, 14 days) + **backtester** (`learner/backtester.ts`: replays
  each archived trade through VirtualBook with the live exits + every exit-lab variant on its real tape; GET
  `/api/backtest?days=1–14` cached 10 min; `npm run backtest`; Performance card "Backtest: other exits on the same
  trades"). v10.5.1: owner "trade more like before" → `entry.priceAction.enabled` false by default + migration v15 (exits stay on). All new rules editable (Controls → Buy rules → "Chart rules — buying / selling"; `.enabled` keys = on/off).
  Tests ported: tests/price-action.test.ts (+ tests/tape-helpers.ts trimmed), new price-action-exits / backtester tests.
  NOT ported (already in the bot in a newer form, or against the owner's rules): regime detector, Bayesian pattern
  beliefs, daily weight adjuster, outcome tracker, conviction sizing, 15/30/45 s re-checks (dip watcher does it), the
  40% hard stop / 30% trail / old time stop (owner's 10–20% band + v5 time stops), old scorer weights.
- **v10.6 (Oct 12): Overview timeframe** — `/api/overview?range=1h|6h|24h|7d|all` adds `window` (profit, wins/trades, win rate, avg %, best/worst, curve for that window); Overview chips (remembered per device).
- **v10.7 (Oct 12): 5-minute hold + thin-coin sizing** (owner CSV 341 trades: 19% wins, −7.8 SOL, 174 stop losses = −7.9 SOL, 46 past −20%; owner: "memecoins dip and bounce, hold ≥5 min unless brutally past the stop like a rug"). `exit.stopLoss.minHoldSec` 300 + `holdDisasterPct` 35: first 5 min the soft stop, hard limit, early risk cut, time stops and stale wait (via `inMinHold`); only −35% or a rug signal sells. Lab variant Q (ownerOnly) = no hold, so the strategy lab + backtester show what the hold costs/saves. Overshoot fix: `trading.maxPositionPctOfLiquidity` 3 (trader caps size to 3% of the coin's SOL liquidity; too thin for the minimum → refused). All editable (Controls → Trade size & risk). Old exit tests run with minHoldSec 0 (tests/legacy-exit.ts etc.).
- **v10.8 (Oct 12): learn from every coin + tree model** (owner: "improve the learning drastically, full approval").
  **Outcome tracker** (`src/learner/outcome-tracker.ts`, `outcomes` config): every coin the evaluator checks and doesn't
  buy (no shadow trade opened; once per coin + strategy per 20 min; ≤4,000 waiting) is replayed 45 min later on its real
  crowd-log trades through `backtester.replayTape` (VirtualBook + decideExit, paper costs; chart-reading exits off in the
  replay for CPU, ~8 ms each, ≤120 a minute); no trades after the check = dead coin = −round-trip cost. Redis
  `outcome:res` (6,000) → learn-rows source 'outcome' at weight 0.25 (allocator still ignores them: onlyTaken).
  **Tree model** (`src/learner/tree-model.ts`, pure TS): histogram gradient-boosted trees (≤32 quantile bins, learned
  missing direction, strategy 0/1 features, depth 3, lr 0.08, L2 3, min child weight 2, col sample 0.7 seeded, ≤250
  trees early-stopped on the newest part of TRAIN, ≤12,000 rows, ≤120 features, yields after every tree); same exam as the
  win model (newest 25%, stratified AUC ≥0.58 and ≥ score + 0.02, plus log-loss < base). `WinModel` trains both hourly
  (Redis `model:tree`); `predict` = average of both when both pass, else the one that passed (`using()`); evaluator also
  sizes ×0.7–1.3 by p − base rate when a model is on. Tests: tree-model (XOR interaction the logistic can't learn → tree
  AUC >0.8; 0/20 false activations on noise), outcome-tracker. Brain page: "Win-probability models" (both) + "Learning from
  every coin it checks" (`coinsChecked` in the brain snapshot).
- **v10.9 (Oct 12): cleaner phone layout** (owner: "make the app a lot cleaner, professional and organized, on mobile").
  Shared UI (`components/ui.tsx`): Card `subtitle`, smaller PageHeader, `Tabs` (segmented; `sticky` pins it under the
  phone header via CSS var `--hdr`) + `useTab(id…)` (remembered per device, `tab.<id>`), `Stack`, `Stat`, `Rows`/`Row`,
  skeleton Loading. `components/Icon.tsx` = one SVG line-icon set (no emoji in the chrome). Shell (`App.tsx`): nav grouped
  Trading / Results / Intelligence / System (sidebar sections), phone tab bar Overview / Positions / History / Performance /
  More, "More" = grouped bottom sheet + theme (Auto/Light/Dark) + log out; one-line footer. Long pages are tabbed:
  Performance (Results / Mistakes / Timing / Tests / AI), Controls (Trading / Rules / Alerts / Feed / System — the
  Update card moved here from Overview; a floating Save bar only shows with unsaved changes), Brain (Talk / Models / Rules /
  Budget / Changes), Scanner (Health / Market / Trending), Learning (Score / Coach / Signals / History), Wallets (KOLs /
  Smart money / Analyze / My wallets). Phone lists instead of wide tables (Strategies, Shadow, Brain budget); History
  filters fold away behind a button on phones. Cards no longer carry their own margins — pages space them with `Stack`.
- **v10.10 (Oct 12): big trades only on strong setups** (owner: "1 SOL only with good research and score >80, otherwise
  the lower cap — big weak trades ruin the PnL"). `trading.highConviction` {enabled, minScore 80, sizeSol 1,
  maxPctOfCapital 12, minMarketCapUsd 50k}: `isHighConviction` (trader.ts) = score ≥ 80, MC ≥ $50k, not learning / probe /
  risky half-size, allocator ×≥1 → size up to 1 SOL (≤12% of capital, still ≤ strategy budget, balance, 3% of liquidity).
  Other trades keep the normal caps (owner: 0.3 conviction / 0.5 swing is fine). Editable on
  Controls → Rules → Trade size & risk. Test tests/high-conviction.test.ts.
- **v10.11 (Oct 12): faster rug exits** (owner: "obvious rugs are the main issue"; they rode the 5-min hold to −35%).
  `sellCascade` (rug-watch.ts) now has 3 shapes, all RUG_DETECTED before the min hold (≤1.3x): cascade (unchanged), **solo**
  (`cascade.soloDropPct` 25: ONE wallet, ≥25% in 20 s, sells ≥3× buys — the old ≥2-sellers rule missed single-wallet dev
  rugs), **crash** (`crashWindowSec` 90, `crashDropPct` 30, `crashSellBuyRatio` 2 — rugs sold in slices). Editable
  (Trade size & risk). Tests in rug-guard.test.ts.
- **v10.12 (Oct 13): free-feed watchdog** (owner: "no coins checked for hours"; Chainstack credits fine; paid gRPC
  fallback for the curve REJECTED — could burn millions of credits/day). `watchFreeFeed` (index.ts): a FREE trade stream
  (grpc mode: the curve feed; hybrid: the curve / main feed when it's the free URL) silent for 2 min → fresh socket
  (`PumpFunListener.restart`), after 3 failed restarts → `TRADES_WS_URL_BACKUP` (optional .env, free node) and back.
  WARN event `feed_restart`. Paid streams untouched.
- **v10.13 (Oct 13): no big chases on weak scores** (owner: "1.6 SOL on a 50 score, chasing a candle, top-blasted").
  `trading.highConviction.normalMaxSol` 0.5 (any non-strong-setup trade, whatever maxPositionSol × conviction says) +
  `lowScore` 65 / `lowScoreMaxSol` 0.25 (trader.ts `weakCap`). `entry.priceAction.dipWait.enabled` (default on): the
  stretched → DipWatcher wait (+40%/60 s, 30% over the trend line, EXTENDED) works even with the price-action BUY rules
  off (never blocks, only waits; not CURVE_SNIPE <$15k, not learning trades). All editable (Trade size & risk).
- **v10.14 (Oct 13): blow-off guard on dip entries** (owner: "a coin scalps hard, dips, the bot thinks that's the entry
  but it's the ATH and it dumps"). `chart.dip.blowOff` {runPct 100, minDipPct 35, holdSec 45, dropRunPct 500}: DipWatcher
  measures the run from the 15-min low (crowd log) to the high; run ≥ +100% → the dip must be ≥35% off the high AND the low
  must hold 45 s (`lowestAt`); run ≥ +500% → stop waiting (blow-off top). Editable (Trade size & risk). tests/dip-blowoff.test.ts.
- **v10.15 (Oct 13): fresh stats without deleting anything** (owner: "reset the PnL, not the trades or data, start from
  15 SOL"). `paper.statsSince` (ISO) + `paper.balanceOffsetSol`: `resetPaperStats(startSol)` (api/paper-reset.ts) sets start
  = startSol, addedSol 0, offset = net SOL spent so far → balance = startSol now; Overview / Performance `closedTrades` and
  today's PnL count only trades closed after statsSince. Learners keep the full history (they use paper:resetAt). Applied
  ONCE via oneTimeUpgrade `stats-reset-oct13` (15 SOL). A full paper reset clears both fields.
- **v10.16 (Oct 13): more trades to learn from** (owner screenshot: 4,793 checked, 9 buy signals, 2 bought — the stream is
  fine). Dip-wait-only mode no longer delays on the broad EXTENDED label (only +40%/60 s or 30% over the trend line);
  learning trades `explore.scoreMargin` 8 → 12 (migration v16; all rules still pass, half size). Holder minimums
  (CURVE_SNIPE 15) are the top skip but are early checkpoints on dying launches — kept.
- **v10.17 (Oct 13): moonshot TEST mode** (owner: "mega real volume on a migrated coin + narrative + KOLs → enter early,
  moon it, clip along the way"; agreed: test first). `src/learner/moonshot.ts` (`moonshot` config, live false): every 15 s
  over `crowd.activeAmmMints` → `organicFlow` (≥40 real buyers, ≥20 SOL in 5 min, buys ≥60%, ≥65% organic, ≤+60%/3 min,
  MC ≥$30k) + `kolActivity` (≥2 KOLs bought and not sold) + trending (TrendingHub lists or DexScreener) → `moonshotVerdict`;
  a hit (once per coin per 60 min) opens TWO VirtualBook pretend trades: M = `moonshotRules` (20% at 1.5x / 20% 2x / 15% 3x /
  15% 5x, no initials, trail 25→30→28→25% from 1.5x, max hold 8 h) vs L = live MIGRATION exits. Redis `moon:res`; GET
  `/api/moonshot`; Performance → Tests card "Moonshot test"; thresholds editable (Controls → Rules → Moonshot). Real trades
  NOT built yet — when results prove it, add a live path (trader entry with the moonshot exits) behind `moonshot.live`.
- **v10.18 (Oct 13): bundle guard** (owner: "top holders all held 0.5%, wallets made the same day 5 months ago, bought
  the exact same — an incredibly big bundle"; then "tiny bundlers are okay — loosen it a little" → migration v17;
  `antiRug.rugGuard.bundle`, rug-watch `sameSizeGroup` / `sameDayGroup` / `holderBundleVerdict`, rug-screen `bundleCheck`,
  every strategy, right before a buy). Only groups holding ≥5% of the supply together (`minGroupPct`) count: ≥10 of the
  30 biggest holders (≥0.3% each, dev excluded) within 5% of the same size; or ≥6 of the 15 biggest holders' wallets
  (≥2 days old) created within 24 h; or ≥4 same-size wallets sharing a birthday. Wallet birth = first
  transaction (`FunderInfo.firstSec`, funding-graph cache 24 h; missing ones over RPC, ≤2.5 s wait, then cache only).
  Late-joined / adopted coins: RPC top-20 accounts (`src/lib/holders-rpc.ts`, also used by swing top-10), same-size
  only, cached 60 s. Editable (Every coin → Bundle guard). Test tests/bundle-guard.test.ts.
- **v10.19 (Oct 14): honest learning** (owner pasted an outside review of a 495-trade CSV: stop loss 193 trades −9.8 SOL,
  rug detected 187 −3.9 SOL, trailing +2.4, every strategy negative; "score 70–80 beat 80–100"). Migration v18.
  - **Weight adjuster** (`daily-adjuster.ts` + `weight-tuning.holdoutCheck` options): needs 300 clean labels with 40+
    wins and losses; tested on the newest 300 it never trained on (20+ of each — a thin holdout now KEEPS the current
    weights instead of accepting blindly); must beat the old AUC by `minAucGain` 0.005; no strategy with 8+ held-out
    wins and losses may drop > 0.02 AUC; with 20+ real trades in the holdout the new weights' better-scored half must
    earn ≥ the old one's after costs. Rejections say why on the Learning page.
  - **Pattern odds** (`bayesian-updater.ts`): every outcome also counts per strategy (`strategyPattern` "SOON · …");
    the evaluator uses a strategy's own odds once it has 3× `oddsMinSamples`. Own buys teach with their REAL P&L
    after fees (weight `ownBuyWeight`); a buy still open at the 1-hour label waits and teaches when it closes
    (`onTradeClosed`). Watched coins keep the 1.4x-before-0.85x label (the first TP before the stop), not "doubled".
  - **Loss-exit review** (`exit-tuner.ts` `lossExitKind` / `judgeLossExits`, `exitTuner.lossExits`, Redis
    `exitafter:loss`): every STOP_LOSS / RUG_DETECTED exit followed 30 min — backAbovePct (came back above entry +5% =
    false alarm / sold the bottom), diedPct (ended ≤0.6× = good exit), stop overshoot (pts past the stop = late exit or
    bad fill). ≥15 of a kind → verdict good / false_alarm / late / mixed. Chart rug exits (cascade dropPct, soloDropPct,
    crashDropPct) re-tuned by the tuner: false alarms +5 pts, always right −2 (ranges 15–35 / 20–40 / 25–45, ≤ once per
    6 h). Brain page card "Stop-loss & rug exits", AI input `lossExitsAfter`.
  - **Strategy cards** (`loss-autopsy.strategyCards`): per strategy (real trades, % after fees) avg / median / without
    its 3 best / newest 30% / never-up vs gave-back losers → profitable (30+ trades, avg−SE>0, positive without top 3
    and recently) / losing (avg+SE<0) / unproven; `scoreInversions` flags a higher score band doing worse. Shown in
    Performance → Mistakes ("Does each strategy deserve to run?") + autopsy findings. Tests: tests/honest-learning.test.ts.
- **v10.20 (Oct 14): 0 buy signals** (owner: 2,618 checked, 0 signals; top skips holders / curve / "MIGRATION: safety < 55"
  237 / "CURVE_SNIPE: no X link" 87 — the owner had switched ON Controls → "Only coins with an X link", `entry.requireTwitter`,
  default off). `focus.migrated.minSafetyScore` 40 (`strategyMinimums().minSafetyScore`, editable "Min safety score
  (migrated coins)"): soft insider flags stack under 55 on any busy graduated coin; hard fails + rug / bundle guard unchanged.
  X links (owner: "often it's an X page / group / account"): `social-analyzer.xLinkOf` finds the X link in the X field, the
  website / Telegram field or the description (+ bare "@handle"); account, post (incl. x.com/i/status, /i/web/status) or
  community all count (`hasXLink` → "no X link" rule, socials score, reuse, X check). tests/x-links.test.ts.
- **v10.21 (Oct 14): focus cut from the owner's CSV** (515 trades Oct 9–14, −10.3 SOL; avg/trade −10.8% Oct 10 → −4.1% since
  the 5-min hold; 228 trades died in <60 s = −7.3 SOL, 70% of losses, most never up 2%; 69% of losers never went 1.05x; since
  Oct 12 SOON −1.8% / MIGRATION −2.9% / KOL −3.5% vs RUNNER −10.7% / SWING −10% / CURVE_SNIPE −12%; 00–04 UTC 9% winners;
  only 11% reached 1.4x, 26% reached 1.2x; score doesn't predict). Owner approved all 4 → migration v19: RUNNER / SWING /
  CURVE_SNIPE OFF, allocation MIGRATION 0.45 / SOON 0.35 / KOL 0.2, SOON max 4 open; `entry.confirmDelaySec` 25 +
  `entry.confirm` {maxDropPct 4, maxPumpPct 15, minBuyRatio 1.1} (price must hold); `trading.quietHours` {0–4 UTC}
  (trader `inQuietHours`, refusals → shadow trades); `exit.byStrategy.SOON / MIGRATION_MOMENTUM.takeProfitTiers` 30% at
  1.2x, 30% at 1.4x, 15% at 5x. All editable (Controls → Rules). Then FREEZE 5–7 days and judge. tests/focus-cut.test.ts.
- **v10.22 (Oct 14): re-buys** (owner: banner "already traded this token" on migrated re-signals; "rebuy if it looks good
  for a rebound"). `trader.reentryVerdict` (pure; SOON / MIGRATION_MOMENTUM only, SWING keeps swingReentryReason, others
  never): profit → once more (`focus.swing.maxReentries` 1) when the scanner re-signals it ≥ `profitCooldownMin` 30 later
  (`reentryOnRescan`) or on a swing-watcher setup ≥ cooldownSec; loss → only a swing-watcher rebound setup (swingSignal)
  ≥ `reboundAfterLoss.cooldownMin` 60 later, as a minimum-size learning trade (probe path, entryContext.explore); rug /
  open position → never. Swing watcher now also watches losing exits (cool-down 60 min) when reboundAfterLoss is on.
  Editable (Migrated coins). tests/reentry.test.ts.
- **v10.23 (Oct 15): more trades** (owner: "5 trades in 6 hours is way too little"). Migration v20: `trading.quietHours`
  off, `entry.confirmDelaySec` 15 + `confirm.maxDropPct` 6, RUNNER back on but small (`runner.sizeMultiplier` 0.5 → the
  minimum size, allocation 0.1, max 2 open); allocation MIGRATION 0.4 / SOON 0.3 / KOL 0.2 / RUNNER 0.1.
- **v10.24 (Oct 15): dip-only above $15k MC** (owner: "buy dip only if it's above 15k MC, under 15k you're allowed to top
  blast"). `chart.dip.dipOnly` {enabled, minPullbackPct 15}: every BUY (incl. learning trades) on a coin with MC ≥
  `chart.dip.noWaitBelowMcUsd` (15k) → DipWatcher with `pullbackZone(recent high, 15)` (15–35% off the high) + bounce, no dip in
  `waitMinutes` → no buy. Under $15k / MC unknown → bought straight away. Exempt: dip re-checks, swing-watcher re-entries.
  `dipOnlyApplies` / `dipOnlyHigh` (dip-watcher.ts). Editable (Trade size & risk). tests/dip-only.test.ts.
  **Unless crazy volume** (owner): `dipOnly.hotVolume` {minBuyers 40, minBuySol 20, minBuySharePct 60, minOrganicPct 60} on
  the 5-min `organicFlow` → bought straight away (`hotVolume`). **PnL reset again** (oneTimeUpgrade `stats-reset-oct15`, 15
  SOL, nothing deleted) + **daily P&L calendar**: GET `/api/pnl-calendar?tz=<getTimezoneOffset>` (`dailyCalendar` in
  performance-calc.ts, whole history, by close day in the viewer's zone) → Overview card "Daily profit"
  (`components/PnlCalendar.tsx`: month grid, green/red days, per-strategy split). The calendar lives INSIDE the Overview profit
  card behind a "Calendar" button (open state remembered, `overview.calendar`); tapping a day → `/api/overview?day=YYYY-MM-DD&tz=`
  (`tradesOnDay`, whole history) so the profit numbers + chart show that day; "back to <range>" or a range tab clears it.
  useApi drops answers for a path that's no longer current (fast taps).
- **v10.25 (Oct 15): owner's wallets + copy with instant mirror sells** (owner: "I need trades, the bot needs to read them
  better; if these wallets buy something it's often good, especially the last 8; you're allowed to copy trade 4vw54…; if
  you're in a trade with him and he sells, sell instantly"). `config/kol-wallets.ts` `OWNER_PICKS` (14 Solana KOL wallets,
  5 "top" = weight 1.5; the owner's 0x… EVM addresses can't be tracked — left out) + `OWNER_COPY_WALLETS` (4vw54…, kind COPY),
  seeded once (`seedOwnerWallets`, marker `_ownerWallets1`; existing rows switched on + raised). **Trusted** wallets
  (weight ≥ `kol.trustedMinWeight` 1.5) count as two KOLs (`effectiveKols`) → one top-pick buy starts a KOL-follow check;
  `features.kol.trusted` for the learners. COPY wallets' trades also count in the KOL signal. **Copy trades** (migration
  v21): bar +0, size ×1, max 2, no min hold; `copy.skipDipWait` / `skipConfirm` → bought when he buys. **Mirror sell**
  (`copy.mirrorSells`): a COPY wallet's sell → Redis `copy:mirror:<mint>` {wallet,name,t} (set before anything else) +
  `whales.onCopySold` → `sellManager.onTrade(mint)`; decideExit `mirrorSell` (`mirrorSellReason`: only sells after our buy)
  → COPY_EXIT 100% for ANY position in that coin, first check after "no market", ignores every hold. tests/owner-wallets.test.ts.
- **v10.26: owner's brain commands ignore the daily AI budget** (owner: "allow the brain commands to go regardless, tips etc,
  even if it's over the daily budget"). `aiCoach.review(force, deep, forTips, ownerAsked)`: over budget only the AUTOMATIC
  reviews stop; tips (`reviewTips`) and the dashboard Run / deep buttons (`/api/ai-coach/run` → ownerAsked) always go; a pending
  tip turns an over-budget automatic review into a tip review. tests/ai-budget-owner.test.ts.
- **v10.27 (Oct 15): the owner's terminal filters gate EVERY buy** (owner: "ONLY buy coins with these things, not below —
  they'd be a rug; find better entries, know whether buyers or sellers are getting high, decent narrative; top holders a bit
  high is okay if a lot of KOLs are buying at good entries"). `src/evaluator/owner-filters.ts` + config `ownerFilters`:
  `ownerProfile` (migrated = complete/onAmm; curve ≤ newPair.maxAgeMin → new pair; else soon) → `ownerFilterFails`:
  migrated MC ≥$25k / ≥50 holders / liq ≥$2k / ≥9 SOL fees; soon ≤70 min / vol ≥$12k / MC ≥$12k / ≥1 SOL fees; new pair
  ≤1.5 min / vol ≥$200 / MC ≤$100k / ≥2 holders / no Mayhem / no "test"/"fuck" (whole words, the terminal's "test, fuck"
  string split); late-joined coins skip holders/fees/volume (partial ledger). Ages: the terminal key says "seconds" but
  70 / 1.5 read as MINUTES (1.5 s impossible) — editable. `minNarrative` 0.35 (narrative 0–1, 0.5 neutral; unknown passes).
  Rule fails in the evaluator for every strategy (after the fee re-estimate), incl. KOL follow / copies / runners /
  learning trades. **Pressure** (`entry.pressure`): `flowPressure` (buyers' SOL share last 30 s vs the 60 s before, dust
  ignored) → sellers > 55% with ≥4 trades → "sellers in control" rule fail (copies exempt); `features.pressure` + AI section.
  **KOL relax** (`kol.concentrationRelax` minKols 3, trusted count double): only soft concentration fails within the
  riskyEntry caps → allowed at full size (note in the buy explanation). Migration v22: CURVE_SNIPE back on (0.15), MIG 0.35 /
  SOON 0.25 / RUNNER 0.05 / KOL 0.2; newPair.maxAgeSec 90; soon MC + volume $12k. Editable group "Your filters".
  trade.padre's X feed: no public API (would mean scraping with the owner's login) — not built. tests/owner-filters.test.ts.
- **v10.28 (Oct 15): real fees + KOLs never blind** (owner's terminal: BUY 0.0001 prio + 0.001 tip, SELL 0.001 + 0.005, 20%
  slippage tolerance; "don't blindly copy KOLs!"). `paper.txFeeSol` = per SELL 0.006 (was 0.0015 for both), new
  `paper.buyTxFeeSol` 0.0011 (paper-trader buy fill, virtual-book cost, `exitCostPctFor`). 20% is a tolerance, not a cost —
  strategy maxSlippageBps guards stay. **Fee-aware take-profits** (`exit.minSaleFeeMultiple` 8, decideExit `feeAware`): a
  tier slice must be worth ≥ 8 sell fees (0.048 SOL) else it sells more; a leftover worth less than that goes with it.
  KOL follow: no bar discount / no bigger size (barDelta 0, size ×1) — KOLs only TRIGGER a check. Copies: `copy.skipDipWait`
  / `skipConfirm` false → dip-only, confirmation and the pressure check apply to copies too (mirror sells unchanged).
  Migration v23. phase2 initials test now uses sizes 0.1–0.5 SOL (0.025 can't pay 0.006 fees).
- **v10.29: non-SOL curves + transfer-fee coins** (from Chainstack's pumpfun-bonkfun-bot protocol notes). pump.fun now pairs
  coins with USDC / other tokens: `decodeCreate` reads is_mayhem_mode / is_cashback_enabled / quote_mint; `isSolQuote`
  (all-zeros or WSOL = SOL) — token-registry `onCreate` does NOT follow non-SOL coins (their amounts aren't lamports →
  price/MC/fills would be wrong; `stats.nonSolSkipped`). "Reward" coins (Token-2022 transfer fee 1–3% on every buy AND sell):
  safety-checker reads the real bps (`getTransferFeeConfig`) → `transfer_fee` HARD fail when > 0; a 0% fee extension is no
  longer penalised. tests/quote-and-fees.test.ts. Zip reviews (Oct 15): solana-trading-bot-v3 + solana-copy-sniper-mev-bot =
  key-stealing malware (fake npm registry / install-script package) — never use; OctoBot + Chainstack's bot = legit.
- **v10.30: three OctoBot ideas** (owner approved). (1) **Two-step buys** (`src/executor/scale-in.ts`, `trading.scaleIn`
  {firstPct 50, minWaitSec 20, windowSec 180, minRisePct 2, maxRisePct 30, cancelDropPct 6, minBuySharePct 55}): trader buys
  `scaleInPlan` firstSol (whole size when a leg < minPositionSol or learning/probe) → entryContext.scaleIn {plannedSol,
  pendingSol, status pending}; sell manager `manage()` asks `scaleInVerdict` every check (danger = mirror sell / insider /
  holder dump / cascade; any sale = too late) → `sellManager.scaleIn` → `trader.scaleInLeg` (add: second BUY trade, new
  average entry, size, tokens, buyFeeSol; status added/cancelled + why). (2) **Market mood** (`src/learner/market-mood.ts`,
  DATA ONLY): SOL/USD sampled every 5 min (Redis `mood:sol`, 26 h) → `solChange1h/4h/24hPct`, Fear & Greed (alternative.me,
  hourly, `mood:fng`) → `features.mood` + AI section 'mood'. (3) **dip_analyser** TA strategy (RSI < 35 in 2 min + Klinger
  oscillator `klinger()` crossing its signal on a green candle) in the TA lab (proven only via the usual lab rules).
  tests/octobot-ideas.test.ts.
- **v10.31: 0 buy signals again** (owner's Bot health: 1,568 checked / 0 signals in an hour; top skips CURVE_SNIPE holders < 15
  ×240, MIGRATION "age outside entry window" ×146, SOON holders < 50 ×99, SOON safety < 55 ×53). Holder minimums now come
  from config when set (`strategyMinimums().minHolders`, else the strategy's number): `focus.newPair.minHolders` 8 (coins
  ≤ 90 s old rarely have 15; the demand rules need ≥ 10 real buyers anyway), `focus.soon.minHolders` 35 +
  `focus.soon.minSafetyScore` 45; MIGRATION_MOMENTUM entry window 24 h → 7 days (old trending coins; owner's migrated
  filter has no age limit). Editable ("Your filters"). The owner's filter gate itself is unchanged.
  Then (Bot health: MIGRATION "dev sold X% of their bag" ×85): on a MIGRATED coin a dev who fully sold out (holds < 1%)
  no longer fails `maxDevSoldFraction` (normal after graduation; can't dump on us). Curve coins / devs still holding: unchanged.
  diagnose.sh now prints Redis keys per prefix + biggest keys (Redis was 691 MB of its 1 GB noeviction cap, 3 crashes/24 h).
- **v10.32: Redis diet** (owner's diagnose: Redis 660 MB / 1 GB, RAM 107 MB free + 1.7 GB swap, lag 541 ms; 66k `bull:*`
  keys). Every launch (25–40k/day) parked 3 long delayed observation jobs (H1/H6/H24) for ~24 h. Now `scheduleFor` queues
  only CREATION/M1/M5/M15; `nextChained` schedules M15→H1→H6→H24 one at a time and only while `stillAlive` (graduated, or
  traded in the last 10 min with ≥ 10 holders). One-time `obs-chain-cleanup` removes the parked H1/H6/H24 jobs in the
  background (`removeParkedSnapshotJobs`, pages of 500). tests/snapshot-chain.test.ts. Next if still tight: 4 GB VPS.
- **v10.33: per-strategy funnel** (owner: "lack of trades, I don't know if any strats are being implemented").
  `entry-blockers.ts` `noteEvaluation` / `noteStage`: per strategy, last hour — checked → rulesOk → signal (score over the
  bar) → dipWait / confirming / notConfirmed / heldBack / toTrader → refused / bought (+ dipGaveUp from the dip watcher).
  `blockerSnapshot(now, enabledStrategies)` → `/api/system.trading.strategies` (switched-on strategies with no activity
  listed with zeros) → Scanner → Bot health "Strategies" list with a one-word verdict each. Migration v24:
  `focus.migrated.minActiveWallets5m` 15 → 12 (= the migrated scanner's ≥12 real buyers; 12–14 were sent then bounced).
- **v10.34: dip waits that never filled** (owner's funnel: Migration 79→2→2→0, KOL 17→3→2→0, Runner 11→1→1→0 — every
  signal went to the dip-only wait and none filled in the hour; New pair 132→0 / Soon 93→0 fail rules). Migration v25:
  `chart.dip.dipOnly.minPullbackPct` 15 → 10, `chart.dip.waitMinutes` 10 → 15, `dipOnly.hotVolume` 30 buyers / 12 SOL (was
  40 / 20). Funnel rows now carry each strategy's own top 3 skip reasons (`topSkips`); summary mentions waiting signals.
- **v10.35: terminal filters are the main gate** (owner: "lower the bot's older rules by a lot, the main focus = the
  terminal filters"). Migration v26 (owner filters, rug guard v2, bundle guard, vamp guard, staircase, pressure, safety
  HARD fails all unchanged): entry safety 55→45, score bar 65→55, dev ≤12%, bundlers ≤25%, top-10 ≤60%, one wallet ≤12%
  (half-size caps 35/70/18), liquidity ≥1.5 SOL (was 5), confirmation 8 s (was 15), new `entry.minHoldersByStrategy`
  {RUNNER 15, SMART_MONEY_COPY 5}; new pairs: age 30–90 s, ≥5 holders, ≥3 curve SOL, MC $2.5k–$100k, fees 0.05, vol $200,
  top-10 ≤40%, ≥70% of high, demand 7 buyers / 4 new / +0.5 SOL / ratio 1.1 / no acceleration rule / CV 0.3 / same size 35%
  / median 0.03 / gap 30 s / bots 50%, near high 12%, run30s 50%; SOON curve 50–95%, fees 1, active wallets 10, holders 20,
  safety 40; migrated active wallets 8, BOOST wait 180 s (was 330). Logic tests pin the old limits (LEGACY_ENTRY).
- **v10.36: new pairs at the minimum size + dip analyser LIVE** (owner). `trading.minSizeStrategies` ['CURVE_SNIPE'] (trader caps
  size at `minPositionSol`). `ta.forceLive` ['dip_analyser'] → `withForcedLive` (ta-lab.ts): every timeframe live with
  `forceLiveEdgePct` 10 (= full 3 points), `forced: true`, off once the lab proves it LOSES (≥ minTrades, mean + 2 SE < random).
  Lab triggers an evaluation when it fires; `ta.dipEntrySignals`: a fire on a coin the DipWatcher waits on → `onDipSignal` →
  dip entry (`dipSignalOk`: ≥ `chart.dip.signalMinOffHighPct` 5% under the high, not broken down, not a blow-off). Strategies
  page badge "live (your choice)". Migration v27. tests/dip-analyser-live.test.ts.
- **v10.37: switched-on strategies always have a budget** (owner's funnel: Swing 34 signals → 34 refused "size below minimum";
  the owner had switched SWING on, allocation still 0). `trading.minAllocationWhenOn` 0.05 (`allocationShare`), allocation
  SWING 0.1 / SMART_MONEY_COPY 0.1 (was 0.2; no KOL signals passed). Migration v28. Note: Migration's top skip "only X% to
  resistance" = `entry.priceAction.enabled` is ON on the VPS (owner or a brain tip) — left as is, owner told.
- **v10.38: lab-triggered evaluations capped** (owner: "the app loads very slow" after v10.35–v10.37; the API runs in the bot
  process, so a busy event loop slows the dashboard). `ta.maxTriggerChecksPerMin` 12 (TaLab `checkBudget`): the forced-live
  dip analyser could ask for a full evaluation on many of the 150 lab coins every 15 s. Ask for diagnose.sh if still slow.
- **v10.39: honest-review cleanup, then FREEZE** (owner asked for an honest answer; agreed the v10.35 loosening and the forced
  dip analyser were mistakes and the bar had too many nudgers). Migration v29: every v10.35 value back to v25 (score bar 65,
  safety 55, top-10 50 / bundles 18 / one wallet 10 / dev 10, liquidity 5 SOL, confirmation 15 s, new pairs 45–90 s / 8 SOL /
  $3.5k–$15k + the old demand rules, SOON 70–90% / 25 wallets / 35 holders / safety 45, migrated 12 wallets / BOOST 330 s;
  `entry.minHoldersByStrategy` {}), `ta.forceLive` / `dipEntrySignals` [] (lab tests it; v10.36 code stays), and
  `entry.autoAdjust` {coach false, calibration false} (`coachFor` → NEUTRAL, `calibration()` → null; both still computed —
  `calibrationTable()` for the dashboard) + `timing.enabled` false + `entry.priceAction.enabled` false (it had been switched
  on on the VPS). Kept (evidence-gated): owner filters, rug / bundle / vamp guards, loss autopsy, allocator, win + tree model,
  AI rules (forward-tested), proven TA, entry style, exit lab / exit tuner; v10.33 funnel, v10.34 dip tweaks, v10.36 new
  pairs at min size, v10.37 budget fix, v10.38 cap. NEXT: owner agreed to freeze 5–7 days / 200–300 trades, then judge each
  strategy on Performance → Mistakes and switch losers off (don't tweak). 4 GB VPS recommended.
- **Oct 15 outage (freeze):** Bot health showed 0 coins checked for an hour (Redis 600 MB, quiet hours off). Owner away from
  the PC → restarted via a notes-only push (auto-update rebuilds on any new commit). Cause not yet known — ask for Scanner
  "trades per minute" + `docker compose logs --since 30m bot | grep -iE "error|feed_restart|socket|pumpportal|stalled"`.
- **v10.40 (owner's last fix of the freeze): total fees by market cap** — the brain had turned the owner's tip into "avoid
  < 9 SOL fees" for EVERY coin; the owner meant ≥ $50k MC only. `entry.feesByMarketCap` {enabled, mcUsd 50k, aboveSol 9,
  belowSol 3} (`scorer.feeMinimum`) replaces every fee minimum in `checkEntryRules` (MC unknown → old per-strategy one) and the
  owner-filter fee minimums are zeroed while it's on. One-time `fee-rule-by-mc` → `aiCoach.removeFeeTips()` (`feeRuleTipIds`:
  owner avoid rules on a fee feature) removes that tip + retires its rule. Editable (Your filters). Migration v30.
- **v11 (Oct 17): profitability overhaul** (owner ended the freeze: 582 trades, 24% wins, every strategy losing, 69% of
  losers never above 1.05x = dead-on-arrival entries; round trip ≈7% at 0.2 SOL, so a trade needs ~1.15x to break even).
  Migrations v33–v36; one-time `v11-strategy` resets the trade coach + `_strategySince` (the old setup's record must not
  judge the new one). Pushed Oct 17 (commits d5278b4…c5917d8) → VPS redeployed.
  - **Entries**: `src/evaluator/momentum-gate.ts` (`momentumGate`: ≤+18%/1 min, ≤+30%/3 min, ≥6% under the 10-min
    high, buyers ≥52% of 2-min volume, last candle ≤15%; learning trades + dip entries exempt) and
    `src/evaluator/entry-quality.ts` (`entryQuality`, real trade stream: 15 s drop >5% / sell:buy >2 in 30 s / spike
    retraced >20% → block or half size, ≥3 buyers in 30 s, volume ratio ≥0.3; bounce after a dip → +4). Confirmation
    15 s: ≤6% lower, ≤10% higher (was 15), buyers ≥1.15× (was 1.1), ≥2 new buyers. Quiet hours 00–04 UTC back on.
    `src/integrations/rugcheck.ts` (RugCheck API pre-buy gate, `rugCheck`, off until `RUGCHECK_API_KEY` is in .env).
    Scale-in first leg 40% (was 50). Dip watcher: a dip that sits ≤2% over its low for 120 s without bouncing is dropped
    (`chart.dip.maxDipStallSec`).
  - **Edge gate** (`src/evaluator/edge-gate.ts`, `entry.edgeGate`, after decide() + learning-trade step): per strategy,
    expected value = WR×avgWin − (1−WR)×avgLoss − 7% costs (score margin: +5% WR per 10 pts over the bar) must be ≥ +2%
    or the signal is SKIPped ("edge gate: …" in Bot health). Record = newest 40 closed real + shadow trades per
    strategy since `_strategySince` (`setStrategyEdgeStats` in the loss autopsy, `strategyEdgeStatsFor`, survives
    restarts in `autopsy:last.edgeStats`); <30 trades → passes. **Every 4th refused signal buys at the minimum size**
    (`probeEvery`, EntryRequest.probe → trader min size) so a refused strategy's record keeps updating; learning trades
    bypass (they are the data). `features.edgeGate` on every stored evaluation.
  - **Exits**: TP tiers 1.25x/2x/5x (SOON + MIGRATION 1.15x 40% / 1.3x / 5x), trail + break-even from 1.2x; spike sell
    ON for every strategy (+12% in 90 s and ≥1.04x → sell 50%); time stops CURVE_SNIPE 1 min / SOON 2 / RUNNER 3 /
    MIGRATION 8, no-follow-through peak <1.08x & ≤1.04x, stall 2/4/5/8 min; **early bail** (`src/executor/early-bail.ts`,
    `exit.earlyBail`, sell manager between the stop loss and the time stops, also inside the min hold): 10–45 s in,
    never ≥1.02x, under entry, buy/sell SOL ratio ≤1.0 → STALE out. No flow data (virtual book / backtester / outcome
    replays) → never bails. "No life" exit: 3 min, never ≥1.03x, ≤0.97x, sellers ≥55% → out. Dead coin: 0 buyers 60 s +
    never ≥1.02x → out at 2 min. **Adaptive stop** (`src/executor/adaptive-stop.ts`, `adaptiveStop`): × entry-quality
    factor (caution 0.75 / weak 0.85 / boost 1.15) × MC band (<$10k ×1.3, <$50k ×1.1, <$200k ×1, above ×0.85) × age
    (<2 min ×1.2), clamped 0.5–1.8. Paper slippage 0.8% (was 1.5).
  - **Learners**: win model activates at 80 rows / 8 positives (was 150/15); allocator 0.3–1.6 (was 0.5), total floor
    0.4; autopsy tuning losing → bar +5 / ×0.7, badly losing → +15 / ×0.3; learn-row weights shadow-skipped 0.4,
    outcomes 0.5; `entry.autoAdjust` coach + calibration back ON. `src/integrations/obsidian-sync.ts` (`obsidian`
    config, `OBSIDIAN_VAULT_PATH` in .env only): daily trade journal notes.
  - All new rules editable (Controls → Rules: Momentum gate / Entry quality / Edge gate / Early bail / Trade size &
    risk). Tests: momentum-gate, entry-quality, rugcheck, edge-gate, early-bail, adaptive-stop-mc-age (80 files / 702).
- **v11.5 (Oct 17): tape recorder + replay engine** (owner: "I need to know in minutes, not wait weeks and guess").
  `src/learner/tape-recorder.ts` (`tape` config, on): every applied trade on every followed coin (curve + PumpSwap incl.
  adopted; hooked in TokenRegistry next to the crowd tracker) → Postgres `TradeTape` (mint, t, slot, wallet, buy, sol,
  tokens, px, pp, amm, curvePct; composite id+t key; Timescale hypertable 6 h chunks, compressed after 12 h, dropped
  after 6 days; the recorder also prunes to `retentionDays` 5 hourly). Batched `createMany` every 2 s / 5,000 rows off
  the event loop, `maxPerMin` 40k disk guard, nothing in Redis. Bot health shows "Tape: N trades/min, X days on disk".
  **Replay** (`src/learner/replay.ts`, pure engine; `replay-cli.ts` streams the tape in 5-min slices: `npm run replay --
  --from 2026-10-17 --to 2026-10-18 [--policy live|sniper] [--set key=value]`; on the VPS `docker compose exec bot node
  dist/learner/replay-cli.js …`): per coin it rebuilds the crowd log, candles, MC (price × 1B × SOL/USD), volume,
  holders (wallets still net long), fees (1% of volume), curve % / migration, then at the live checkpoints (new pair
  45…720 s, SOON on crossing 70% + its checkpoints, migrated every 15 s after the BOOST wait) runs the owner filters,
  strategy minimums, new-pair demand, migrated organic scan, staircase, momentum gate, entry quality, pressure and the
  score bar (tape score from the scorer's tape-computable features — or the bot's STORED Evaluation score + safety
  verdict when it checked that coin within ±2 min), and every exit through VirtualBook/decideExit with paper costs.
  NOT replayed (neutral): RPC safety / holder / dev / bundle guards, socials, KOLs, RugCheck, trending, the dip wait,
  the confirmation wait, learning trades, chart-reading exits → optimistic on rugs, pessimistic on dip timing; compare
  policies on the same days. Policies: `live`; `sniper` placeholder (1 SOL size, tiers 1.5x/2.5x/5x 25/25/20, trail
  25% from 1.5x, stop 12%, score ≥ bar+8) — piece 3 replaces it. `overrideConfig()` (runtime-config) patches the in-
  memory config in the replay process / tests only. Results: Redis `replay:last`, `replay:res:<id>`, `replay:ids` (20).
  API GET/POST `/api/replay` (`replay-runner.ts` spawns the CLI as a CHILD PROCESS so the bot never slows); dashboard
  Performance → Tests → "Replay" card (dates, rules, Run, headline + by strategy / exit / skip reasons / best-worst,
  recent runs). tests/tape-replay.test.ts (synthetic runner vs bleeder tape).
- **v11.6 (Oct 17): wallet engine** (owner: "buy on WHO is in the coin, sell before the big holders' usual hold time runs
  out"; zero new RPC / API calls — everything from the trade stream). `src/learner/wallet-book.ts` (`wallets` config):
  every wallet's record in memory (≤120k, LRU by last seen) — sells with a cost basis, wins, realised SOL, gross wins /
  losses (PF), usual hold (first buy → first sell per coin, EWMA), ≥80%-of-bag sells, dump events (a sell ≥2% of supply
  or ≥10% of the coin's 5-min volume followed by a ≥20% drop within 60 s), "dumped on" (bought ≤60 s before someone's
  dump), repeat-size buys (bots). Snipers (first 15 s) and creators get no cost basis (like wallet-pnl). Persisted to
  Redis HASH `wbook` (compact JSON per wallet, ~200 B; `wbook:meta` decay day) every minute + at stop, loaded at start;
  counts halve every 10 days. `classify` → proven (≥6 sells, WR ≥55%, PF ≥1.3) / dumper (≥3 dumps) / loser (WR <35%) /
  bot (≥60% repeat sizes) / unknown. Fed from token-registry (curve + PumpSwap) and by the replay from tape rows
  (`--policy wallets`; the replay seeds from the live `wbook` and never writes back). Bot health: "Wallet book: N wallets,
  P proven, D dumpers"; GET `/api/wallet-book`; Wallets → Smart money → card "Wallet engine" (top proven / worst dumpers).
  - **Crowd quality at entry** (`src/evaluator/crowd-quality.ts`, `wallets.entry`, evaluator after the pressure check +
    swing trader + replay): last 5 min of buying (dust excluded) by wallet class → proven ≥20% of the buy SOL with ≥3
    proven buyers → +8…+12 points (12 at 40%); losers ≥40% → −6; **rule fails**: a known dumper still holding ≥2% of the
    supply ("dump crew inside"), dumpers ≥25% of the buying; `crewPct` = buyers sharing one funder, from the funding-graph
    cache `wfund:<wallet>` only (evaluator mget, ≤40 wallets; never RPC). `features.wallets` on every evaluation (AI /
    rule search section `wallets`), note "crowd: …" in the buy explanation.
  - **Holder clock exit** (`src/executor/holder-clock.ts`, `exit.holderClock`, decideExit via `ExitInput.holders` —
    sell manager ≤ once per 2 s per position, VirtualBook `holdersFor`, replay): watched holders = wallets that held ≥1.5%
    of supply while we hold (bag at open + bought since, from the crowd log); expected sell = first buy + usual hold;
    holders ≥80% of the watched supply past it AND ≥1.1x → sell 40% of what's left once (`HOLDER_CLOCK_MARKER` −7, counts
    as banked) and the trail × 0.6 (the trail's own 0.75–1.3 clamp still applies); a known dumper selling ≥50% of its bag
    while we hold → RUG_DETECTED. Editable (Controls → Rules → Wallet engine). Migration v37 (holder clock into the saved
    `exit` row). tests/wallet-engine.test.ts.
- **v11.7 (Oct 17): Sniper mode + usage guards + pump.fun lists** (owner: "I don't care if it's a few trades, but then each
  one must be profitable with a big impact"; "don't drain my Helius / FluxRPC"). Migration v38.
  - **Sniper mode** (`sniper` config, ON by default; `src/config/sniper.ts` `sniperOn()`, `src/evaluator/sniper.ts` pure):
    a BUY only when everything lines up — 5-min `organicFlow` ≥30 real buyers / ≥12 SOL / buys ≥60% / organic ≥60%,
    score ≥ bar + 8, momentum gate + entry quality + edge gate + pressure + crowd quality all green, no learning / probe /
    half-size entries (`sniperEntryFails`, evaluator after the edge gate → SKIP "sniper: …" in Bot health; swing trader
    too). Trader: size = `trading.highConviction.sizeSol` under the existing caps only (`sniperSize`), allocator /
    conviction / coach / regime / timing / weak caps / min-size strategies ignored, global `maxOpen` 3, no scale-in.
    Exits: `sniperExitOverlay` laid over EVERY strategy in `exitRulesFor` (25% at 1.5x / 25% at 2.5x / 20% at 5x, trail
    25% from 1.5x, break-even from 1.5x, stop ≤12%, time stop 2 min without 1.08x); early bail / no-life / dead coin /
    spike sell / rug / mirror / holder clock stay on. **Watch-only while on** (they compute + log, change nothing):
    autopsyTuneFor, coachFor, calibration(), timingNow, brain.allocFactor, aiRuleVerdict, entryStyleFor, TA proven bonus,
    win-model points + size, strategy-lab auto-apply, exit-tuner (loss exits + timers). Replay `--policy sniper` = the
    same switch (`--set sniper.enabled=false` on `live` shows the difference). Controls → Trading card "Sniper mode"
    (switch + the ten rules in plain words), editable group "Sniper mode". Defaults: CURVE_SNIPE + RUNNER OFF
    (owner's CSV: the worst two), allocation MIGRATION 0.5 / SOON 0.3 / KOL 0.1 / SWING 0.1.
  - **Usage guards** (`usage` config, `src/lib/usage-budget.ts`): every RPC request counted per provider per UTC day
    (URL host → helius / flux / other; Redis `usage:<p>:<day>`, mirrored in memory); past `softPct` (80%) of a daily
    budget (Helius 25k, FluxRPC 300k, 0 = unlimited) the OPTIONAL lookups pause until midnight UTC — funding graph
    (`lookupFunder`), swing-universe holders (`topHoldersPct`), wallet reports; essential calls always go. Streams aren't
    requests. X (`x:reads`) and Solscan (`solscan:calls`) keep their own caps. WARN event `usage_soft_limit` once a day;
    Bot health "Usage today: …"; editable group "Usage limits".
  - **pump.fun lists**: king-of-the-hill / for-you / top-runners return HTTP 404 (frontend-api-v3 changed) →
    `trending.pumpUrls.{live,koth,forYou,runners}` (path or full URL, '' = off, logged once at start). OPEN ITEM: the
    owner finds the new URLs in the browser's network tab on pump.fun; set them (config push) to switch the lists back on.
  - Tests: tests/sniper.test.ts, tests/usage-budget.test.ts (84 files / 740).

- **v11.8 (Oct 17): research ports** (GitHub/paper sweep; sources in the Oct 17 research report). (1) **PumpSwap pricing
  from the chain** (`src/lib/pumpswap-pool.ts`, Chainstack protocol doc layout: `coin_creator` @211, `virtual_quote_reserves`
  i128 @245, live pools 301 bytes): the token registry reads the pool ACCOUNT once per migration / adoption and again
  345 s later (BOOST end) → `liveState.applyPoolAccount` stores `ammVirtQ`; every priced PumpSwap trade then uses
  vault + virtual when it agrees (≤5%) with the trade-implied reserve (`onchainAmm` counter), else WARN
  `amm_reserve_mismatch` once and the stored value is dropped (trade-implied stays the fallback). `coin_creator` set =
  canonical pool → `pdaCheck.creatorSet/creatorNotSet` (second signal, never a replacement). Curve account decode now
  returns `creator`, `quoteMint`, `creatorFeeBps` (@115) and `isHolderReward` (@124; 125/151/256-byte layouts, never
  filter on length) → live hash `creatorFeeBps` → `LiveTokenView.creatorFeeBps` → paper curve fee = 1.25% + creator fee
  (0 on SOL-paired coins). create_v2 cashback is rejected on chain (6082) — no cashback pricing anywhere.
  (2) **Exit-liquidity machines** (Pine Analytics: deployer-funded wallets buy in the launch block, 87% profitable,
  dump in minutes): `crowdQuality` gets `launchMs` + `creator`; a launch-window (4 s) buyer whose funder (funding-graph
  cache only, now also one hop: the funder's funder) is the dev → `deployerSniperWallets`; one still holding ≥
  `wallets.entry.deployerSniperHoldPct` (1%) → rule fail "deployer-funded launch sniper inside"; all of them →
  `walletBook.markDumpers` + rugger memory (`rug:wallets`; the ZSET has no weights — the dumper class is the
  everywhere-refusal). `features.wallets.deployerSnipers`; note "N deployer-funded snipers". Swing trader / replay
  don't pass the launch (migrated coins; tape has no funders). (3) **Consecutive-pass confirmation**
  (`src/evaluator/confirm.ts`, `entry.confirm.consecutivePasses` 2 / `intervalSec` 7): the confirmation rules must pass
  N checks in a row (same signal price / new-buyer window; the confirm job re-queues itself with `passes`), lock held
  `confirmHoldSec` = 15 + 7 s. Migration v39; editable (Every coin, Wallet engine). tests/pumpswap-pool-decode.test.ts.
- **v11.9 (Oct 17): Obsidian shared brain** (owner: "the brain of the bot where it remembers everything"; the vault is
  `/vault` = `/root/bot/obsidian` on the VPS, copied to the owner's PC by a scheduled `scp` every 10 min; the owner's
  `00 Inbox/` goes PC→VPS the same way — set that up as a second scp line when the owner wants it). Migration v40.
  `src/integrations/obsidian-notes.ts` = PURE note builders (frontmatter + wikilinks), `obsidian-sync.ts` = the writer
  (everything queued; a 10-min flush; trade logs + diary entries written as they happen). Layout: `00 Inbox/` (owner:
  `Tips.md` lines → `aiCoach.addTip` once each, sha1 in Redis SET `obs:tips:seen`, polled every 60 s; `Notes.md` tail
  4,000 chars → AI prompt section `ownerNotes`), `10 Trades/<day>.md` + `10 Trades/<strategy>/<SYM-mint8>-<day>-<time>.md`,
  `20 Coins/<SYM-mint8>.md` (every BUY signal / bought coin / skipped coin within `obsidian.minSkippedScoreMargin` 10 of
  the bar — `evaluator.obsidian.onEvaluation`, cap `maxCoinNotesPerDay` 300 via Redis `obs:coins:<day>`; verdict
  bought / signal / skipped, why, crowd note, links to strategy, trades, days and ≤15 notable wallets = proven / dumper /
  deployer-sniper buyers), `30 Wallets/<wallet12>.md` (record from the wallet book, coins it appeared in, ≤ `maxWalletNotes`
  2000 LRU, refreshed ≤ hourly, top 50 proven + 50 dumpers always kept), `40 Strategies/` (numbers + the Sniper rules in
  words (`sniperRuleLines`) + Dataview blocks), `50 Daily/` (P&L + trade links + diary link), `90 Brain/Memory.md`
  (the coach's durable memory: Redis `ai:memory`, prompt section `memory`, output field `memory`; `mergeMemory`: a normal
  review may ADD ≤3 dated bullets, a deep review may rewrite, ≤1,500 chars — enforced in code), `90 Brain/Insights.md`,
  `90 Brain/Diary/<day>.md` (one entry per AI review via `aiCoach.onReview`: insights, rules, settings changed, the change
  log since the last entry, results since the previous review), `90 Brain/Tip replies.md`, `_Dashboard.md` (Dataview
  queries), `_Index.md`, `_How to read this vault.md` (incl. graph colour groups). Editable group "Obsidian".
  tests/obsidian-brain.test.ts, tests/obsidian.test.ts. Zero RPC / API; never writes `.obsidian/*` or `00 Inbox/*`.
- **v11.10 (Oct 17): deployer history + holder-growth exits** (owner: "game changers"; research claims at the time — RETRACTED Oct 18 (v11.19): no source for "64–78% of a
  creator's second launch of the day dies" or "quiet proven dev 12% vs 1.7%"; measure them with the deployer study). Migration v41. Zero new RPC.
  - **Deployer book** (`src/learner/deployer-book.ts`, `deployers` config): per creator — launches, graduations (curve
    complete), died fast (the dead-launch sweep: forgotten with <10 holders inside 30 min), rugs (RUG_DETECTED on its coin,
    sell manager), peak MCs, newest 24 mints + launch times, funder (funding-graph cache `wfund:<creator>`, read by the
    evaluator; `byFunder` → creators sharing it). Fed by token-registry `onCreate` / `onComplete`, the index.ts dead sweep
    and the sell manager; **backfill** once per gap from the Token table (`backfillDays` 30, paged 1,000, yields;
    `dbook:meta.until` so restarts never double-count) + positions with RUG_DETECTED. Redis HASH `dbook` (compact JSON per
    creator), ≤50k creators LRU by last launch, counts halve every 30 days. `classifyDeployer` → **rugger** (≥1 rug or in
    `rug:wallets`) / **serial** (≥5 launches, 0 graduated, ≥60% died fast) / **proven** (≥1 graduated, 0 rugs, ≤40% died
    fast) / new (<2 launches) / mixed. `deployerView` (pure) → rule fails for EVERY strategy (evaluator after crowd quality;
    swing trader; replay via the live records seeded read-only): "deployer: serial launcher (N launches, 0 graduated, X%
    died fast)", "deployer: rugged before (n×)", "deployer: funded alongside N serial launchers" (`linkedSerialFail` 3),
    "deployer: already launched N other coins today (serial)" (`maxLaunchesPerDay` 1, 24 h window); proven → `points.proven`
    +6, plus `points.quietProven` +4 when the previous launch was ≥ `quietDays` 7 ago. Adopted coins (no creator) skip it.
    `features.deployer` {class, launches, graduated, diedFastPct, rugs, linked, launchesToday, daysSinceLastLaunch, points}
    (AI / rule-search section `deployer`), buy note "deployer: …". Sniper mode `requireDeployerNotSerial` (serial / rugger
    → no sniper buy). Bot health `deployers` counts (API only — the dashboard line is not wired yet); GET `/api/deployers`
    (counts + top proven / serial / ruggers, addresses truncated). Obsidian: coin notes carry `deployer_class` + a link to
    `35 Deployers/<addr12>.md` (proven / serial / rugger creators, ≤1000, record + every coin of theirs the bot looked at).
  - **Holder-growth exit** (`src/executor/holder-growth.ts`, `exit.holderGrowth`): new unique buyers per minute (a wallet's
    FIRST buy in the coin, rolling 60 s) vs the settled peak of that rate since entry (a level counts only if the rate was
    still there 10 s later; peak <3/min = not judged). ≥ `minMultiple` 1.15, rate under `collapsePct` 35% of the peak for
    `holdSec` 45 AND sellers ≥ `minSellerSharePct` 45% of the last minute → sell `sellPct` 50 of what's left once
    (`HOLDER_GROWTH_MARKER` −8, counts as banked) and the trail × `tightenTrailFactor` 0.7; never a full exit on growth
    alone; rug / mirror / early bail come first. Wired like the holder clock: `ExitInput.holderGrowth` (sell manager
    `growthFor` ≤ once per 2 s per position, the state carries "below since"), VirtualBook `growthOf` (labs + replay).
    Strategy-lab variant **G** = live without it (what the exit is worth). Editable groups "Deployer history", "Holder
    growth exit", Sniper mode. tests/deployer-book.test.ts, tests/holder-growth.test.ts.
- **v11.11 (Oct 18): research ports** (Oct 17 deep research; migration v42; zero new RPC). (1) **Launch covariates**
  (`src/evaluator/launch-features.ts`, arXiv 2607.02823: Telegram link 8.9×, launch MC above the 30 SOL default 4.5×
  graduation hazard — WITHDRAWN by the author Sep 2026, see v11.19; features kept, magnitudes dropped) → `features.launch` {telegram 0/1 (`hasTelegramLink`: socials / website / description),
  initialBuySol, initialMcSol, devSelfBuyPct} on every evaluation, AI / rule-search / win-model section `launch` — NO rule,
  NO points. The creator's launch buy is captured by live-state (`devFirstBuyLam` / `devFirstBuyTok`, creator buy ≤2 s after
  create; no creator buy = the default launch; older / adopted coins → null). Obsidian coin notes get `telegram`.
  (2) **First buyers still holding** (`crowd-quality.firstBuyersHolding`): of the SOL spent by wallets whose first buy came in
  the first 15 s (creator excluded), the share still held + those bags as % of supply → `features.wallets.firstBuyersHoldingPct`
  / `firstBuyersBagPct` (null if the crowd log doesn't reach the launch); rule `wallets.entry.maxFirstBuyersHoldingPct`
  (default 0 = OFF) + `firstBuyersMinBagPct` 5 → "launch buyers still hold X% of their bags". **Bug fixed on the way**: the
  evaluator passed crowd quality the RAW supply (10¹⁵) while trade sizes are whole tokens, so every "% of supply" there was
  10⁶× too small — the v11.6 "dump crew inside ≥2%" and v11.8 "deployer sniper ≥1%" rules could never fire; now ÷10⁶.
  (3) **Holder Rewards coins hold longer** (`holderRewardsTimeLimits`, `exit.holderRewardsHoldFactor` 1.5, 1 = off):
  `LiveTokenView.isHolderReward` (curve poll) → stale / max-hold / hold-longer cap × factor in the sell manager; the sell
  detail says "holder-rewards coin: time limits ×1.5"; stop / rug / early bail unchanged. (4) **Lab variant E** (D3AD-E
  live A/B): CURVE_SNIPE + SOON signals only (`LabVariant.strategies`, also honoured by the backtester), `exit.slotLadder`
  sells 30% at 0.4 s then 20/20/15/15 at 2.4 / 3.6 / 5.2 / 7.2 s after the buy whatever the price (VirtualBook
  `slotLadderOf`; steps ≥200 ms apart so a leg can land up to ~1 s late); `noAutoApply` → `autoApplicable()` false — judged
  by the lab / backtester / replay only. Editable: Wallet engine, Exit timers — every strategy. tests/research-ports-2.test.ts.
- **v11.12 (Oct 18): momentum gate fix** (owner: 11 h without a buy signal; "too close to the top" was the #1 migrated
  refusal ×128/h): `momentumGate.minOffHighPct` 6 → 0 (default + migration v43). The +18%/1 min and +30%/3 min caps still
  stop chasing; dip-only (≥$15k MC) still handles pullbacks.
- **v11.13 (Oct 18): self-improving loop** (owner: "the bot improves itself with proof while I sleep";
  `src/learner/self-loop.ts`, `loop` config, migration v44). Daily at `hourUtc` 5 (10-min tick) or Brain → "Self-improving
  loop" → Run now (POST `/api/loop/run`; GET `/api/loop` = state + last 20 experiments; Redis `loop:state`). ONE change:
  (1) **propose** — `aiCoach.proposeOne` (structured output, only keys `keyAllowed` offers, normal AI budget; over budget /
  no key → none) else `proposeFromHealth` (pure, Bot health last hour: strategies with ≥20 rule-passes and 0 signals →
  their top relaxable skip, else their score bar; after 6 h without a buy → the top relaxable skip of any switched-on
  strategy; `settingForSkip` maps the normalised skip text to a key, `relaxStep` = 20% of the gap to the editable limit,
  ≥1 step). `validateChange`: editable limits + step rounding, no-op refused, sizes (sizeSol / PositionSol /
  sizeMultiplier / allocation) only DOWN, ≤ `maxStepPct` 30% of the range per change; `keyAllowed`: `allowedKeys` if set,
  else only keys the replay evaluates (ownerFilters, focus.migrated/soon/newPair, momentumGate, entryQuality,
  entry.pressure, entry.minCombinedScore / minHolders*, sniper.*, exit.*, wallets.entry, deployers, runner.scan) and never
  usage / obsidian / paper / enabledStrategies / sniper.enabled / loop / any `.enabled` switch. (2) **prove** — needs ≥
  `minTapeHours` 24 of TradeTape; two replays (`runReplayAndWait`, the child-process runner, policy `live` = saved config;
  never while another replay runs) on the last `tapeDays` 2: baseline vs `--set key=value`; `acceptVerdict`: candidate ≥
  `minTradesBoth` 8 trades, totalSol > 0, PF not lower than base − `maxPfDrop` 0.15, and +`minEdgeSol` 0.1 SOL or
  +`minEdgePctPts` 2 pts/trade with ≥ the same SOL; baseline 0 trades → accept ≥8 profitable trades with PF ≥1. (3)
  **apply** — `applyEdit(source 'loop')` → change log. (4) **watch** — real closed PAPER trades since the apply (the key's
  own strategy via `strategyOfKey`, else all) until `watchTrades` 12 or `watchHours` 48; `watchVerdict` reverts (source
  'loop-revert') only when live avg is > `revertIfWorsePts` 3 pts under the replay's avg AND under the 30 trades before
  the change; 0 trades in 48 h → kept. One experiment at a time; `cooldownHours` 20 after a kept / reverted one (Run now
  skips the cooldown, never the one-at-a-time rule). LIVE mode: off unless `loop.allowLive`. Every step → Obsidian diary
  (`obsidian.appendDiary`); applied / kept / reverted → one AI memory bullet (`aiCoach.remember`). Editable group
  "Self-improving loop". tests/self-loop.test.ts.
- **v11.14 (Oct 18): live execution (DORMANT)** (Phase 4; `src/executor/live/`, `live` config, migration v45). PAPER stays
  the default: a real transaction can only be sent when ALL hold — `TRADING_MODE=LIVE` + `WALLET_SECRET` (base58 or a JSON
  64-byte array; `BOT_WALLET_PRIVATE_KEY` also read) in the VPS .env, a ready sender, the wallet ≥ `live.minBalanceSol`, AND
  the owner typed the wallet's first 4 characters on Controls → System → "Live trading" (PUT `/api/controls/live`, BotConfig
  `_live` {enabledAt}; restarts the bot). `createExecutor` (`src/executor/executor.ts`) picks LIVE only when `liveBlockers`
  is empty, else PAPER; trader + sell manager only see the `Executor` interface, so paper, dry run and live share one path.
  - **Transactions** (`instructions.ts`, `tx-builder.ts`; layouts from Chainstack's pumpfun-bonkfun-bot Oct 2026 protocol
    doc + IDLs): curve `buy_v2` [184,23,238,97,103,197,211,61] (27 accounts, `amount` + `max_sol_cost` = the size) /
    `sell_v2` [93,246,130,60,231,233,64,178] (26, `min_sol_output`), quote_mint WSOL, fee recipient FEE / MAYHEM_FEE,
    buyback recipient random of 8, sharing_config + fee_config under the fee program; PumpSwap `buy`
    [102,6,61,18,1,218,235,234] (`base_amount_out`, `max_quote_amount_in` = size, track_volume) / `sell`
    [51,230,133,164,1,127,131,173] (`min_quote_amount_out`): IDL accounts → cashback pair (cashback pools, sell) →
    pool-v2 only on the canonical pool → buyback recipient + its WSOL ATA last; quote settles through a seed-derived WSOL
    account opened + closed in the same tx. Idempotent ATA create; ATA closed on a full sell. Priority fee =
    getRecentPrioritizationFees p75 clamped 10k–1M µlamports/CU (cached 10 s); CU limit per kind from the first
    simulation ×1.2 (defaults curve 120k/90k, PumpSwap 220k/180k); `loadedAccountsDataSizeLimit` 0 = off (Token-2022 hits
    MaxLoadedAccountsDataSizeExceeded — Chainstack disables it too). Non-SOL curves refused. UNVERIFIED: the PumpSwap BUY
    account list (the doc only shows sell) — the dry run proves or disproves it.
  - **Sending** (`sender.ts`): `LIVE_SENDER_URL` + `LIVE_TIP_ACCOUNTS` (comma list; Helius Sender, tip `live.tipLamports`
    to a random tip account) → else `LIVE_SHIELD_URL` (FluxRPC shield) → else normal RPC. Every send counted in the usage
    budget. Confirm by polling signature status until `live.confirmTimeoutMs` / blockhash expiry; fill from the confirmed
    tx's pre/post balances (ATA rent excluded), else the plan.
  - **Safety**: `live.maxPositionSol` 0.1 on top of every other cap, `maxOpen` 2, `reserveSol` 0.05 kept for fees,
    `minBalanceSol` 0.5; daily loss limit + strategy cool-off ALWAYS apply in LIVE (`lossLimitsApply`; learning trades
    don't skip the cool-off in live); kill switch (Sell all & stop) sells through the live executor; reconciler every 60 s
    (chain token balances vs open LIVE positions; mismatch > 2% → `entryContext.review` + WARN, unknown tokens → WARN, never
    buys / sells on its own); self-improving loop excludes `live.*` and never runs in LIVE. Secret never logged (logger
    redaction + `redactSecret` on every error); only first4…last4 of the address leaves the process.
  - **Dry run** (`dry-run.ts`, `live.dryRun.enabled`, on): in PAPER every successful paper fill also builds + SIMULATES the
    real tx (bot wallet if set, else a throwaway key → "funds" = layout accepted), skipped past the RPC soft budget.
    Redis `live:sim` (n / ok / funds / error) + `live:sim:last` (50). Bot health "Live path: N simulated, X% OK"; Controls
    card shows the last 5. Editable group "Live trading" (caps only). Back to paper: 409 while live trades are open.
  - **Owner's go-live checklist**: (1) a NEW dedicated wallet, funded with 2–5 SOL (never the main wallet); (2) VPS .env:
    `WALLET_SECRET=…` + `LIVE_SENDER_URL` (+ `LIVE_TIP_ACCOUNTS`) or `LIVE_SHIELD_URL`, then `TRADING_MODE=LIVE`;
    (3) dry-run stats ≥ 95% OK for a full day (Controls → System → Live trading); (4) Controls → Go live (type the first
    4 characters). Go/no-go Nov 7 only if paper edge is positive. tests/live-executor.test.ts.
- **v11.15 (Oct 18): policy tournament** (`src/learner/tournament.ts`, `tournament` config, migration v46). ~20 Sniper
  variants (`tournament.variants`: dotted-path `entryOverrides` / `exitOverrides` over the live config — buyers 20/25/35,
  SOL 8/16, score margin 0/4/12, momentum run3m 20/45, TP ladders 1.3/2/4 & 2/3/6, trail 18/32, stop 10/16, no
  holder-growth, no holder-clock; plus `live` and `random` = 1 in 40 scored coins) trade VIRTUALLY (VirtualBook,
  decideExit, paper costs, signal price — no dip / confirmation wait) on the same live candidates. Evaluator hook right
  before the Sniper gate (`evaluator.tournament.onCandidate`): candidate = no hard safety fail, switched-on strategy,
  every rule fail is a momentum-gate fail; per variant the pure `sniperEntryFails` re-runs with its overrides
  (momentum gate re-run on the shape when overridden); exits = live rules + the Sniper overlay rebuilt from the variant's
  `sniper.exits.*` + `exit.*` keys. Once per coin per variant per 30 min; ≤ `maxOpen` 400 open (evicts the oldest of the
  fullest variant, `VirtualBook.remove`). Results Redis `tour:res:<id>` (2,000 each), `tour:stats`, `tour:offers`.
  **Winners** (`judge`): one-sided Welch vs the baseline + Benjamini–Hochberg (q 0.1), avg ≥ baseline + `beatLiveByPts`
  2, positive without its 3 best, n ≥ `minResults` 40. Baseline = `live` with ≥ max(10, minResults/2) results, else
  `random`, else zero. Winners are never applied by the tournament: every 10 min `offersFor` hands the single editable
  key (multi-key variants: only a key whose own 1-key variant also won; TP ladders / `.enabled` keys = owner decides) to
  `selfLoop.offer` → validated + queued in `loop:state.offers`; the next loop run tries tournament offers FIRST (ahead of
  the AI), still replay-proven + watched + revertible; an offer equal to a change rejected / reverted in the last 7 days
  is refused. GET `/api/tournament`; Performance → Tests card "Tournament" (sortable, status chips). Editable group
  "Tournament". tests/tournament.test.ts.
- **v11.16 (Oct 18): AI meme-reading** (`src/evaluator/meme-reader.ts`, `meme` config, migration v47). One Claude read
  of a coin's name / ticker / description (≤600 chars) / socials / launch time + the current hot narratives + ≤5 known
  coins with a similar ticker (`VampGuard.similar`) → strict JSON {originality, narrativeFit, effortSignals 0–10,
  redFlags ≤4, verdict strong/ok/weak/avoid, oneLine}; memeScore = mean of the three. Model `AI_MEME_MODEL` → `AI_MODEL`
  → `claude-sonnet-5-5` (owner chose Sonnet), same request shape as the AI coach: `client.beta.messages.create` with
  betas `server-side-fallback-2026-07-01` + `fallbacks: "default"` (not for Haiku), `output_config: {effort: 'low',
  format: json_schema}`, no thinking param, no tools; `stop_reason === 'refusal'` → no verdict. Runs ONLY for coins
  whose rule fails are all soft and that score within `withinBar` 10 of the bar; once per mint (Redis `meme:<mint>`,
  `cacheHours` 24); `maxPerHour` 30 (`meme:calls:<hour>`); `dailyBudgetUsd` 0.25 (`meme:spend:<day>`, also added to
  the coach's `ai:spend:<day>`); raced against `timeoutMs` 4 s — late answers are cached for the next checkpoint, a buy
  never waits on it. Effect (evaluator, before the AI-rule flatten): `features.meme` {score, originality, narrativeFit,
  effortSignals, verdict, verdictRank, redFlagsCount} (flatten section `meme`); verdict avoid + a drainer / phishing /
  impersonation / fake-team flag → rule fail "meme: <flag>" (Sniper too); ±`points` 6 around 5/10 (watch-only in Sniper
  mode unless `applyPointsInSniper`); `minScore` > 0 → "meme score X < Y" (default 0 = off; the tournament tests 6 and
  7.5 as variants `meme6` / `meme75`, and a winner goes to the self-loop like any other). Buy note "meme: 7.2 — …";
  Obsidian coin notes `meme_score` + a "Meme read" section. GET `/api/meme`; Bot health tile "Meme reader". Text only
  — reading the coin image is a possible later add (costs more). tests/meme-reader.test.ts (Anthropic call mocked).
- **v11.17 (Oct 18): "Where's the money?" + score-gap check + 0.5 SOL trades** (owner: 14 h with 0 signals; the score-gap
  card showed every near-miss LOST → the bar is right, the coins are wrong; "make it as cool as you can, add more fun
  features, raise the trading amount to 0.5"). Migration v48: `trading.maxPositionSol` 0.5 (ceiling 1); Sniper trades
  still use `highConviction.sizeSol` 1. **Score gap** (`src/tools/score-gap.ts`, GET `/api/score-gap?hours=`, CLI
  `node dist/tools/score-gap.js [hours]`): coins held back only by the score (shadow `near` + outcome rows), banded by
  distance to the bar with what they did next + a plain-words verdict (bar too high / bar is right / too few) →
  Performance → Mistakes card "Coins the score held back". **Money map** (`src/learner/money-map.ts`, pure
  `buildMoneyMap` + `loadMoneyRows`; GET `/api/money-map?hours=24–168&strategy=&source=all|skipped|real`, cached 2 min):
  one pool = real closed PAPER trades + shadow trades + outcome-tracker rows, each with the flat entry features →
  19 dimensions (strategy, MC, age, hour, weekday, score vs bar, active wallets, buy pressure, 3-min run, off the high,
  proven wallets, KOLs, Telegram, holders, fees, curve stage, meme score, deployer record); per band n / win % / avg /
  median / SOL at 1 SOL each / reached 1.15× (break-even) 1.5× 2× / perfect-exit % (peak capped 10×, −7% costs);
  per-strategy **verdict** picks vs exits (≥30 coins: avg >0 working; ≥30% reached 1.5× yet avg <0 → exits; <40%
  reached 1.15× → picks; else both); best / worst groups (≥15 coins, avg shrunk ×n/(n+20)); two-rule combos of the
  12 best groups; exits table live vs `outcomes.altVariants` ['S','R','W'] vs perfect (the outcome tracker now replays
  every checked coin through those lab variants too → `OutcomeResult.alt`, new rows only); week heat (UTC cells, the
  dashboard shifts to the viewer's clock); "the ones that got away" (skipped runners ≥1.5× with why, linked to the coin
  page). Dashboard: Performance → **Money** tab (`components/MoneyMap.tsx`: range / source / strategy chips, SOL-per-
  trade input re-prices every group, "Split it yourself" explorer). tests/money-map.test.ts, tests/score-gap.test.ts.
- **v11.18 (Oct 18): copy replay — "who's actually making money"** (owner: "do anything to make it profitable"; the Money
  tab, once broken prices were dropped (`saneRow`: a result can't beat its own peak / pass 10×; rankings use a +300%-capped
  average), showed NO kind of coin pays: 7,365 coins, 11% ever reached 1.15×, median −5%, perfect exits +3.2%; the 2-day
  Sniper replay: 188 trades, 16% wins, −5.66 SOL. So test the other axis — WHO buys). `src/learner/copy-replay.ts`
  (pure `CopyReplay` engine + CLI `npm run copy-replay -- --from --to [--size]`, VPS `node dist/learner/copy-replay.js`):
  walks the TradeTape forward, keeps every wallet's realised record (cost basis per coin, snipers = first 15 s excluded,
  LRU 300k wallets, positions forgotten after 24 h); once a record qualifies (`qualify`: ≥6 sells, WR ≥55%, PF ≥1.3,
  ≥0.5 SOL realised, ≤60% repeat-size buys) its NEXT buys ≥0.1 SOL are copied at the pool price it left (+0.8% slippage,
  1.25% fee, tx fees; `sizeSol` 0.5; ≤3 open per wallet / 60 total) and mirrored on its sells (same share; hard stop −35%,
  max hold 6 h, tape end). Owner's TrackedWallet rows are copied from their first buy as kind `tracked`. Per wallet:
  copies, win %, avg, SOL, first / second half SOL → `consistent` (both > 0, ≥6 copies); `copyable` = n ≥5, avg >0,
  PF ≥1.3, consistent. Report Redis `copyrep:last` / `copyrep:res:<id>` / `copyrep:ids`. Runner
  `copy-replay-runner.ts` (child process, `--max-old-space-size=1024`), GET `/api/copy-replay`, POST `/api/copy-replay/run`
  {from,to,sizeSol}; dashboard Performance → Money → card "Who's actually making money?" (Run, progress, verdict, by kind /
  exit / day, wallet table with Solscan links, button "Copy these N wallets live" → POST /api/wallets/bulk kind COPY).
  Migration v49: live copies match the test — `copy.skipDipWait` / `skipConfirm` true, `sniper.exemptCopies` true (the
  Sniper volume / score gate skips SMART_MONEY_COPY entries with a wallet; owner filters, rug / bundle guards, mirror sells
  unchanged). tests/copy-replay.test.ts. Next: owner runs it (≈6 min per day of tape); if `copyable` wallets exist,
  press the button and watch Performance → Mistakes per strategy "Smart money".
- **v11.19 (Oct 18): acting on the deep research** (report: `docs/research/2026-10-18-pumpfun-edges.md`; six research
  agents, ~29 sources, mostly search-engine extracts — the sandbox could only open github.com). Verdict: NO public
  study / backtest / bot log shows a positive after-cost strategy for a 1–3 s-late bot at 5–8% round trip; the measured
  winners are launch-block snipers (87% profitable, out <5 min) and sandwich bots; the one rigorous OOS backtest
  (apchhui/pump-research, 26k launches, Oct 2026) had every family losing on holdout and its "winner" was a Mayhem
  pricing artefact (ours prices from the trade event's own reserves → not affected). RETRACTED beliefs: the Telegram
  8.9× / launch-MC 4.5× multipliers (author withdrew them, Sep 2026; features kept, no rule / points), the deployer
  "second launch of the day dies 64–78%" and "quiet proven dev 12% vs 1.7%" claims (no source), "dev sold out = safer"
  (a 3-day sample says the opposite), bundle = rug (no difference). No measured effect: terminal presets (snipers / dev /
  top-10 %), Dex paid, narrative fit, KOL count, hour of day. Evidence exists only for RULE-OUT signals: first-5-min
  flow, deployer-funded launch buyers, dumper clusters among the first buyers, SOL-weighted organic flow. Migration v50:
  **elite deployers** (`deployers.elite` {minGraduated 2, minBondRatePct 20, tradeWhenStrategyOff true}; class `elite`
  in `classifyDeployer`, `points.elite` 10, note "repeat graduator"; Sniper volume minimums × `sniper.eliteVolumeFactor`
  0.5; `EntryRequest.eliteDeployer` lets the trader buy an elite creator's launch while its strategy is OFF);
  `wallets.entry.maxFirstBuyersHoldingPct` 0 → 50 (ON); new `wallets.entry.maxDumpersInFirst20` 3 (crowd-quality
  `dumpersInFirst20` → "dump crew at the start"). **Deployer study** (`src/learner/deployer-study.ts`, pure
  `studyFromLaunches`: every launch in the Token table banded by what its creator had done BEFORE it — prior graduations,
  nth launch, launched again within 24 h, quiet ≥7 d after a graduation, elite definition — vs graduation; coins <2 h old
  excluded; Redis `dstudy:last`; GET `/api/deployers/study`, POST `/run` {days ≤30}; Money tab card). Money tab: new
  splits `devHold` (`market.devHoldingPct`) / `devSold` (`market.devSoldFraction`) to re-test the v10.31 dev-sold
  relaxation on our data, deployer split marks "elite". One-time `retract-launch-priors` → one AI-memory bullet.
  tests/research-actions.test.ts. NEXT: owner runs the copy replay + the deployer study; read elite / dev-holding bands
  on "Inside your filters" before any further rule change. If none shows an edge: speed (paid stream + fast sender) or stop.
- **v11.20 (Oct 18): results of the tests + elite test v2.** Copy replay (5 days, 8.96M trades): 2,966 copies, 13% won,
  −134 SOL at 0.5 SOL, 0 consistent wallets; owner's tracked wallets 845 copies / 1% won → migration v51 switches
  SMART_MONEY_COPY OFF (copy-trading is dead for a late copier, as the research said). Deployer study (14 d, 377,713
  launches): elite devs graduate 41.9% vs 2.61% base (16×, n 2,148); second launch within 24 h 0.61× base (no-repeat rule
  justified); "quiet 7+ d" band has 3 cases (irrelevant); first launch 1.79×. Elite test v1 (5 d, 83 launches): buying
  15–60 s in did NOT pay (best 60 s / 3× → +2.1 SOL, 19% won, PF 1.19; 34 hard stops, only 1 graduation inside 60 min)
  → elite launches spike, dump, graduate LATER. **Elite test v2** (`elite-test.ts`): entries = 60 s after launch OR a dip
  30% / 50% off the first-minute high within 30 min; holds 1 / 6 / 12 h; sells graduation / 3× / 5× / −60%; grid per
  entry × hold × rule, best rule needs PF ≥1.5 on 30+ trades; `timeToGraduate` of elite graduates (median / quartiles /
  within 1 h / 6 h) from the Token table; deployer study adds the elite × repeat-24 h split. NEXT: owner runs elite test
  v2; if it pays → wire the elite path (dip entry, long hold, sell into graduation); if not → speed route or stop.
- **v11.21 (Oct 18): declutter** (owner: "remove all features we don't need anymore so things don't get cluttered up";
  earlier the same evening: "people trade narrative / news — get into launches related to that and exit, they don't hold").
  REMOVED (their verdicts are recorded above; code gone, nothing else changed): copy replay (v11.18: engine, runner, CLI,
  `/api/copy-replay`, Money card), deployer study (v11.19: `/api/deployers/study`, card), elite launch test (v11.20:
  `/api/elite-test`, card), moonshot test mode (v10.17: `moonshot` config + editable group, `/api/moonshot`, Tests card),
  score-gap card (v11.17: `/api/score-gap`, tool; `scoreOnly` moved into money-map.ts), and the unfinished "cohort test"
  (BOOST / survivor trades — never wired, deleted). Left as they are: the deployer book + elite class (live rules), the
  Money tab, replay, tournament, labs, backtester, shadow / outcome trackers (they feed the brain). Old Redis keys of the
  removed tests (`copyrep:*`, `dstudy:last`, `elite:*`, `moon:res`) are harmless orphans. 879 tests.
  **Narrative / news trading** (the owner's idea): the bot cannot read news; what it has is the hot-keyword list (market
  leaders + DexScreener + trending), the narrative score and the AI meme reader's `narrativeFit` on every evaluation, and
  the Money tab already splits results by meme score (narrative fit is a third of it). The honest test is that split on
  "Inside your filters": if coins with a high meme score / narrative fit show a POSITIVE MEDIAN there, build a fast-exit
  narrative entry; the verdict section above says nothing measured so far has. Do not build it before that split says yes.
- **v11.22 (Oct 18): the two tests the owner asked to run from the phone** (owner: "how do we copy trade faster… is it
  already implemented, what do I run"). Both on Performance → Money, at the bottom. (1) **Copy replay is BACK** (restored
  from 6888636) with a **"Method only"** switch (`CopyReplayConfig.method`, `--method` on the CLI, `method` in the POST
  body, default ON in the card): a wallet's record counts only round trips held ≥ `methodMinHoldSec` 300 and bought ≥
  `methodMinAgeSec` 60 after the coin's first trade (block snipers and 30-s flips are not a copyable method); report
  field `method`. (2) **Cohort test** (`src/learner/cohort-test.ts`, in-process with yields, Redis `cohort:test:last`,
  GET `/api/cohort-test`, POST `/run` {days ≤14}, card "BOOST trade & survivor trade"): every graduate's PumpSwap tape
  (Token.completedAt in the window, newest `maxGraduates` 600) → BOOST trades (buy 10 / 30 / 60 s after the first
  PumpSwap trade, sell 1.3 / 1.5 / 2× or at BOOST end 5 min, stop −30%) and survivor trades (≥20 distinct buyers in the
  hour before 1 h / 2 h, hold ≤ 6 / 12 / 24 h, trail 25% from 1.3×, TP 3×, stop −40%); best rule needs 30+ trades,
  "It pays" needs PF ≥1.5 and a positive total. Speed answer given to the owner: the v11.18 replay already copied at
  ZERO delay and lost, so faster plumbing (gRPC, processed commitment, Sender tips, pre-built txs, co-location,
  ShredStream) cannot rescue copy trading unless the method-only replay finds a consistent wallet first.
  tests/cohort-test.test.ts, copy-replay.test.ts (method mode). 888 tests.
  **First run (5 d, 600 graduates, 491 with tape) was a PRICE ARTEFACT**: "60 s in / 2×" showed +7,487 SOL, PF 152 —
  avg +3,049% with a MEDIAN of −4.9% = one fake ~10,000× print; the "10 s in" rows (same coins, no broken print) were the
  truth: avg +0.6…+4%, median −5%, PF 1.03–1.18 → no edge; survivors 13% won, median −6%. Fix: `saneSim` drops sims past
  10× (peak or gain), averages / totals cap each trade at +300% (`CAP_PCT`), report `dropped`, and "It pays" now also
  needs a POSITIVE MEDIAN. **Re-run (fixed): NOT AN EDGE** — best BOOST rule 489 trades, 43% won, median −5.1%, PF 1.03
  (220 hard stops avg −51%, 192 BOOST-end exits avg +9.5%, 76 take-profits); every 60-s entry negative; survivors 12% won,
  median −6%, PF 0.31 (28 broken prints dropped). The BOOST buy-and-burn does not lift graduates against their sellers.
  That was the last untested mechanical flow on pump.fun. **Method-only copy replay (5 d, 10.8M trades): also NO** —
  399 qualified wallets copied → 1,372 copies, 19% won, −123 SOL; owner's 22 tracked wallets 1,081 copies, 1% won,
  −76 SOL; mirror sells −100 SOL (the winner's own sell lands on the copier); 1 "consistent" wallet = 10 copies, 1.8-min
  holds, +0.76 SOL = noise. Every reachable edge is now tested and lost. Owner declined the perps / liquid-coin pivot
  (wants weekly returns, which no honest bot gives) and was told so. Bot stays on paper as a free watch; nothing new
  gets built unless Performance → Money shows a group with a positive median on "Inside your filters".
- Copy trades: since v10.25 normal bar / size, max 2, no min hold, mirror sells (see v10.25). Before: bar +5, ×0.5, max 1, 120 s hold.
- Saved settings: `src/config/migrations.ts` versioned migrations (BotConfig `_version`) push deliberate
  default changes into saved rows (Controls saves whole sections, which otherwise freeze old defaults).
- Owner's entry rules: min $12k volume, min $12k MC, min 1 SOL total fees paid (terminal-style), safety ≥ 55 (v9.6), score ≥ 70
  (copy 60), anti-rug limits (bundlers ≤18%, top10 ≤50%, single wallet ≤10%, dev ≤10%); strong coins breaking
  only concentration limits (within 30/65/15%) are bought at half size; near-misses go on a watchlist;
  volume spikes trigger immediate checks; X hot keywords (needs TWITTER_BEARER_TOKEN) boost narrative.
  All editable on the dashboard Controls page (BotConfig). Config sections deep-merge with defaults.
- Focus (`focus` config, v5 numbers above): SOON fires when the curve crosses 70% (CrowdTracker.onSoon →
  evaluator.scheduleSoon), rules ≥3 SOL fees, ≥$10k volume, ≥25 active wallets (5m), curve 70–90%.
  MIGRATION_MOMENTUM: ≥9 SOL fees, ≥$25k MC, ≥$2k liquidity (both sides, USD), ≥20 active wallets, not in the
  BOOST window. Allocation v7: NEW PAIRS 40% / SWING 30% / MIGRATION 15% / SOON 15% / COPY 0% (v5 was 55/25/20).
- Crowd behaviour (`src/scanner/crowd-tracker.ts`, in-memory trade log for curve ≥40% / migrated coins):
  active wallets 5m ("eyes" — pump.fun's own viewer count isn't public), dip buying, paper hands, bot churn,
  retail share, buy acceleration, smart-wallet share → features `crowd` + `attention`. Wallet reputation
  (`src/learner/wallet-reputation.ts`): buyers at scoring time get the coin's 1h label → finds smart wallets.
- Swing RE-ENTRIES (older, `focus.swing`, `src/executor/swing-watcher.ts` — separate from the v7 SWING strategy above): after a SOON/migration exit (not rug) the coin
  is watched 2h; 15–45% pullback + bounce with buy/sell ≥1.2 → re-evaluation as a swing (v5: only after a
  profitable exit, ≤1 re-entry).
- Trade coach (`src/learner/trade-coach.ts`): 30 min after every close it reviews the trade (late entry,
  gave back profit, stopped then ran, sold too early…), stores the lesson on the position and adjusts per
  strategy: buy bar −5…+12, size ×0.35–1 on losing streaks, stop bias ±5%, trail ×0.75–1.3.
- Stop loss (`exit.stopLoss`): owner's band = loss AFTER fees, v5 12–20%: 2×volatility (+coach bias) clamped
  (15% until volatility is known), must hold 2 s under the stop, immediate past the hard limit.
  MIGRATION_MOMENTUM max 15% (`maxPctByStrategy`). (Research suggests −30% with smaller size → lab variant W.)
- Trailing (`exit.trail.ladder`, v5): arms at the first take-profit (1.4x): 20% → 25% at 2–3x → 22% at 5x →
  20% at 10x (linear), ×0.8–1.2 by volatility, × coach trailFactor; a break must hold 0.5 s (gap = instant).
  Break-even (+fees) floor from 1.4x. Empty ladder = legacy logic (tested in exits-trailing.test.ts; older
  tests run against `tests/legacy-exit.ts` = the pre-v5 exit settings).
- **Speed (Oct 9 v4, peaks fixed in v5):** exits are trade-driven — TokenRegistry.onTradeApplied →
  SellManager.onTrade checks a held coin ≥120 ms (slot settle) / ≤200 ms after each trade (coalesced;
  per-position lock), 1s tick as fallback. Peak = settledHigh (level held 2.5 s) — the raw highest print is
  only drawn on the chart (`highSol`). Paper landing delay 150–500 ms. Chart: history point every 1s (+ spike
  highs), 6000 pts, API downsamples to 1500 keeping highs/lows; WS updates per trade.
- DexScreener (`src/scanner/dexscreener.ts`, `dex` config): every 60s ranks Solana boosted/profiled coins by
  1h volume/trades/move (DexScreener's own trending isn't in the public API); `/orders/v1/solana/<mint>` →
  DEX paid (approved tokenProfile) / CTO, cached, ≤45 req/min. +4 paid, +2 CTO, up to +5 trending; tracked
  coins that start trending are checked at once; `dex.requirePaidFor` can make it mandatory. Scanner page list.
- **Chart reading** (`chart` config, `src/evaluator/chart-reader.ts`): 15s candles per coin from the crowd
  log (1h) → VWAP(10m), RSI(14 on 30s), EMA trend, pivots (higher lows / lower highs), pullback/bounce,
  2-min run, blow-off top, bearish divergence. Entry verdict: `avoid` (breaking down → rule fail),
  `buy_now` (dip ≥8% + bounce ≥2% in uptrend, +4 pts), `wait_dip` (stretched: >25% over VWAP / RSI>78 /
  >35% in 2 min) → DipWatcher (`src/executor/dip-watcher.ts`) waits ≤10 min for the buy zone (38–62% fib
  retrace of the last run; top clamped 10–15% off the high, bottom ≤40%, VWAP floor; the zone follows new
  highs until the dip starts) + 3% bounce with buy/sell ≥1.1 (bounce >8% above the zone = missed, re-arm),
  then re-checks with `dip: true` (skips the 12s confirmation); +100% from signal / broke down / timeout →
  dropped. E2E: skipped the top, bought 14% below it after the bounce. Config migration v3. Positions page "Waiting for a dip"
  (`/api/dip-watch`). Exits: blow-off → sell 50% of what's left, divergence → 30% (≥1.4x, once each;
  tpTiersHit markers −2 / −3).
- KOLs (`kol` config, `src/scanner/kol-signal.ts`): TrackedWallet.kind = COPY (copy each buy) | KOL (signal only).
  Starter list `src/config/kol-wallets.ts` (Cupsey, Cented, Orangie — public-tracker addresses, unverified;
  seeded once, marker `_kolSeed`). Whale tracker records KOL buys/sells (Redis `kol:buy:/kol:sell:<mint>`);
  ≥2 KOLs in a coin within 60 min → immediate check; +3 pts per KOL (max 12); KOLs who bought now selling
  (≥2, ≥half) → −6, rug screen blocks the buy, open position ≥1.05x is sold. Wallets page: KOL board, bulk
  import ("name address" per line, POST /api/wallets/bulk), kind selector.
- Smart-money discovery (`discovery` config, `src/learner/wallet-pnl.ts`): realised PnL per wallet from every
  tracked trade (Redis `wpos:*` per-coin cost basis 12h, `wpnl:*` aggregates, ×0.85/day decay, ≤80k wallets;
  creators + buys <15s after launch excluded). Every 30 min the top 40 (≥8 sells, ≥45% wins, ≥5 SOL, ≥0.05
  SOL/sell, ≤3000 sells) become KOL wallets (source DISCOVERED, "Smart #n"); dropped → paused, deleted after
  7 days; manual wallets just get stats. `/api/smart-wallets` leaderboard on the Wallets page.
- "What's working now" (`leaders` config, `src/scanner/market-leaders.ts`): top coins = our biggest 1h-volume
  tracked coins + DexScreener trending; words shared by ≥2 of them = hot narratives, added to the narrative
  hot-keyword list. Scanner page card (`/api/market-leaders`).
- Exits (v5): tiers (40% at 1.4x, 15% at 5x), then **initials** at 2x (sell enough to get the stake + fees back
  → "house money"), the rest rides as a **runner** (ignores resistance/risk exits, max hold 2× normal). Protect
  profit (1.4x → floor 1.03x), resistance/momentum-risk exits ≥1.5x, time stops, BOOST sell, rug/copy exits.
  Fees: curve 1.25%, PumpSwap tiered 1.25%→0.3% by MC, 0.0015 SOL gas+tip per tx, 1.5% slippage, 0.15–0.5s
  random landing delay before each paper fill (fills >maxSlippageBps worse than the decision price refused).
  Every trade stores an explanation (+ the coach's lesson after review).
- Dashboard: positions show entry MC vs current MC (SOL + USD), a live price chart per position
  (Redis `pos:hist:<id>`, 1s points + spike highs, 3-day TTL) with TP/stop/trail lines; redesigned layout + footer.
- Pricing safety: fake/duplicate PumpSwap pools rejected (curve must be ~complete, price within 3x of final curve
  price), trade-implied price cross-checks, every paper fill clamped to ≤3x the last real trade price
  (`suspicious_fill` WARN events), sells serialized per position. `scripts/find-suspicious-trades.ts` lists bad trades.
- Trailing stop (`exit.trail`): volatility from 15s returns over 4 min (outlier-robust), 2.5×vol before initials,
  runner capped 30/25/20% at 3/5/10x, break needs 2 ticks + 3s (instant on a >1.5× gap), break-even floor after 1.5x.
- Anti-rug (`antiRug` + `src/evaluator/insider-cluster.ts`): stream flags (bundle/same-size burst/transfer/dev-sync
  sellers) fed by TokenRegistry→InsiderTracker; funding graph via RPC (≤10 wallets/token, 24h cache) finds hidden
  dev wallets; effective dev/bundle % count toward limits; serial-rugger memory = hard fail; insider dump → RUG exit.
- Narrative: social-analyzer `narrative()` (boost/hot/learned keyword odds, copycats, trends, description quality)
  → 'narrative' feature + reason in buy explanation. Keyword beliefs in Redis `kw:*` (src/learner/keyword-learner.ts).
- Learning: labels sampled over 1h (win = 1.8x before 0.7x), real trade P&L preferred; suspicious / >25x /
  pre-reset data excluded. Weights adjust every 20 min + after each close (recency, losses ×1.5, own ×3,
  holdout AUC check, cap 4%); Bayesian pattern odds adjust score ±8 pts. Regime every 15 min, per-hour size factor.
- Paper reset (Controls/Overview): wipes paper trades/positions/stats, coach reviews and swing watches, optional
  new starting balance, sets Redis `paper:resetAt`. Verified working locally (Oct 9) — if the owner says it
  doesn't work, the VPS is probably running old code: check the dashboard's Bot health panel (version vs site).
- Health: `/api/health` (public: version, uptime) + `/api/system` (auth: restarts 24h, why the last run ended,
  recent errors, memory, Redis memory, lag) → Overview banner + Scanner page panel. Uncaught bugs are logged
  and survived (exit only after 5/min). `scripts/diagnose.sh` on the VPS prints everything needed.
  auto-update.sh keeps `.deployed-sha` and retries failed builds; passes GIT_SHA into the image.
  WebSocket heartbeat 20s + client backoff reconnect.
  auto-update reloads Caddy when the Caddyfile changes.

## Open items / next steps
0. **Owner asked:** once the bot shows steady paper profit over time, proactively present the next plans
   (Phase 4 live execution with a small dedicated wallet, Phase 8 ML model, Phase 5 controls polish, paid data).
1. Verify on the VPS that hybrid trade stream flows (`tradesPerMin` in hundreds+). If Solana's public
   node throttles, consider a cheap paid stream.
2. Phase 8 ML model (XGBoost) once a few weeks of clean labelled data exist.
3. Phase 5 controls page (pause/kill switch, sliders for every rule, keyword lists, manual sell,
   blacklist). Rules are already in `BotConfig` (runtime-config.ts) — UI + API needed.
4. Phase 4 live execution only after a week+ of profitable paper results, dedicated small wallet.

## Code map
- `src/scanner/` listeners (pumpportal, pumpfun logs), live-state (Redis ledger), registry, whale tracker
- `src/evaluator/` safety, market, wallet, social, fee estimator, scorer, evaluator (checkpoint queue)
- `src/executor/` paper executor, trader (entries/risk gates), sell-manager (exits)
- `src/learner/` observation logger (TimescaleDB snapshots), trade logger
- `src/api/` Fastify + JWT + WebSocket; `dashboard/` React app
- Config defaults: `src/config/default.ts`; DB schema: `src/db/schema.prisma`

## Conventions
- `npm test` (vitest) and `npm run typecheck` must pass before pushing; dashboard: `cd dashboard && npx tsc -b`.
- Commit to the branch above and push; never commit secrets.
