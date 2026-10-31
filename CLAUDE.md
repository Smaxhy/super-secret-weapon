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
- **v15.6 (Oct 19): risk modes for the bot account** (owner: "I need a lot more, at least 10%+"). `RISK_MODES`
  (practice.ts): normal 1% / 30× / 8 open / ccy cap 2.2% / 3 per strategy; aggressive 3% / 100× / 12 / 6.6% / 4;
  max 5% / 200× / 15 / 11% / 5 (sure-trade cap 2 / 5 / 8%, fast-chart caps 1m 2-3-4, 15m 3-5-6). Stored on the bot
  account (`riskMode`, kept across a reset); `syncBot` uses `limitsFor(a.riskMode)` for base risk, leverage, every cap.
  Same strategies + checks in every mode. API POST `/api/forex/bot/mode` {mode}; GET `/api/forex/bot` returns
  `riskMode` + `riskModes`. Honest test levels now 0.5 / 1 / 2 / 3 / 5% — 3% and 5% use the aggressive / max limits.
  Dashboard Auto-bot card "How hard it trades" (3 buttons, each mode's honest-test month avg / worst month / biggest drop).
  Owner told: 10%/month needs ~3% risk a trade, and losing months scale the same way.
- **v16 (Oct 19): quant pack + sniper, forex first** (owner: "do it all … make forex the priority, crypto in the
  background, I need forex to improve A LOT"; built in the order a quant desk would: data → engines measured one by one →
  sniper last, only if proven). No OANDA (owner won't send ID) — every new source is free with no account.
  - **Crypto in the background**: migration v56 (create) — `ta.labEnabled` false, `tournament.enabled` false,
    `outcomes.maxPerTick` 40, `outcomes.altVariants` [] (crypto still paper-trades and learns; the heavy research jobs
    that shared the CPU with forex are off / slower).
  - **Dukascopy** (`src/forex/dukascopy.ts`, npm `dukascopy-node` 1.50.0 pinned, MIT, no install scripts): hourly bid +
    ask candles for every traded market + strength cross → Redis `fx:bars:dk:<id>` [t,o,h,l,c,spreadPips], first pull
    `DK.historyDays` 1100 back in 90-day pieces, then the newest days every 6 h (`fx:dk:meta`, 24 h freshness). The lab
    `stitchHistory` puts the older bars in front of Yahoo's (FX only — metals are futures on Yahoo; only when the seam is
    within 0.4%) → ~3 years to test on. **Real spreads** (`src/forex/spreads.ts`): median close spread per UTC hour
    (newest 120 days) → `spreadMultAt` = typical retail spread × (that hour ÷ the median hour), 1–6×, ×4 after the
    weekend; used by the engine and the practice account's synthetic Yahoo spread. Without a profile: the old rollover ×3.
  - **Macro** (`src/forex/macro.ts`, Redis `fx:macro`, 12 h): CFTC Traders in Financial Futures (Socrata
    `publicreporting.cftc.gov/resource/gpe5-46if.json`, fallback the weekly `FinFutWk.txt`): leveraged funds' net ÷ open
    interest per currency, public from the Friday 20:30 UTC after the Tuesday (`cotPublicAt`); `cotScoreAt` = rank within
    its own last 156 weeks (−1…+1, ≥ 26 weeks); pair score = base − quote (USD 0, metals NaN) → `ctx.ext.cot`. BIS policy
    rates (SDMX CSV `WS_CBPOL`, monthly, in force from the next month) → `carrySeries` (base − quote %, metals −USD) →
    `ctx.ext.carry`. Feed URLs unverified from the sandbox — Setup → "Extra data" shows what arrived / failed.
  - **Option expiries** (`headlines.ts` `parseExpiries`, `nyCutOn`, `currentExpiries`): ForexLive "FX option expiries"
    posts → pair / level / size (bn) / 10:00 New York cut. Live-only (no history) → heatmap + display, never a tested rule.
  - **Quant readings** (`src/forex/quant.ts`, causal, O(n), in `buildCtx` → `ctx.quant`): `volF` HAR volatility forecast
    ratio (fixed 0.4 / 0.35 / 0.25 day / week / month weights, nothing fitted), `hurst` (variance ratio, 120 bars, k 8),
    `z120` / `hl120` / `m120` (OU z-score, half-life, mean of the log price).
  - **Filters** (filters.ts): `volf` (trend / breakout need volF ≥ 1, fades ≤ 1.05), `hurst` (trend ≥ 0.52, fades ≤ 0.48),
    `crowd` (no long when positioning ≥ +1.2 of ±2, no short ≤ −1.2). 9 filter variants now.
  - **Strategies** (+7, all graded by the lab like the rest): `mom_blend` (1 / 5 / 20-day returns all agree, slow),
    `carry_trend` (rate gap ≥ 1% + 5-day trend turns its way, slow), `vol_breakout` (volF ≥ 1.25 + 20-bar break),
    `stat_arb` (only `STAT_ARB_PAIRS` EURGBP / AUDNZD / EURCHF: |z| ≥ 2.2, half-life ≤ 60, Hurst < 0.5, target the
    mean), `round_break` / `round_fade` (Osler: stops beyond / take-profits at big figures; `roundStep` 100 pips, JPY 1.00,
    gold $10, silver $0.50), `cot_squeeze` (crowded positioning ≤ −1.5 / ≥ +1.5 + 5-day trend turns, slow).
    **New traded markets AUDNZD + EURCHF** (removed from STRENGTH_PAIRS; 14 markets).
  - **Sniper** (`src/forex/sniper.ts`): votes at the signal close = `agreeCount` (4 market checks) + `extraVotes`
    (momentum blend, carry, volF / Hurst fitting the style, not crowded, room to the next round number ≥ 1 ATR) + judge
    points (top 30% / 10%). `gradeSniper`: K picked on the FIRST 70% (25+ trades, ≥ 0.25R, best R/trade), active only if
    unseen K+ trades made ≥ max(0.3R, all + 0.25R) with PF ≥ 1.5 on 15+ trades. Active → `LabOpenTrade.sniper.on` → the
    bot risks `SNIPER.riskPct` 8% (× drawdown factor, never under the mode's base) at 200×, past the currency cap, one
    sniper position at a time (`PracticePosition.sniper`); plan line "SNIPER trade". Redis `fx:sniper`, report `sniper`,
    portfolio `sniped` row (PTrade `sniper` skips the ccy cap, one at a time). `/api/forex/bot` → `sniper`.
  - **Heatmap** (`src/forex/heatmap.ts`, `MarketNow.heat`): levels within 4 hourly ATRs (round / half figures, swing
    clusters, yesterday H / L, today's expiries; weight 1–5) + read (positioning, carry, volF, Hurst, sniper checks long /
    short). Dashboard: market drawer "Heatmap", Auto-bot "Sniper" card + honest-test sniper row, Setup "Extra data".
  - Report `extFeeds` {dukascopy meta, spread profiles, macro now, history start}. Synthetic e2e: 14 markets × 9k bars ≈
    13 s per hourly run in the sandbox (3 years real ≈ 2×). tests/forex-v16.test.ts (20). Verified on SYNTHETIC data only.
- **v17 (Oct 19): data you can trust, a bot that can't be fooled by a dead feed, and its own R ledger** (owner: "make it
  work without the crazy APIs, make it learn, another level"; designed by a 4-spec design + critic workflow, saved at
  `/tmp/claude-0/v17design.json` in the session that built it; build order = the critic's).
  - **v17.0 data correctness** (one re-pick event — expect filter / exit / verdict picks to shift once after deploy):
    Dukascopy `volumes: true` (the library's flat filter needs the volume column — before, every weekend / holiday hour
    was stored as a flat filler candle in front of Yahoo's history), weekend hours + the forming bar dropped, stored rows
    cleaned on load (`cleanDk`), 45 s timeout per request (`withTimeout`). **Purge** at the 70/30 boundary: the first
    70% only holds trades FINISHED before it (`statsOf` exitT < oosFrom; `JudgeRow` / `ConvRow` / `SniperRow` carry
    `exitT`, `doneBefore`; the judge's inner train/valid split is purged too); out-of-sample = entered after it. Judge
    `prior` = the strategy's record so far (mean R of its trades finished before this one opened, NaN under 5) instead of
    its whole first-70% average (that held the trade's own result). `paperSince` (lab.ts): a Redis error throws (no more
    "forward test restarted"), missing → SET NX, garbage → repaired. `Practice.load` throws on a Redis error / bad JSON
    (it used to return a fresh $1,000 account the next save wrote over the real one); `checkOpen` checks each account in
    its own try. NY clock by arithmetic (`nyOffsetMs`, verified vs Intl 2015–2030; Intl cost ~50 µs a call).
  - **Bot-account safety**: no close is ever booked at a made-up price — no live price → `PracticePosition.closePending`
    {reason manual / signal / weekend}, closed by `tick` at the first real price (a pending close at the Friday flatten
    finishes as its own reason, never resumed; a pending weekend close becomes a resume item); weekend flatten uses the
    last price seen; no margin call while a market has no quote. `Quote.stale` (cached fallback), Yahoo `priceT` =
    `regularMarketTime`, `delayMs` = `exchangeDataDelayedBy` (COMEX metals ~10 min: hourly / 4h trades may use it via
    `feedDelayOk`, 1m / 15m never); `quoteAge`; `BOT.quoteAgeMsByTf` (1m 2 / 15m 5 / 1h + 4h 10 min) for new trades.
    `syncBot(…, { pairsSeen })`: a held trade on a market the lab had no fresh candles for is KEPT (logged once).
    Stale prices never close anything (`pxNow`). New opens skip when the price is past the target or moved >
    `BOT.maxEntryDriftR` 0.3R its way since the lab's fill (`LabOpenTrade.entry`). A weekend re-open that fails on a
    price hiccup is retried (4-day limit). Lab run errors logged + `ForexLab.lastError` (`/api/forex/bot` `labError`).
  - **v17.1 bot R ledger** (practice.ts): `riskUsd0` = USD lost at the stop measured on the real fill in `openIn` (a
    resumed weekend leg keeps the original); `recordTrade(…, { ref, riskUsd0, why })` → `PracticeAccount.ledger`
    per `strategy:tf` [closedAt, usd, R, ref, why] (60 / 120 days; why 0 stop 1 target 2 signal 3 stop-out 4 weekend
    5 manual). `ledgerRows` / `ledgerSummary` / `Practice.botLedger()`; `/api/forex/bot` `ledger`. Trades opened before
    v17 have no R (null) and are ignored by learners. This is the only never-rewritten record of what the bot did.
  - **v17.3 feed health** (`src/forex/feeds.ts`): `feeds` singleton FeedBook (Redis HASH `fx:feeds`, loaded in index.ts,
    saved after each lab run / at stop): per feed okAt / fails / error / items / asOf; per-provider breaker (3 fails in a
    row → pause 2 / 4 / 8 / 16 / 30 min, a success closes it). Reporters: Yahoo hourly (`refreshSeries`), fast candles,
    quotes, OANDA, Dukascopy, CFTC, BIS, calendar, headlines, both labs. `feedHealth` → GET `/api/forex/feeds` (+ data
    ages per market 1h / 15m / 1m, calendar blind, lab error) → Setup card **Data feeds** (`components/FxFeeds.tsx`).
    `src/forex/freshness.ts`: `lagBars` (bars missing on the market clock; metals' CME halt hour skipped), `dataAgeOf`,
    `staleReason` → a market ≥ 2 candles behind (1m: 3) gets no NEW bot trades (hourly lab `this.dataAge`, fast lab per
    chart + `FRESH.bookMaxAgeMs` 150 min on the hourly read). Yahoo: 10 s timeout, the hourly refresh is a pool of 2 with
    a 120 s budget (`refreshAll`; was 27 serial calls → up to ~18 min when Yahoo hung). Macro: `retryHours` 2 after a
    failure (was 12), BIS errors only cleared when THIS attempt got rates, `cotOkAt` / `ratesOkAt`, age limits in history
    AND live (`cotMaxAgeDays` 17, `rateMaxAgeDays` 100 → NaN; cotSeries cache key includes it). Calendar: ok / fail +
    `blind()` (newest event in the past or no good load for 8 days) → dollar pairs / metals wait out 08:25–08:50 and
    09:55–10:15 New York on weekdays (`blindNewsBlock`). Headlines: HTTP errors and 0-item pages count as failures.
    tests/forex-v17.test.ts.
  - **v17.4 learning** (all graded on unseen weeks before it touches anything live):
    - **Rolling picker** (`src/forex/rolling.ts`): each week (weeks start Sunday 00:00 UTC, `weekOf` / `weekStart` in
      portfolio.ts) keeps the strategy × chart rows whose trades CLOSED in the last 26 weeks made money (`shrunkR` = ΣR ÷
      (n + 20) ≥ 0.03, n ≥ 12, PF ≥ 1.1) + `botAlways`; sizes from that record. Graded on the unseen weeks after a 1-week
      gap, traded together like the bot (`gradeRolling`), vs the list picked once and vs 100 random pickers
      (`randomPickerNull`, cached weekly in `fx:roll:null`); `rollingVerdict`: on with 26+ weeks, money made, PF ≥ 1.1,
      beats 80% of random, drop ≤ 1.25× the static one; stays on while > 0 and beats 60%. Once on, the LIVE chooser is
      its list (`ForexLab.chooser` 'rolling'; else the unseen-30% verdicts). The week keeps its list (`fx:roll:picks`).
      `fx:roll` report; `fx:chosen:hist` = point-in-time history of the chosen list (500 changes). Auto-bot card "What
      it learned this week" (+ the bot's own R record). Hourly 15m / 1m charts don't use it (history too short).
    - **Luck meter** (`src/forex/luck.ts`): an Edge / Maybe row is compared with 20 twins that keep its exact stops /
      targets / exits / filter / costs but fire at random times (signals circularly shifted, never a whole number of
      days, stops / targets rebuilt in ATRs); a row whose unseen avg R ≤ the twins' 90th percentile becomes 'no'
      (`luckDowngrade`). Heavy (0.4–2.5 s a row) → weekends only (`applyLuck`, `fx:luck`, recomputed when > 6 days old
      or the 70/30 line moved 14+ days), applied every hour while the row keeps the same filter + exit. Rows carry
      `luck` {pctl, twinsP90, twinPassPct}; Strategies badge "beats N of 20 random". The rolling picker never reads it.
    - **Correlated-risk cap** (`src/forex/risk.ts`): EWMA correlations of hourly returns (half-life 240 h, ρ = 0 under
      200 joint returns, snapshot each 22:00 UTC, `corrAt` = what the bot knew then); heat = √(r'Cr) of signed stop-
      risks; `maxRiskUnder` = room left. Honest test row "with the correlated-risk cap" (`simulatePortfolio` `heat`,
      cap = `RiskLimits.heatCapPct` 3 / 9 / 15%, a trade cut below 40% is skipped); `gradeHeat`: on only if the plain
      bot's biggest drop ≥ 5% and the cap cut it 15%+ without costing > 5% return per unit of drop. Live (`syncBot`
      `heat`, `ForexLab.heatNow`, both labs) only while on; sniper trades stay outside it. `fx:heat` (grade + ρ matrix).
    - **Restricted learner** (`src/forex/learner.ts`): reads ONLY the bot's R ledger; per strategy:tf a skeptical mean
      (as if 8 more break-even trades; R capped ±3; manual closes / unknown R / > 120 days ignored) and P(real mean > 0):
      off below 20% (10+ trades), half size below 40% (6+), back only above 50%. It can never switch on or size up.
      Wired in `ForexLab.botRecord()` → `dropped` + `down` (sizes in both labs) + no ×1.15 "proven" while not on;
      state changes go to the bot log; `fx:learn`.
    - Synthetic e2e (14 markets × 12.4k bars): weekday hourly run ≈ 37 s (first run of a week builds the random
      pickers), Saturday run with the luck meter ≈ 52 s. tests: forex-rolling, forex-luck, forex-risk, forex-learner,
      forex-v17b.
    - **Judge quant inputs** (judge.ts, +8: `volF`, `hurst`, `ouZ` (side × OU z120), `carry`, `cot`, `mom3` (1 / 5 / 20-day
      momentum on its side), `roundAtr`, `costR` (spread at that hour ÷ stop)) with a **presence mask**
      (`presenceMasks`, per chart × metal group = `judgeGroup`): a feature known in < 90% of the group's training trades
      is blanked in training AND the exam (so "feed missing" can't stand for an older era); one known in ≥ 90% is
      REQUIRED live — `judgeView` → missing → the trade WAITS ("the signal judge can't score it: missing …"; before,
      an unscorable signal passed). `judgeKeeps` for the honest-test "judged" row and conviction cuts.
    - **Missing filter inputs** (filters.ts `missingInput` + `filterCoverage`): a row tested WITH a filter whose data is
      missing at the signal bar (but was there for ≥ 80% of the first 70%) → `LabOpenTrade.dataWait` → the trade
      waits (both labs). Positioning on metals (never there) never blocks. Backtests unchanged.
    - **Dukascopy fill** (`src/forex/fill.ts` `fillFromDk`, `dukascopy.ts` `refreshDkTail`): currency pairs (traded +
      strength crosses) whose Yahoo hourly candles are ≥ 2 behind (market open) or thin (< 400) get Dukascopy's last 3
      days (each ≤ once / 10 min, 60 s budget, breaker), then hours missing from Yahoo in the last 14 days are filled
      where the sources agreed before the gap (≥ 6 shared hours in the 3 days before, median |Δclose| ≤ 3 pips /
      0.04%); with < 400 Yahoo bars the Dukascopy series alone. Metals never (futures vs spot). Fills are rebuilt each
      run, never written into Yahoo's store; `DataAge.source` / `filled`. tests/forex-fill.test.ts.
    - **Review fixes (v17.4d)**: the random pickers now draw only rows that could be picked (12+ trades) and size them
      with the real picker's rule (else the yardstick was easier); their cache key = graded weeks + the rows' trades
      closed before the last graded week ends (`nullKey`); the week's sizes are frozen with its list
      (`RollPicksState.sizes`); live heat cap runs AFTER the currency cap at full size (the test's order) and counts
      each open trade at the risk it opened with; `gradeHeat` hysteresis; learner: an off key stays off until its
      chance passes 50% (no off ↔ half flapping), `fx:learn` loaded before the first `botRecord`; luck: shift ≥ 16 weeks
      (`LUCK.minWeeks`; clears the longest look-back + hold) and a stored result older than 14 days / from another
      70/30 line is not applied.
  - **v17.2 offload** (OFF by default — `FX_LAB_WORKER=on` in the VPS .env switches it on): `ForexLab.run` = `computeRun`
    (everything but the bot) + `syncFrom` (the bot account, always in the main process). With the flag on,
    `lab-runner.ts` `forkLabRun` forks `dist/forex/lab-worker.js` (`--max-old-space-size=900`, `serialization:
    'advanced'`, `NODE_OPTIONS` cleared, 15-min timeout) once per hourly run: the child loads feeds / spread profiles /
    cached calendar + headlines (`loadCached`), reads the bot's record read-only, runs `computeRun`, and hands back the
    `RunOutput` + `WorkerState` (markets, mood, ATRs, chosen list, chooser, data ages, learner, heat ρ, MarketBook for
    the fast lab, bot-log lines it collected) + its feed reports (`feeds.merge`). Could not START → this hour runs
    inline; started then failed / timed out / OOM → the hour is skipped (`lastError`). v17.7: a LIGHT failure (it threw /
    its result couldn't come back) 2 hours in a row → the next 6 runs inline, then the child again (`planLabRun` /
    `afterLabRun`); a HEAVY one (timed out, out of memory, killed — `ForkOutcome.heavy`, `memoryError`) is only ever
    skipped. Breakers go to the child and come back (also from a failed run); the child exits on IPC 'disconnect'. Verified on a local
    Redis: identical rows / verdicts / chosen list inline vs worker, parent heap 38 MB. The "forex lab run done" log
    line now carries heapMb / rssMb — read it on the VPS (`docker compose logs bot | grep "forex lab run done"`)
    before switching the worker on (the bot container's cap is 2 GB: main heap + 900 MB child must fit).
  - **Account realism + backup prices**: `Quote.bars` may carry the minute's open (Yahoo / OANDA) → a stop / target the
    price GAPPED past fills at that open, not the level; the minute still forming is re-checked next tick (`checkedT`
    only moves past complete minutes). Yahoo price fails → currency pairs take Dukascopy's newest complete 1-minute
    candle (`dkQuote`, real bid / ask, cached 30 s, breaker, feed `dk-quotes`, `Quote.source` 'dukascopy'); metals never.
  - **v17.7 review fixes** (independent review of the judge / fill / worker batch, then each fix adversarially checked):
    Dukascopy: a store that doesn't reach `historyDays` back (e.g. started by the lab's 3-day tail fetch) is back-filled
    newest piece first from its oldest bar; `DkMeta.ids[id]` `full` / `tries` / `note` — marked full only once the
    store reaches back or 3 back-fills in a row brought nothing older (the library swallows HTTP errors, so "no error"
    proves nothing); until then the market shows as an error on the Setup card. Tail fetch: each call gets at most the
    remaining budget (`DkTimeoutError`). Judge: `JUDGE_SOFT` (mood, carry, cot) are never hard requirements — a
    **backup judge** trained with them blanked (own pickiness, own unseen exam, kept only if it passes;
    `JudgeModel.fallback`, `JudgeReport.fallback`, JudgeCard line) scores a signal live when only those are missing,
    else it waits as before; `judgeView` → {p, missing, threshold, via} and every caller compares p with that row's
    threshold; pickiness picked only on rows the model can score live (`pickKeep`); conviction cuts skip unscorable
    rows (`judgeScores`). Fast charts: filter-input coverage measured on each chart's tested first 70% at the :31 test
    and stored in the fast report (`testedCoverage` / `liveCoverage`; old reports → the old live-window rule); 15m
    live window 2,300 bars (the vol forecast's month of warm-up). `missingInput` ignores mood on pairs the mood filter
    can't block (`moodCanBlock`, EURGBP / AUDNZD). Worker: the parent keeps its own learner if it moved while the child
    ran and tightens the child's dropped / chosen / open trades to it (`learnerSource`, `learnerTighten`,
    `tightenState`, `tightenOut`). Training time ≈ 1.5–1.8× (two judge models). tests: forex-dk-backfill,
    forex-judge-fallback, forex-coverage, forex-worker-fixes.
  - **v17.8 (owner: "see much easier if the bot is in a trade, the active trade and its graph, a PnL and calendar view")**:
    durable close log per account (Redis list `fx:pnl:<acct>`, newest 20k: every close incl. parts / weekend legs /
    stop-outs, written in the same MULTI as the account save → never doubled or lost; backfilled once from the 200-row
    closed list, so "All time" only reaches back that far for old accounts; reset clears it). `src/forex/pnl.ts` (pure:
    `dailyPnl`, `periods`, `equityCurve` ≤ 600 points, `dayTrades`, `pnlReport`, `botStatus`); routes GET
    `/api/forex/pnl?acct&tz`, `/api/forex/pnl/day?acct&day&tz`, `/api/forex/bot/status`. Dashboard: Auto-bot opens with
    `BotHero` ("In N trades" + open P&L + one row per trade), `FxActiveTrade.tsx` (live candles 1m/5m/15m/1h with entry /
    stop / target / price-now lines (MarketChart `tradeLabels` / `entryMarker` / `tradeAnchor`), pips to stop / target,
    the plan lines, Close now, Bot ⇄ TradingView), `FxPnl.tsx` (Today / week / month / all-time tiles, balance curve,
    Monday-first month calendar, tap a day → its trades); header pill "● N open +$X" (`FxTradesPill`, App.tsx). Fixes
    from the integration review: the main judge's `active` is decided on a MAIN-ONLY exam (the backup can't flip it;
    `report.withBackup` display-only; the honest-test "judged" row ignores the backup); Dukascopy saves merge with what
    is stored at save time (`saveMerged`) and the tail fetch never throws away a fetched bid / never fails the feed for
    our own budget; stored filter / exit picks carry their `oosFrom` and are ignored after the 70/30 line moved back
    > 1 day (`prevPicks`; old format → one re-pick after deploy), same for the fast charts; a worker run tightened to the
    parent's learner re-notes the chosen history. tests: forex-pnl, fx-dashboard-trade, forex-lab-hysteresis.
  - **v17.9 Pyth live prices** (owner: "see the price actively change … trade really fast when live";
    `src/forex/pyth.ts`, `pythLive`, started in index.ts): Hermes SSE stream (`hermes.pyth.network`, free, no account),
    feed ids resolved by symbol once a day (direct / inverse / via the USD legs), newest price per feed, 1-minute candles
    from ticks, back-off + 60 s watchdog, feed 'pyth-live'. Currency pairs only (metals are tested on COMEX futures;
    Pyth's are spot). Practice `quote()`: live Pyth first for currency pairs (synthetic spread `syntheticHalf`, its own
    1-minute candles for stop / target checks, day change from Yahoo's previous close read in the background ≤ every
    30 min; `Practice.live` is swappable for tests), else Yahoo → Dukascopy → stale cache as before; the stop / target
    check runs every 5 s while prices flow (`flowing`), else every 15 s, never two at once. Account view positions carry
    `pnlPerPx` (USD per 1.0 move of the exit price, also on `/api/forex/bot/status`). `src/forex/live-push.ts`
    `startLivePush`: the last second's ticks per pair → bus event `{ type: 'fx', data: { t, px: { PAIR: [mid, bid, ask,
    priceT] } } }` (WebSocket), at most 1/s, only when something moved. Dashboard `hooks/useFxLive.ts` (live P&L =
    pnlUsd + (live exit − px) × pnlPerPx). tests: forex-pyth, forex-live, fx-live.
  - **v17.10 faster live prices** (owner: "the chart changes but the price doesn't, way faster, less than a second"):
    bot push every 200 ms (`LIVE_PUSH_MS`, was 1 s), dashboard re-renders up to 10×/s (`RENDER_MS` 100, was 500),
    practice stop / target check every 1 s while Pyth flows (was 5 s). **Backup in the browser**
    (`dashboard/src/lib/pythDirect.ts` `PythDirect`): when the bot's 'fx' push is quiet > 4 s (or never came: Pyth down
    on the VPS, older server, socket down) and the page is visible, the page opens Hermes SSE itself (Hermes CORS is
    permissive), same feed plan as the bot (ported `planFeeds` / `compose`, plan cached a day in localStorage
    `fx.pyth.plan`), bid / ask from the bot's last spread per pair else the typical spread; closed once the bot's push is
    steady 20 s, or the page is hidden (every Hermes message carries a several-KB signed blob — too heavy on a phone).
    `FxLive.src` 'bot' | 'direct' → LIVE badge tooltip. Display only: the practice account still fills at the BOT's
    price. tests/fx-live-direct.test.ts.
  - **v17.11 (owner: "live ticking is down"; "it's not actively trailing its stop-loss closer: TP +30 €, at +10 € the
    stop moves past the buying price so we always sell in profit")**:
    - **Pyth needs an API key** since Aug 2026 (Hermes answers 401 without `Authorization: Bearer`; Pyth Terminal, free
      trial then paid plans from ~$500/month) — so v17.9 / v17.10 never got a price. `pythLive` now only starts with
      `PYTH_API_KEY` (VPS .env; `PYTH_HERMES_URL` overrides the endpoint); feed card shows it 'off' without one. The
      browser Hermes backup (v17.10 `dashboard/src/lib/pythDirect.ts`) was removed (keyless = useless).
    - **Yahoo live stream** (`src/forex/yahoo-live.ts` `yahooLive`, the streamer finance.yahoo.com and yfinance use:
      `wss://streamer.finance.yahoo.com/?version=2`, `ws` client, origin finance.yahoo.com; {subscribe: [EURUSD=X …]}
      re-sent every 15 s; messages {type:'pricing', message: base64 protobuf PricingData} — `decodePricing` reads id 1,
      price 2 (float32 → rounded to a tenth of a pip), time 3 (sint64 ms), prev close 16, bid 23, ask 25). Currency
      pairs only. A price counts as live 90 s after it last arrived (Yahoo sends changes only); watchdog reconnects
      after 90 s of silence while forex is open; back-off 1 s…60 s; feed 'yahoo-live' (provider 'yahoo-stream', so the
      REST breaker is separate). `src/forex/live-feed.ts` `liveFeed` = the freshest of [pythLive, yahooLive]
      (`get` adds `source`) → `Practice.live`, `startLivePush`. Quote.source 'yahoo-live'. UNVERIFIED from the
      sandbox (can't reach Yahoo): Setup → Data feeds "Live ticking prices (Yahoo stream)" says whether it works.
    - **Profit lock** (`src/forex/profit-lock.ts`, `PROFIT_LOCK` {atFrac ⅓, gapFrac ⅓, keepFrac 0.1}): D = entry →
      target (no target: 2 × the stop distance); at ⅓ D its way the stop jumps to entry + costs + 0.1 D, then trails
      ⅓ D behind the best price, only ever tighter (`lockPlan`, `lockedStop`). Engine (`SimOpts.profitLock`, DEFAULT
      on): on the candle high / low, then only the rest of the candle can hit it (green long: its close; red: its low);
      exits 'breakeven' / 'trail'. EVERY backtest / paper / honest-test trade includes it → one re-pick event after
      deploy. Lab: each row is simulated once more without it (`Row.noLock`) → `summarizeLock` → report `lock` →
      Strategies card "Your profit lock" (with vs without, first 70% / unseen, and for the traded rows). Practice
      `tick(a, q, now, mv)`: positions get `lock` (worked out on the first check from entry / target / stop + half
      spread; null = none), `locked`, `lockBest`, `stopMovedT` (in the minute the stop moved, only its close counts
      against the new stop — the forming minute is re-checked every second); `mv.moved` → the account is saved on
      silent stop moves too. Bot account always on; owner's own account `PracticeAccount.profitLock` (missing = on),
      POST `/api/forex/practice/lock` {on}, "Profit lock" switch on the Trade-by-hand ticket (with the pip / $ example);
      a TP / SL edit re-plans it unless armed. Plan lines k 'lock'; badges "profit locked"; dashed amber lock line on
      the active-trade chart. tests: forex-yahoo-live, forex-profit-lock.
  - **v17.12 (owner: "active updates if a trade is doing really good"; "where do I get the APIs for Pyth")**:
    **Phone alerts** — practice.ts `notice` / `takeNotices` (per account object, published by `save()` once the
    account is written → bus `{type:'fxTrade', data: FxNotice & {acct}}` (lib/bus.ts `FxNotice`): 'lock' (profit lock
    armed), 'run' (⅔ of the way to the target, once — `PracticePosition.alerts` bits 1 / 2), 'close' (every finished
    trade, total incl. parts; weekend pauses / parts excluded). lib/push.ts `fxMessageFor` + settings `fxGood` /
    `fxClose` (default on; losses follow `lossClose`, off) → Controls → Alerts toggles; tapping opens /forex (bot) or
    /forex/practice. **Pyth key on the dashboard** — Setup card "Pyth live prices" (`components/PythCard.tsx`): GET /
    PUT `/api/forex/pyth` {key | clear}: `testPythKey` tries `PYTH.bases` (`PYTH_HERMES_URL`, the upgraded Hermes
    `https://pyth.dourolabs.app/hermes` (from Mysten's deepbook-v3 SDK `PYTH_UPGRADED_HERMES`), then
    `hermes.pyth.network`) with `Authorization: Bearer`; the first that lists currency pairs is saved in BotConfig
    `_pyth` {key, base} (DB only, masked on read) → `setPythConf` + `pythLive.restart()` (generation counter: an old
    loop never runs on after a restart). At start `loadPythConf()`; a .env key finds its endpoint first. The owner
    pasted a key in chat — it was NOT put anywhere; they paste it into the card themselves. tests:
    forex-alerts-pyth-key.
  - **v17.13 charts (owner: "graphs are pretty broken, small and messy, hard to follow")**: `MarketChart` places
    candles side by side by INDEX (`xOfTime`: candle i covers [i, i+1) slots from its open; a time in a closed-market
    gap sits on the border; after the newest candle it carries on) — before, x was clock time, so a weekend squeezed the
    candles into slivers at both edges; `barStep` = median gap; closed-market breaks (> 3 candles and > 2 h) = faint
    dashed line; `axisLabels` (weekday when the day changes, dates on 4h+, repeats dropped) — before, the same date
    printed on top of itself; `fitBars` (≥ 5–6 px a candle → a phone shows the newest ~48–60). Every bot chart now draws
    at the real width (`hooks/useWidth.ts`, shared): active trade (phone 320 px tall, 48+ candles), Markets drawer and
    Trade-by-hand "Bot's view" (both were an 800-px viewBox shrunk to the phone → ~5 px text; now timeAxis +
    crosshair). `TvChart` `compact` (the active-trade card on a phone): no top / side toolbar, date ranges, legend,
    volume — the candles get the box (440 px); the card's own 1m / 5m / 15m / 1h buttons set the interval. Legend
    "profit lock" key. Verified by rendering the chart (esbuild + Playwright) at 376 px. tests/fx-chart-axis.
  - **v17.14 live trade read + AI read (owner: "an active diagnosis of what the goal of the trade is, or an AI that
    scans all active trades and actively analyses the price action")** — DISPLAY ONLY, nothing here touches a trade.
    `src/forex/trade-read.ts` `liveRead` (pure, free, per request): goal sentence (strategy, chart, target / stop in
    pips), pips from the entry (+ = its way) for now / target / stop / lock / best / worst, progress %, moves over 5 / 15
    / 60 min from the quote's 1-minute candles, best price + minutes since, pace → ETA to the target, thesis check by
    `styleOf` (trend / pullback: the trade's chart trend from `MarketNow.mtf`; revert: has the price turned), nearest
    level ahead / behind (drawings within 1.5 hourly ATR), news ≤ 2 h (`ForexCalendar.upcoming`), and ONE status
    (`READ`: closing > near_target ≥ 80% > near_stop ≥ 75% of a losing-side stop > pressure (under water and the last
    15 min ≥ 0.35 hourly ATR / 0.3 stop distance against it, or the thesis broke) > locked > early < 5 min > stalling
    (no new best for max(15 min, ¼ of the usual hold), < half way, only when the candles reach the best) > on_track >
    holding). `src/forex/trade-ai.ts` `TradeAi`: one Claude call per trade (`AI_TRADE_MODEL`, default
    `claude-haiku-5-5`, ~$0.001 a read; no server-side fallback param for Haiku; `stop_reason` refusal → none),
    structured output {verdict on_track / watch / at_risk, headline, read, watch ≤ 3, confidence 1–5}; input = trade,
    live read, trend / RSI / strength gap / levels within 2 ATR, 24 hourly + 12 quarter-hour candles + 30 minute
    closes, news 6 h (`buildTradePrompt`). `aiDue`: new trade at once, then every `FX_AI.everyMin` 15 (env
    `AI_TRADE_EVERY_MIN`) while forex is open, sooner (≥ 5 min) when the status turns near_stop / pressure /
    near_target / locked. Caps: 60 an hour, `AI_TRADE_BUDGET_USD` 0.5 a day (`fx:ai:spend:<day>`, also added to
    `ai:spend:<day>`); the owner's "Ask AI now" skips both (≥ 60 s apart per trade); `AI_TRADE=off` switches it off; no
    `ANTHROPIC_API_KEY` → none (the live read still works). Reads in Redis `fx:ai:read:<acct>:<posId>` (3 days) with the
    last 8 headlines (`history`). `src/forex/trade-watch.ts` `TradeWatch` (index.ts, every 60 s, both accounts, one call
    at a time; `Practice.openNow(acct)` values open trades without saving) + `readContext`. API GET
    `/api/forex/trades/read?acct=bot|me` {trades: [{id, pair, read, ai}], ai status}, POST `/api/forex/trades/ai` {id,
    acct}. Dashboard `components/FxTradeRead.tsx`: Auto-bot active-trade card → "Live read" (goal, stop ← entry →
    target track with price / best / lock, 5 / 15 / 60-min move tiles, notes, why it took it) + "AI read" (verdict,
    headline, read, watch list, confidence dots, how the read changed, Ask AI now, spend today); status chip on the
    header rows; Trade by hand → a chip under each open trade opens the same panel. tests: forex-trade-read,
    forex-trade-ai.
  - **Price stretch** (`src/forex/stretch.ts`, no outside feed): per currency the 63-day return in normal-move units
    (averaged over its pairs, ≥ 3 pairs), ranked within its own last ~2 years (520 days, ≥ 120 ranked) → −1…+1; a
    pair = base − quote (−2…+2, the CFTC score's scale; metals none; > 4 days old → none). `MarketBook.stretch`
    (`buildStretch(strengthInput)`), `ctx.ext.crowdPx` / `FilterEnv.crowdPx` via `makeSeries` (both labs). Uses:
    filter `stretch` (no long ≥ +1.2, no short ≤ −1.2; 10 filter variants now), strategy `stretch_squeeze` (copy of
    `cot_squeeze` on it, ±1.5, slow), a sniper vote ONLY when the CFTC reading is missing (never both), heatmap read
    `stretch`. It follows price, so it can't see positions that differ from price (what CFTC adds). Causal (a bar only
    sees days that ended by its close). tests/forex-stretch.test.ts.
- **v18 (Oct 19): quant core** (owner: "a lot more precision, more strategies, a serious quant accuracy level, look online
  for projects, build what you need"). Research = a 7-agent workflow (Carver / pysystemtrade, López de Prado AFML, regime
  literature, FX factor evidence: Lustig–Roussanov–Verdelhan carry, Moskowitz–Ooi–Pedersen TSMOM, the fx-factor-strategies
  and g10-systematic-fx replications, execution engines LEAN / backtrader / freqtrade / Jesse / vectorbt / nautilus); the
  sandbox could only reach github.com (every paper host DNS-blocked), the synthesis + verification agents hit the session
  limit, so the five research reports were used directly (transcripts under the session's workflows dir). Everything is
  picked on the FIRST 70% and graded on the unseen 30%; nothing new trades live. Expect ONE re-pick event after deploy
  (financing changes every tested trade a little).
  - **Honest statistics** (`src/forex/stats.ts` pure: normCdf / normInv, Sharpe + its SE, PSR, Deflated Sharpe
    (Bailey & López de Prado 2014: E[max SR of N no-edge trials] = √V·((1−γ)Φ⁻¹(1−1/N)+γΦ⁻¹(1−1/(Ne)))), MinTRL, CSCV
    PBO (16 blocks, 12,870 splits), White's Reality Check + Hansen SPA with a stationary bootstrap (block ≈ T^⅓,
    400 draws); `src/forex/honest.ts` `honestStats` → report `honest` {trials, varSr, expectedMaxSr, pbo, spa, note},
    `Row.stats` {sr, dsr, psr, n, …}; **`dsrDowngrade`**: an Edge row whose deflated Sharpe < 50% (given every row
    graded on the same unseen weeks) becomes 'no' with the reason in `why` (synthetic run: 7 of 10 Edge rows).
    Strategies page: "Is the lab fooling itself?" card (`HonestCard`) + badge "real N%" per row.
  - **Regime model** (`src/forex/hmm.ts`: 2-state Gaussian HMM on hourly returns, Baum–Welch with scaling, states
    ordered by σ, fitted on the bars BEFORE each series' 70/30 line, causal forward filter after; `Series.hmm`,
    `attachHmm` / `applyHmm`; the fast lab stores the models per chart in `FastReport.hmm` for the live pass) → filter
    'hmm' (filters.ts: wild state ≥ 0.6 → no trades; fades need quiet ≥ 0.35; trend needs quiet < 0.8; 11 filter
    variants now, input `hmmHi`). Synthetic: picked by 0 rows (no regimes in synthetic data) — real data decides.
  - **The desk** (`src/forex/forecast.ts` + `desk.ts`, Carver / pysystemtrade): continuous forecasts per market —
    EWMAC ladder 2/8 … 64/256 (÷ price-change vol), breakouts 10 … 320, carry (policy-rate gap ÷ σ%, EMA 90),
    acceleration — scaled to |avg| 10 and capped ±20 (scalars = the expanding cross-market median on the fit window,
    frozen at its end; fixed fallbacks when the history is short), an SR-cost speed limit (0.13/yr: a rule whose
    costs eat that much Sharpe is dropped on that market), FDM / IDM = min(1/√(w′Cw), 2.5) with negative ρ floored,
    vol targeting 20%/yr, ±10% trade-to-edge buffer, gross leverage ≤ 20, daily decisions at 22:00 UTC filled 2 h later,
    USD conversion through the traded pairs. `deskFromBars(h1ById, macro, oosFrom, equity)` → Redis `fx:desk`,
    report `desk`, `/api/forex/bot` `desk`; both halves graded (days, finalX, SR, max drop, cost %/yr, turnover,
    weekly stats) + a 13-week block-bootstrap Monte Carlo of the unseen weeks; `now[]` = today's forecast / notional
    per market. **Graded only** — no desk trade is placed; the gate for wiring it into `syncBot` later: unseen
    positive, SR ≥ 0.5, drop ≤ 25%, ≥ 26 unseen weeks. Auto-bot card "The desk" (`DeskCard`).
  - **Entry-timing lab** (`src/forex/entries.ts`, engine `SimOpts.entry`): the same signal, filter and exit with a
    different way in — market (next open + half spread, = the bot), limit at the signal close (one bar), pullback
    (¼ ATR back, three bars), confirm (next bar closes its way → the following open). Fill rules as LEAN / backtrader /
    freqtrade: a limit fills at its price when the bar reaches it, at the open when the open is past it, never on the
    signal bar, cancelled at expiry or a weekend gap; the risk (1R) is measured from the actual fill; a signal on the
    last bar is an 'open' trade only at market. Lab pass 3 → `Row.entryVariants` (incl. unseen TOTAL R — a limit that
    fills fewer trades can win per trade and still earn less), `summarizeEntries` → report `entries`; Strategies page
    "Does entry timing help?" (`EntriesCard`) + "Ways in tried" in the drawer. **Graded only**: the practice account
    has no resting orders yet, so the bot keeps entering at market until that exists.
  - **Overnight financing** (`src/forex/financing.ts`; the carry literature's whole return IS the interest
    differential, and the engine had none): per bar held the engine accrues (side × carry − markup)% × bar / year of
    the price on the open share (`Trade.fin`, inside `r`; `SimOpts.financing` default on; carry = `ctx.ext.carry`
    from the BIS policy rates, metals pay −USD, unknown = 0); `Row.fin` {inAvgR, outAvgR, known}, `summarizeFinancing`
    → report `financing` → Strategies card "Overnight financing" + a line per row. Practice accounts (both): `tick`
    books each daily roll (17:00 New York via `rollsBetween`, Wednesday ×3) since `swapT` at the current mid into the
    balance and the position's `bankedUsd` (so the trade total, ledger and alerts include it) + `swapUsd` for display
    (Trade-by-hand row, active-trade badge); an unknown rate leaves the rolls owed until known; `Practice.carryFor` is
    set by the lab (`syncFrom`, `carryAt` on its macro book). Markup `FX_SWAP_MARKUP_PCT` (VPS .env, default 0.75%/yr
    either way — brokers don't publish theirs).
  - NOT built (the research's next items, each needs its own grading): carry sleeves (TS / cross-sectional carry with
    the Menkhoff global-FX-vol gate; dollar carry = the 7 USD legs as ONE basket bet past the per-currency cap), TSMOM
    the documented way (always-in, vol-scaled — the desk's EWMAC ladder is that in continuous form), resting limit
    orders on the practice account, hysteresis + dwell on the hmm gate, BOCPD / CUSUM change-point filters, a
    random-veto twin test for filters (the luck meter for filters), a measured per-pair × hour stop-slip profile.
  - Tests: forex-stats (8), forex-hmm (4), forex-honest (5), forex-desk (8), forex-entries (11), forex-financing (9).
    Synthetic e2e (14 markets × 12.4k bars, in-process): hourly run ≈ 46 s. Verified on SYNTHETIC candles only — read
    the real cards on the VPS; the first run after deploy re-picks filters / exits once.
- **v18.1 (Oct 19): the "Today" brief** (owner: "$50+ a day, 2 good trades at 3%; I need to know what the bot's thinking,
  what trades it's leading into; the new features are hard to index"). Told plainly: $50/day on $1k = 5%/day — only the
  aggressive / max risk modes make a $50 day possible and losing days scale the same. `components/FxBrief.tsx`: the
  Auto-bot page now opens with **Today** — a daily goal (localStorage `fx.goal`, default $50; tap to change) with today's
  bot P&L / trades / wins from `/api/forex/pnl` and a progress bar, what a winning trade pays in each risk mode (risk% ×
  equity, the low end of a 1–1.5R winner), which way it leans (plan `markets[].lean` as badges), "closest to a trade"
  (plan signals with tone 'wait' + why), open trades one line each with the next exit rule, next look. The research
  cards (rolling picker, sniper, conviction, honest test, desk, risk, how it trades) are folded under "Under the hood"
  (`AdvancedFold`, remembered in `fx.adv`). Display only.
- **v18.2 (Oct 19)**: Forex → **Lab** tab (`components/FxLab.tsx`, route `/forex/lab`, on the phone bar in place of Paper
  results): one list of every self-test (strategy exam, honest stats, checks, exits, profit lock, entry timing,
  financing, judge, weekly picker, conviction, sniper, desk, correlated-risk cap) with live / testing chips + its
  number, then all the research cards (moved off the Strategies page, which is the table only). Forex menu's System
  entry reads "Crypto scanner". **Crypto stall** (owner: 52 coins checked in 7 h at 7,500 trades/min; VPS: bot 1.44 GB
  of 2 GB, Redis 85% CPU, no errors; the deploy restart cleared it): `index.ts` checker watchdog — ≥ 10 launches/min
  and 0 evaluations for `CHECKER_STALL_MIN` 20 minutes in a row → WARN event `checker_stalled` + clean `shutdown`
  (Docker `unless-stopped` restarts it). Owner told to set `FX_LAB_WORKER=on` in the VPS .env (forex lab in its own
  process) — check `docker stats` after. Root cause not proven: heap pressure (forex lab in-process) is the suspect.
- **v18.3 (Oct 19): look & feel** (owner: "revamp the entire app layout, give forex a different colour than crypto, much
  more appealing, easy to navigate"; also "install these design skills"). Skills vendored into `.claude/skills/`
  (frontend-design, Vercel web-design-guidelines / react-best-practices / composition-patterns / react-native-skills,
  UI/UX Pro Max (`uipm-*`), Bencium UX designer + design audit, AccessLint audit/fix/scan/inspect/diff; the catalog
  equivalents were offered to the owner's account). Theme (`dashboard/src/index.css`): the cream + terracotta base is
  gone (the frontend-design skill lists it as the commonest generated-page tell) → cool graphite base, light + dark;
  **desk colours** via `data-ws` on `<html>` (set in `Shell`): Forex teal (#0e7c86 / dark #33c9c0), Crypto ember
  (#d2611a / dark #ff8a3d) — every `--accent*` token follows, so the whole app recolours with the desk; `.desk-band`
  = a 2 px desk-coloured hairline under the top bars; the Forex | Crypto switch fills the active desk in its colour;
  the desktop title row carries a "Forex desk" / "Crypto desk" chip; sidebar / More-sheet group labels are sentence
  case (all tracked all-caps micro-labels across the dashboard were replaced by `text-xs font-semibold text-muted` —
  12 files); card radius 12 px (hero 18). Forex → **Lab** got **"The playbook"** (`FxLab.tsx` `Playbook`): every
  strategy grouped by family (trend / breakouts / mean reversion / candle patterns / session timing / news shocks /
  linked markets / flows & positioning / yardstick) with its plain-words rule and a chip per chart (Edge / Maybe / no,
  ring = the bot trades it now, from `/api/forex/bot` `chosen`). The Today card is the hero (`hero-glow card-accent`)
  and survives a P&L report without `periods`. Verified by building the dashboard and screenshotting it with
  Playwright (phone 390 px + desktop 1440 px, light + dark) against a stubbed API (scratchpad `shots/shoot.mjs`).
- **v18.4 (Oct 19): resting limit orders — the entry lab goes live** (owner: "build the last feature"). `entries.ts`
  `chooseEntry` (FIRST 70% only, like filters / exits): a limit / pullback entry replaces the market entry for a
  strategy when it filled ≥ half the signals there and made more TOTAL R by max(0.5R, 10%) and more per trade;
  hysteresis on last hour's pick (`fx:filters:chosen` picks now {f, e, n}); 'confirm' is graded but never live.
  `FX_CONFIG.liveEntries`. Lab: pass 3 keeps each variant's trades; a row with `entry ≠ market` takes that variant's
  record / paper trades / onStrategy trades (judge, conviction, honest stats see them), while the signals on the newest
  bar stay market 'open' trades carrying `LabOpenTrade.order` {kind, limit (mid: signal close − ¼ ATR for a pullback),
  until (signal + 1 / 3 bars)} (built in computeRun next to `toLabTrade`). Bot account (practice.ts): `RestingOrder`
  (`PracticeAccount.orders`, ExitPlan + margin / leverage / risk / conviction / sniper), `syncBot` places one instead of
  opening when the price hasn't reached the limit (same caps, sizing at the limit price; counted in `held`, per-strategy
  and per-chart caps; already at / through the limit → market fill as before); cancelled when the lab's trade is gone
  (`pairsSeen` guard as for positions), at expiry, and at the weekend flatten (`checkOne` now ticks accounts with only
  orders); `tick` fills on the 1-minute candles like the backtester (`fillOrder`: a buy at the ask = low + half spread
  ≤ limit → at the limit, or at the minute's open when it gapped past; a gap through the stop / target → dropped with a
  reason; no margin → dropped). Fast charts (15m / 1m) stay market entries. Dashboard: Today card "Orders waiting to
  fill", Strategies row badge with the way in. tests/forex-orders.test.ts (5) + chooseEntry tests. Synthetic e2e:
  pullback won on 86% of rows there (noise mean-reverts) — real data decides which strategies actually switch.
- **v18.5 (Oct 19): a lab that can't go quiet** (owner: "it hasn't made any decisions for 6 hours"; suspect: `FX_LAB_WORKER=on`
  with the v18 lab bigger than the child's 900 MB heap → every hour skipped). lab-runner.ts: a HEAVY child failure (timed
  out / out of memory / killed) now counts (`WorkerStreak.heavy`): the next child gets `LAB_WORKER.heapMbRetry` 1300 MB
  (`heapFor`), a second heavy failure in a row trips the same inline fallback as light ones (`heavyBeforeInline` 2 →
  `inlineRuns` 6 in the main process); every heavy failure is written to the bot log ("hourly test skipped: …"). The
  Today card shows a red line with `labError` (from `/api/forex/bot`) whenever the last run failed. If the VPS log shows
  the child OOM at 1300 MB too, switch the worker off (`FX_LAB_WORKER=off`) and let it run inline. tests updated.
- **v18.6 (Oct 19): feed-page truth** (owner's Setup → Data feeds: Dukascopy "0 bars · 0 failed · 0/22 markets, never",
  "15m / 1m test run: never" while its card said "last test 14 min ago"). VPS log (`FX_LAB_WORKER=on`): the hourly run
  works in the child (116 s, child heap 253 MB, parent 517 MB; `edges: 0` on real data = the honest statistics
  downgraded every Edge row → the bot trades Maybe rows + botAlways only). Fixes: `probeDukascopy` (one tiny request to
  datafeed.dukascopy.com before a history refresh; a network error / 403 / 429 / 5xx is reported as the feed's error in
  words — dukascopy-node answers a blocked host with an EMPTY result and no error) and an empty answer for an empty
  store is recorded as an error (retried every 6 h); the fast lab reports `fast-lab` ok / fail. Lab page phone layouts:
  the three summary tables are stacked blocks on a phone (`SummaryList`), financing card without a truncating tile,
  two-line desk holdings; the Lab self-test list is stacked rows.
- **v18.7 (Oct 19): slow charts only + cooling-off** (owner: 1-minute trades opened and closed within 2 minutes — "it's holding
  for way too little… no one fast-trades slow charts, they wait it out, then adjust"). `FX_CONFIG.botFastCharts` false: the
  fast lab (fast.ts `decide`) hands its 15m / 1m trades to `syncBot` with `chosen: false` (manage what the bot still holds,
  open nothing); the charts stay lab-tested (Strategies / Lab) and the plan marks their signals "lab only: the bot trades
  the hourly and 4-hour charts" (`PlanInputs.fastCharts`). `BOT.reentryCooldownBars` 3 + `reentryWait(closed, strategy,
  tf, pair, now)` (practice.ts): after a strategy finishes a trade on a market (partial / weekend rows don't count) the
  same strategy may not re-enter that market for 3 candles of its chart (3 h on 1h, 12 h on 4h) → syncBot wait "just
  closed a trade here — cooling off N min". Auto-bot "How it trades" text updated. tests/forex-v18-7.test.ts (4).
- **v18.8 (Oct 19): the 1-minute trades never happened, 1-minute chart off** (owner: "revert those 2 trades as if it never
  happened… revert the profit back to when it was up 33; I do NOT want to see it trade forex 1 minute; look all day for
  entries on the 4-hour or hourly, stick to the trade"). `undoChart(a, tf)` (practice.ts, pure): strikes every trade of
  one chart from an account — closed rows (their USD taken back out of the balance; peakUsd lowered by removed gains),
  open positions, resting orders, weekend pauses, the chart's `stats` / `ledger` keys; `Practice.undoChart(acct, tf)`
  also rewrites the durable P&L log (`fx:pnl:<acct>`, rows with that tf dropped) and saves. Run ONCE at start:
  `oneTimeUpgrade('v18.8-undo-1m')` → bot account, '1m' → bot log line "1m chart struck from the bot account: …".
  `FX_FAST.tfs` = ['15m'] (fast.ts): no 1-minute candles, test, timers or trades at all (put '1m' back to test it; the
  bot still wouldn't trade it — v18.7 `botFastCharts`); `nextChecks` lists 15m / 1h / 4h; dashboard chips and the
  Setup candle card drop 1m. tests in forex-v18-7 (two tests switch the chart on for themselves and restore it).
- **v18.9 (Oct 19): always-on strategies rest while they lose** (owner: "you're the manager, change what you need"; the
  rolling-picker card on real data: +4.1% over 30 unseen weeks, beat 93% of random pickers, PF 1.02 → still off; the
  always-on four (tsmom, tsmom_long, local_hours, fix_flow) sat at PF 0.81–1.02 over 26 weeks while MACD cross / news
  fade / stocks→yen / month-end carried the list). `ROLL.alwaysMinPf` 1.0 (rolling.ts): `picksFor` drops an always-on
  row whose last 26 weeks hold 12+ trades with PF < 1.0 (`alwaysPausedBy`); `alwaysPaused(rows, week)` →
  `RollReport.thisWeek.paused` [{key, n, pf}]; the random pickers' fixed set follows the picks. Live chooser (lab.ts,
  verdict mode): botAlways keeps a 'no' row only while not paused; one bot-log line per rest (`pausedNoted`). Dashboard
  card "What it learned this week" lists the resting always-on rows. Fewer than 12 trades → published evidence keeps it.
- **v18.12 (Oct 19): the Today card can't go blank** (owner: "I don't see the Next look area"). `/api/forex/bot`: `buildPlan`
  in a try/catch → `planError` (also 'forex lab not running' / 'bot account unreadable'); the route no longer 500s on a
  plan bug. `FxBrief`: "Next look" always shows (`localNextLook`: the next 1h / 4h close + 90 s on the UTC grid when the
  server's plan is missing); a red line says why there is no plan (`planError`), or that the page failed to load
  (`useApi` `error`, which FxBot had ignored), or that the first hourly look since the restart hasn't finished.
- Owner wants weekly / monthly big returns; told plainly that only leverage makes that and the risk table shows the cost.
  Live forex needs an account (Hyperliquid / Ostium on-chain perps, or a broker API) — only after Edge + paper agree.

## v28.16 funding carry test + 12 strategies from go-trader's list (Oct 31, owner: "build it" after a full read of
github.com/richkuo/go-trader — Go + Python bot, MIT; its own registry marks ~70 strategies no_edge; NOT installed or run, ideas
only, written fresh). (1) `src/forex/carry.ts` (pure): hold N coins + short N on the perpetual (price moves cancel), collect
funding while the 7-day average funding (annualised) ≥ the entry threshold, out under the exit threshold; costs spot 0.1% +
perp 0.045% + 0.02% half spread per leg per side, 2× perp leverage (liquidation past entry × (1 + 1/lev − 2% mmr) → 1% fee,
re-entry later); return on capital (spot + margin). Rule picked on the FIRST 70% of the funding history (one rule for every
coin, `CARRY.entryApy` 5…50 × `exitShare` 0 / 0.5, ≥ 60 days in), graded once on the last 30%; verdict edge = ≥ 26 unseen
weeks, ≥ 3%/yr unseen, first part positive, half the coins positive. NOT modelled: perp − spot basis, Hyperliquid's own
funding (we read Binance / Bybit), moving money between accounts. Coin lab `computeRun` → Redis `cm:carry`, report `carry`;
Lab page card "Funding carry" (`components/FxCarry.tsx`) + a self-test row. TEST ONLY — nothing trades it. (2) 12 strategies
(`src/forex/ta-extra.ts` indicators, memo per Ctx, causal; families trend / reversion / breakout / volume): `heikin_ema`,
`vortex_cross`, `aroon_trend`, `kama_trend`, `trix_zero`, `awesome_zero`, `elder_ray`, `fisher_turn`, `connors_rsi`,
`mfi_turn` (volume only), `camarilla`, `dual_thrust` — every chart / market, graded like every row (provenOnly unchanged:
only Edge rows trade); the no-peeking test covers them. Expect ~15% longer lab runs until retirement skips the ones with no
promise. tests/forex-carry (5).
## v28.15 the history download no longer waits 6 h between pieces (Oct 30, VPS read 19:35 UTC: the 18:58 run filled the
newest 180 days of gold / silver / EURUSD, then its 3-min budget ran out; the other 6 pairs had 0 bars — at one run per 6 h
the back-fill would take ~4 days). databento.ts `everyMs(meta)`: a run every `catchUpHours` 1 while any market is not
`full` (or was never fetched), else `everyHours` 6; `budgetMs` 3 → 8 min a run. Spend still priced per request and capped
at `DATABENTO_MAX_USD`. tests/forex-databento (+1).
## v28.14 more history: CME currency futures for the dollar pairs + gold / silver unstuck (Oct 30, owner: "you're allowed
to download lots more data")
VPS read 12:44 UTC: Databento held NDX / SPX / DJI back to Oct 2023, RUT to May 2024 (not full), gold / silver 0 bars (no
error); Dukascopy blocked (AWS WAF) → every currency pair on Yahoo's ~2 years only. Cause of the 0 bars: one pass per run in
a fixed order with a 3-min budget — the earlier markets' back-fill used it up before gold / silver started. databento.ts:
(1) two passes — catch every market up to Databento's newest hour, then back-fill the market with the least history first.
(2) `DATABENTO.symbols` + the 7 dollar pairs as CME currency futures (6E EUR, 6B GBP, 6A AUD, 6N NZD, 6J JPY, 6C CAD,
6S CHF; `invert` USDJPY / USDCAD / USDCHF); bars keep the contract (`DbBar.iid`, 7th stored column) → `backAdjust`
(ratio-adjusts everything before a roll, jump ≤ `maxRollJump` 3%), `invertBars`, `stitchSpot` (scaled onto Yahoo's first
spot open when within `maxSpotGap` 3%, volume dropped). lab.ts `filledBars`: FX pairs use Dukascopy when it has bars, else
`stitchSpot` → the 7 dollar pairs get ~3 years like the indices / coins (crosses stay on Yahoo's 2). Expect ONE re-grade on
those pairs and a ~20% longer forex lab run; a few cents of Databento credit. Futures trade 23 h a day (the CME halt hour is
missing in the older part). tests/forex-databento (+2).
## v28.13 deep review: the lab's profit lock invented ~0.1R a trade; luck test fixed; coin bot = sure setups only, proven size
(Oct 30, owner: "very deep analysis … trade way less, closest to 100% win rate, high account size maybe 20%+" → chose "proven
size, cap 10%" + "only the sure setups"). VPS deep read 09:54 UTC (970ce58): coin 4h tight-lock rows showed 80–89% wins at
+0.1…+0.2R (avg win ≈ +0.33R, avg loss ≈ −1R) while their RANDOM-timing luck twins with the same exits also made ≈ +0.11R
(round_break / inside_bar / trendline_break / williams_r 4h downgraded to 'no' by the luck meter); coin bot's own closes since
Oct 20: 89 trades, its stops −9.95R, the owner's manual closes +7.2R; shadow book 179 refusals +81R (lab R).
(1) **Engine lock bias** (engine.ts): after the lock moved the stop on a candle's best, the rest of THAT candle was assumed
to be only its close (green, long) / its low (red) — on a driftless random walk random entries with the tight lock tested at
+0.11R a trade (72% won) while the bot's real rule on the same minutes made −0.03R (55%). Now the moved stop counts from the
NEXT candle (its whole range, a gap at the open fills there) = exactly the bot's candle-close rule (v28.10). Parity test
tests/forex-lock-parity (lab +0.12 → ≈ 0 = bot). practice.ts: the v28.10 look-back close ("worst price after the best minute")
removed — the moved stop just applies from the next candle's minutes. EXPECT a big re-grade on both desks: every tight / loose /
step-lock row loses its phantom ~0.1R; many coin "high win rate" rows will fall to 'no'. The run-past-target conversion still
assumes green → close (smaller effect, once per trade) — not changed.
(2) **Deflated Sharpe on weeks** (honest.ts): it was the Sharpe PER TRADE with the luck bar from the spread of every row's
per-trade Sharpe — thin rows' noisy Sharpes set the bar, so rows with 1,000–5,000 unseen trades (t ≈ 9) read "0% real".
Now every row is measured on the same unseen weeks (weekly R sums) and the bar is the best of N no-edge rows' weekly Sharpe
(null variance 1 ∕ (T−1)). RowStat sr / srStar are weekly; dashboard texts updated. tests/forex-honest (+1).
(3) **Proven size** (lab.ts `provenSizePct`, `FX_CONFIG.provenSize` {kellyShare .25, z 1.2816, maxPct 10, minPct .5}):
`marketRecOf` → `marketRec.sizePct` when the cell passes `cellPass`: quarter Kelly with the win rate's 90% lower bound (Wilson)
and the avg win / loss implied by avgR + PF, ≤ 10%; `toLabTrade` allIn = that % (under provenOnly.riskPct 10; below 0.5% →
not very sure); syncBot sizes a very-sure trade to lose ≤ min(bigLossPct, its %) at the tested stop. Simulation shown to the
owner (100 trades, 85% / +0.33R / −1R): risk 10% → 2% chance of halving (23% if live is a bit worse); 20% → 49% / 86%.
(4) **`BOT.sureOnly` {cbot: true}** (practice.ts): the coin bot opens ONLY very-sure trades (Edge row + cellPass on that coin +
forward check → `allIn`); the rest is skipped "not a sure setup" (shadow book keeps scoring). Forex bot unchanged. Expect few
or no coin trades until rows re-grade on the corrected engine. tests/forex-proven-size (3).
## v28.12 step lock on coins: tight until +1R, then a wider trail (Oct 30, owner: "still going for short profits" → chose
"tight until +1R, then loose", lab-tested first)
VPS read 09:32 UTC (9596e0f): coin bot 5 closes since 02:00, −$20.09 — the two pivot_ladder:4h longs closed on their locked
stop at the 08:00 candle close (+0.03R / 0R; the lab's same trades +0.09 / +0.10R trail → the bot now matches the lab, the
tight lock itself banks small); the two round_break:1h shorts (opened 02:11 / 02:37, late full-run entries) were closed
'signal' at 03:08 when the lab's copies trailed out at +0.06 / +0.11R — at the bot's later entry that price was −0.35 /
−0.54R. profit-lock.ts `STEP_LOCK` {atFrac .15, gapFrac .15, keepFrac .05, wideAtR 1, wideGapFrac .25} + `LockCfg`:
`lockPlan` puts the wider gap in `plan.tight` from entry + 1 starting-stop distance (lockedStop never loosens the stop);
`LockKind` 'step'. lab.ts `FX_CONFIG.lockChoice.step` {fx false, crypto true}: coin rows are simulated with it too and
`preferStep` uses it when its FIRST 70% score (avgR × √n, ≥ 40 trades and ≥ ¼ of tight's) is ≥ the row's lock pick (kept
while within 5% / 0.1). Live: `lockKind` 'step' → practice uses STEP_LOCK; no spike sale on such trades. Badge "step
lock". Expect one coin re-pick event. tests/forex-step-lock (2), forex-lock-bars (+1).
## v28.11 the gates that kept lab winners out of the coin bot (Oct 30, owner's paper screen: donchian20:1h +23.8R / 136,
keltner:15m +22.9R, pivot_bounce:1h +20.5R … "do whatever you need to turn these lab results into live results")
VPS read 02:14 UTC: the coin bot opened 9 of 171 tradeable signals in 24 h; shadow book 179 refusals, 77% would have won,
+81.6R (daily cap +29.7R — old, cap off since v27.49; same-side cap +15.6R; late entries +14.3R; per-coin record +12.1R;
world-event pause the only one that saved money, −10.5R). (1) `BOT.liveBrake` since → 2026-10-30 02:20 UTC (both bots) and
`LEARN.since` (learner.ts, the same time): the bot's own trades before v28.10 ran a different exit than the lab graded, so
they no longer pause / halve / drop a strategy. (2) `BOT.maxSameSide.cbot` 1 → 2. (3) `FX_CONFIG.strict.coinPositive` {on,
minN 30, minAvgR 0.05, minPf 1.15 (break-even coins like BTC pivot_bounce +0.02R / PF 1.11 and ADA stay out)} + `coinPositive(cell)` (lab.ts): on coins `marketRecOf` also passes a coin where the strategy's
own unseen record is positive (the strict `cellPass` bar blocked donchian20 / donchian55 / round_break on coins at
+0.07…+0.17R, PF 1.18–1.36); `marketRec.strict` = cellPass → a very-sure (big, `allIn`) trade still needs the strict bar.
Not changed: 15m charts stay lab-only (owner, v27.43; keltner:15m is not graded Edge / Maybe), the late-entry drift check,
the world-event pause. tests: forex-learner (+1), forex-market-rec (+1), forex-strict, forex-proven-only.
## v28.10 the bot's profit lock trails on its chart's candles, like the lab (Oct 30, owner: "it sells immediately")
VPS read 02:04 UTC: coin bot 17 closes in 72 h, −$20.47; 14 stops of which 11 were locked-profit stops at +0.03…+0.17R
after 1–59 min (2 spike sales, 3 full −1R losses). The 5 closes with a lab twin: bot +0.21R a trade vs the lab's SAME trades
+1.88R (LINK donchian20 +0.17 vs +4.64, XRP psar_adx +0.11 vs +1.92, XRP round_break +0.15 vs +0.63, LINK round_break +0.06 vs
+0.31). Cause: the engine trails the lock once per chart candle (best = the candle's high / low; in the candle that set it,
only what came after counts), the bot trailed every 1-minute wiggle — on the 'strict' coin stops (≈ 0.45%) the tight lock's
0.3R gap is ≈ 0.13% of the price = noise. practice.ts `LOCK_BARS` {on} + `lockBarMs(p)` (bot trades with a lab ref on 15m /
1h / 4h; Kojiro copies and hand trades keep the minute trail) + `PracticePosition.lockBar` {t, o, best, after, bestT, c}:
`tick` arms the lock on the minute it gets there (alert as before) but leaves the stop where it is; when the candle ends
(first minute of the next one) lockBest takes the candle's best, the stop moves to `lockedStop`, and the trade closes (at
that minute's open) if the finished candle's close (it closed the trade's way) or its worst price after the best minute
(it closed against) is past the new stop. Coin rows' lab picks on the same read (first 70% / unseen avg R): tight beats
loose and off on all 11 chosen rows (e.g. donchian55:1h .13 / .21 vs loose .11 / .18 vs off −.05 / −.15) — the lock kind
was right, the live timing wasn't. tests/forex-lock-bars (3).
## v28.9 "sold into a spike" only on a real spike: +1R in 5 minutes (Oct 30, owner: "it's barely holding trades, it sells
immediately"; "perfect time to short — the market is crashing — yet the bot sells off within 3 minutes")
Coin bot Oct 30: 4 closes all small wins — LINK shorts 10.526 → 10.505 (+$5.92) and 10.582 → 10.560 (+$6.63) "sold into a
spike", ETH 2190.2 → 2187.0 and LINK 10.740 → 10.702 on the tight lock's stop. With v28.7's 8% size the spike exit's $5 floor
was met by a 0.2% move, and `jumpR` / `minR` 0.3 fired on normal wiggles. `SPIKE_EXIT.jumpR` 0.3 → **1**, `minR` 0.3 → **1**:
only a move worth a whole stop distance within 5 minutes, with the trade already +1R, is sold into. Still live-only, not
graded. The tight profit lock (lab-picked per row, v28.6) is unchanged — check the bot R vs the lab R of the same refs on the
VPS before touching it (the live lock reads 1-minute candles, the engine 1-hour ones). tests/forex-spike-exit updated.
## v28.8 his SIGNAL calls get their own size: 5% of the account, 10% once his record proves it (Oct 30, owner: "he also has a
1k balance, are we able to perform like this" → "what do you think is best")
Under the $20 cap a copy of his NQ call on the 0.5% safety stop (~148 points) was ~0.14 units ≈ $0.14 a point: his +130-point
long made ~$18 for us vs ~$260 on his 1 MNQ. discord.ts `DISCORD_COPY.callRiskPct` 5 (env `DISCORD_CALL_RISK_PCT`) /
`callRiskPctProven` 10 (`DISCORD_CALL_RISK_PCT_PROVEN`) + kojiro-study.ts `callRiskFor(card)` (pure): 10% only when his graded
record under the hold the bot uses (card.plans[card.best]) has 15+ calls at ≥ +0.1R a call with PF ≥ 1.3, else 5%.
handleSignal / catchUpFullCalls pass `callPct` → practice `copyOpen` risks that % of the account past the account's $ cap
and risk mode (still inside `riskPct` 20 for all copies together, fee checks, safety stop, copy lock). 5% ≈ $50 on $1k ≈
0.34 units ≈ $44 on a 130-point move; a stopped call ≈ −$50. Level trades (lab only) and the bot's own strategies keep the
$20 cap. Log line says which size and why. tests in forex-discord (+1).
## v28.7 the coin bot trades its risk mode's size again — no $20 cap; the open LINK short re-sized to 8% (Oct 29, owner:
"isn't this too little, only 1%?" → "it's still on turbo, shouldn't it be … not even 8%? raise it and change the current active
trade as if it was 8% too")
The coin bot's trades risked ~1.6% because the v27.95 $20 cap sized every trade under turbo's 8%. `BOT.maxLossUsdByAcct.cbot`
20 → **0** (no $ cap: `a.maxLossUsd` deleted by syncBot → no size-to-cap, no excursion caps, no tick trim) → turbo = 8% of the
account on the TESTED stop (very-sure trades keep `bigLossPct` 10%); the forex bot keeps $20. `copyOpen` on an account without
a $ cap risks at most the risk mode's base % (not his 20% budget). practice.ts `resizeBotTrades(a, pct, mids, pick)` (pure) +
`Practice.resizeBotTrades(acct, pct)`: open bot trades (lab ref, not Discord copies) get more units as if opened at `pct`% on
their ORIGINAL stop distance (`riskUsd0` ÷ units), own cap dropped, margin ≤ free × `allInMarginShare`, never smaller; a paper
adjustment (the open P&L counts the bigger size from the entry). One-time `v28.7-cbot-8pct` → cbot open trades at 8%, bot-log
lines "8% per trade (owner): …". A stopped coin trade now costs ≈ 8% of the account (~$88). tests in forex-loss-cap (+1);
forex-link-cap50 / forex-proven-only (cap mechanism tested with the cap set inside the test).
## v28.6 each strategy picks its own profit lock: tight / loose / off (Oct 29, owner's coin P&L screenshots: "high win rate but
the losses outweigh the wins by a lot")
Coin bot Oct 28–29: winners +$0.56…+$9.29 (all closed by the locked stop), losers −$17.90 / −$18.29 / −$51.98. With the v27.28
tight lock (arms +0.3R on a 2R target, trails 0.3R) a winner banks ≈ +0.15R while a loser costs −1R → it needs ≈ 87% winners
to break even. profit-lock.ts `LockKind` 'tight' | 'loose' | 'off', `LOOSE_LOCK` (= the Kojiro copy lock: arms ¼ of the way to
the target, trails ¼ behind, ⅕ → 15% past 60%), `lockCfgOf`. Engine `SimOpts.lockKind` (default 'tight'); trades carry
`lockKind` when not tight. lab.ts `evaluateTf`: after the exit pick, the row is simulated with the loose lock and with none
(the old `noLock` pass); `chooseVariant` keeps 'tight' unless another lock beats it on the FIRST 70% by the usual margin (last
run's pick `l` kept through near-ties, `fx:filters:chosen` picks {f, e, n, l}); a non-tight pick becomes the row's record /
verdict / paper / open trades and the entry pass runs with it (`FX_CONFIG.lockChoice.on`). `Row.lock`, `Row.lockVariants`;
Strategies badge "loose lock" / "no lock". Live: `LabOpenTrade.lockKind` → `planOf` → `openIn` / `fillOrder` →
`PracticePosition.lockKind` ('loose' → LOOSE_LOCK in `tick`; 'off' → lock null); quick look, fast lab, replay simulate with the
row's lock; the spike exit (v27.67, live-only, never graded) no longer sells a trade whose row picked loose / off. EXPECT one
re-pick event on both desks. The engine's lock on 1h candles is still a little kinder than the live minute checks.
tests/forex-lock-choice (3).
## v28.5 his calls copied right + the sweep-and-reclaim at his levels in the lab (Oct 29, owner: "make sure you are copying
it correct … levels and monitoring in LAB, signals insta trade"; screenshot: his NQ long 29,455.50 +527 ticks off his
"Monitoring 29,466.25" after a sweep to ~29,405; "so many good trades on his level and we are missing out")
VPS log check: Oct 28 "Fullport FOMC longs" + "shorts" were BOTH held open; "TP 782" / "TP1 806" ignored. (1) A call the other
way on the same market closes his earlier copy first (`copyClose` side −sig.side, log "closed his earlier …"). (2)
`parseSignal` kind **'target'** (a post starting "TP / TP1 / TARGET x") → `CopyBook.copyTarget` → the open copies' target
(`expandPrice`: "782" on 29,887 = 29,782; nearest with those last digits); a SIGNAL post's own TP is passed to `copyOpen` too;
his own calls keep the COPY_LOCK with a target (practice tick: only `…_levels` trades switch to PROFIT_LOCK). (3)
strategies.ts **`reclaimSignal`** (`SWEEP` {look 60, minAtr 0.1, maxPct 0.4, stopAtr 0.15}): the price came down into his
level from above, traded 0.1 ATR … 0.4% through it, and this candle is the first close back over it → long (mirrored), stop
0.15 ATR past the sweep low, target DOL / next level ≥ 1R; in `postedLevelSignal` after retest, before toward. (4)
`PostedLevels.added` = Monitoring prices; an edit of the same Levels post (same msgId) keeps them. (5) `LevelWatch.replayLab
(pair, fromT)` — a past stretch through the lab (rows' why "(replayed)"); one-time `v28.5-kojiro-levels-oct29`: his edited
Oct 29 list + the 3 Monitoring prices saved, minutes since 13:25 UTC replayed in the lab (90 s after start, retried while the
gap is unmeasured). Level / Monitoring trades stay LAB ONLY; SIGNAL posts trade at once. tests/forex-discord-edits (10).
## v28.4 all his calls copied again + his edited posts, "Monitoring" levels, one-off leans end with the session (Oct 29,
owner: "the bot seen these signals? … he is up 100 pips already"; "I want it to follow all his signals calls and trades")
VPS read 13:51 UTC: his 13:25 Levels post was saved as first sent (29,609.50 …) — he EDITED it (29,729.50, 29,785.25–29,788
added) and the copier never forwarded edits; his "Monitoring 29,635.25 / 29,466.25 / 29,563.50" posts were "not a trade
message"; the stored lean was still bearish from the Oct 28 "Fullport FOMC shorts" (a full call set it for 24 h).
(1) `DISCORD_COPY.live` default ON (env `DISCORD_COPY_LIVE=off` = lab only): every SIGNAL post from every channel is copied
(his-record gate, fee checks, $20 cap, safety stop, copy lock as before); level trades stay lab only (`DISCORD_LEVEL_TRADES=on`
to trade them; level lab +0.04R a trade on 36). (2) bot.py `on_message_edit` (only when the text changed) + the 2-min catch-up
forward edits (`SENT_EDITS`, body `edited` ms); server: seen key `<id>:e<edited>`, an edit only updates levels / plan /
monitoring — a trade is only ever copied from the post as first sent (log "edited post — …"). (3) `parseMonitor` ("Monitoring
X", 1–4 prices) → `savePosted(…, { add: true })` adds them to the day's plain level list. (4) `sessionEnd(t)` = next 17:00 New
York; a full-conviction call's lean carries `biasUntil` (loadLevels drops it after); a plan post has none (24 h). One-time
`v28.4-fullcall-bias-session` ends the Oct 28 FOMC lean. Copier must be rebuilt (auto-update does it). tests/forex-discord-edits (5).
## v28.3 Kojiro's elite-channel calls are always taken (Oct 29, owner: "always go for elite calls, calls in the elite signal
channel get prioritization and follow them correctly" — channel 1563800424769916968, already in the copier's channel_ids; the
copier sends `channel` with every post)
discord.ts `DISCORD_COPY.eliteChannels` (env `DISCORD_ELITE_CHANNELS`, default that id) + `eliteLive` (`DISCORD_ELITE_LIVE=off` =
lab only) + `isEliteChannel`: a SIGNAL open posted there is copied at once even while `DISCORD_COPY.live` is off, past
`kojiroGate`, up to `fullMaxAgeMs` 45 min late (copier catch-up), `copyOpen({ priority: true })` → its own room past the shared
copy budget ("already N% riding" never refuses it); the $20 cap (`capRiskUsd`), fee checks, safety stop and copy lock unchanged;
his exit / "SL to BE" posts close / move it as before. Log rows carry `channel` + `elite` ("his ELITE-channel call: copied …");
`catchUpFullCalls` also catches up elite rows (from now on — older rows have no channel). Other channels' calls stay lab only.
tests/forex-elite-calls (3).
## v28.2 the bot enters at the candle close, not 10 minutes later (Oct 29, owner: "crypto is performing bad again")
VPS read 11:31–11:33 UTC (0fea488): coin bot week −$25.68 on 17 trades (12 wins), today −$33.73; since Oct 28 18:00 six
closes −$82 (LINK pivot_bounce 1h −$51.98 opened 19:11 under the old $50 cap / no market bar; today DOGE pivot_bounce 1h
−$18.29 and AVAX breakout_retest 1h −$17.90, both strict-proven cells, normal losses — the live brake then paused
pivot_bounce:1h). The bot's own R ledger: 54 trades −9.4R, while the same rows test at +0.07…+0.13R a trade. Cause found:
every 1h / 4h trade opened 9–12 min after the close (the full hourly run's time) while the lab's copy entered AT the close;
of 17 losing bot trades with a lab twin, 8 ended flat / positive in the lab (lab trail / break-even exits: lab +0.22R /
+0.08R vs live −0.38R / −0.12R) — the price had already moved its way (armed the lab's profit lock) and back before the
bot got in. Fix: `QUICK` + `quickLookTrades` (lab.ts, pure) + `ForexLab.quickLook` (both desks, timer ~35 s after every
hour, parent process): newest candles refreshed (`refreshAll` 40 s budget, Hyperliquid tail for futures), the newest
`QUICK.bars` 2,600 hourly candles, and for last hour's chosen rows (`this.chosen`, minus dropped, forward check on the
report's paper rows) the same filter / exit / skipped slices simulated → trades whose signal is the candle that JUST
closed (≤ 15 min ago), handed to `syncBot(…, { openOnly: true })` (new practice option: opens / places orders only —
never cancels, trails, closes or resumes anything) with the same order (limit / pullback), market record, plan, second-
setup (mates = the chosen rows' open trades — stricter than the full run), dataWait, VIX brake, news / stale / heat gates.
The full run minutes later sees the same ref and manages it. Left to the full run (quick look stricter): rows whose filter
needs the hourly market read (`QUICK.filters` = none / mtf / regime / volf / hurst / absorb only), cross-market
strategies (`QUICK.skip`), a desk whose signal judge is active or whose clash rule is on, conviction / doubling-up sizes
(normal size). Bot log lines "at the close: …", timeline note "quick look at the close". The engine's lock (on the 1h
candle's high, rest of the candle only its close / low) is unchanged. tests/forex-quick-look (3).
## v28.1 the forex bot's trades copied to the owner's MT5 DEMO account (OANDA) through MetaApi (Oct 29, owner: "live trading
as well … my bot id 62586512, it's using MT5" → chose "Demo, with OANDA" + "MetaApi cloud")
The owner pasted their MT5 password in chat — it was NOT used or stored anywhere; they were told to change it. MT5 is Windows-only
and the VPS is Linux, so `src/forex/mt5-mirror.ts` talks to the account through MetaApi's REST API (endpoints read from
metaapi.cloud-sdk 29.3.4, not installed: provisioning `mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai/users/current/accounts/<id>`
→ region, `/users/current/servers/mt-client-api` → domain, client `https://mt-client-api-v1.<region>.<domain>/users/current/accounts/<id>`
`/account-information`, `/positions`, `/symbols`, `/symbols/<s>/specification`, `/symbols/<s>/current-price`, POST `/trade`
{actionType ORDER_TYPE_BUY / SELL, POSITION_MODIFY, POSITION_PARTIAL, POSITION_CLOSE_ID}; header `auth-token`; success codes
`OK_CODES`). The owner adds the MT5 account on metaapi.cloud (password there), then pastes MetaApi's API token + account id on
Forex → Setup → **"MT5 demo account (OANDA)"** (`components/Mt5Card.tsx`; GET / PUT `/api/forex/mt5` {token, accountId} | {on} |
{maxLots} | {scale} | {closeAll} | {clear}; BotConfig `_mt5`, masked on read; or `METAAPI_TOKEN` + `METAAPI_ACCOUNT_ID` in the VPS
.env). `Mt5Mirror` (index.ts, every 5 s): `planMirror` (pure) compares the forex bot account's open trades with Redis `fx:mt5:map` +
MT5's positions → open (only bot trades opened at / after `since` = when copying was switched on; size = units × `scaleOf`
('match' = MT5 equity ÷ bot balance) ÷ the symbol's contract size, rounded down to its step, ≤ `maxLots` 5 by default, under
the minimum → not copied), stop / target at the SAME distance from MT5's own fill (`mirrorLevels`; OANDA's CFD prices differ
from the bot's feed / futures prices), stop / target moves followed (≤ every 10 s, ½-pip tolerance), parts taken off
(POSITION_PARTIAL), closes; MT5 closing a trade by its own stop / target → row 'gone' (never re-opened); a failed open retried
after 5 min, 3 tries. `matchSymbol`: override → exact → suffixed (separator first, ".pro" over "m") → index names (`INDEX_NAMES`
NAS100 / US500 / US30 / US2000 …). **Demo only**: account-information `type` must be ACCOUNT_TRADE_MODE_DEMO, else copying
switches itself off. Coin bot not mirrored. Log lines "MT5 demo: …" in the bot log + `fx:mt5:log`. "Stop and close all" =
kill switch. UNVERIFIED against the real MetaApi (sandbox can't reach it) — the card shows what MetaApi answered.
Live charts: unchanged (v28 FastChart on the bot's own prices); an OANDA v20 token (not the MT5 password) still goes in the
"Live price feed" card. tests/forex-mt5-mirror (5).
## v28 a fast live chart instead of TradingView + Replay (FX Replay's idea, built in) (Oct 28, owner: "look into FX Replay as
well, I want the bot better and faster instead of TradingView" → chose both)
FX Replay (fxreplay.com) is a manual chart-replay website with NO public API — nothing to plug the bot into; its idea was built
on the bot's own data. (1) **FastChart** (`dashboard/src/components/FastChart.tsx`): TradingView's open-source Lightweight
Charts (`lightweight-charts` 5.2.1 pinned, Apache-2.0 — keep its attribution logo on; dep fancy-canvas, no install scripts):
canvas candles from the bot's own `/api/forex/candles` + the live 'fx' tick overlay, `update()` on a tick / new candle and
`setData()` only on a new market / candle size (`fitKey`), price lines (entry / stop / target / lock) kept in view
(`autoscaleInfoProvider`), markers snapped onto their candle (`snapTime`), times in the viewer's clock (`chartTime`), locale
guarded (`safeLocale`: headless Chromium reports "en-US@posix", which Intl rejects and blanked the chart). Active-trade card
(FxActiveTrade): views "Live chart" (default, 500 candles, 1m / 5m / 15m / 1h / 4h, scroll + zoom) / "Bot" (SVG);
`TvChart.tsx` (the TradingView iframe) deleted (`tvSymbol` stays in lib/markets.ts, unused). (2) **Replay**
(`src/forex/fx-replay.ts` pure + GET `/api/<desk>/replay?pair&tf=15m|1h|4h&from&to&pick=a,b`): one market's chart built like
the lab (`replaySeries`: the lab's own hourly bars from `lab.book.h1` incl. Dukascopy / Databento stitching, 4h from them, 15m
from the fast lab, same bigger charts), each picked row (`replayPicks`: the bot's live rows first, then Edge / Maybe / no by
unseen record; random never) simulated with its filter / exit / way in / costs and its skipped sessions / markets
(`replayTrades`, HMM fitted on the bars before the 70/30 line), trades ENTERED in the window, newest 3,000 candles
(`windowBars`); default picks = the live rows, else the top 3 non-'no'; ≤ 8 picks; one build at a time per desk, cached 5 min.
Dashboard Forex / Crypto → Deeper → **Replay** (`components/FxReplay.tsx`, route `/<desk>/replay`): market, candle size, length,
start date, strategy chips (● = trades now); player play / pause / step / next trade / speed 2–30 candles a second / scrubber;
the future stays hidden, open trades' entry / stop / target on the price axis, entries + results (R) as markers, tally (closed,
won, total R, R after the 70/30 line = the unseen part). Display / study only — touches no trade. Verified by rendering
(Playwright, scratchpad shots/replay28.mjs + harness/run.mjs, phone + desktop, light + dark). tests/forex-fx-replay (4).
## v27.98 very-sure trades go big: their tested stop may lose 10% of the account (Oct 28, owner: "if the bot is sure even
after all the checks … use like 10-20%" → chose "lose up to 10%")
"Very sure" = the row is Edge (strict unseen test incl. luck twins + deflated Sharpe) AND, under `marketMustPass`, the strategy
passed `cellPass` on THAT market (`toLabTrade` needs `marketRec.ok === true`) AND the forward check (already part of `chosen`).
Such a lab trade carries `allIn` = `provenOnly.riskPct` (20 → 10). syncBot: `BOT.bigLossPct` {cbot 10, bot 10} → the trade is
sized so its tested stop + round-trip fee lose ≤ 10% of equity × 0.9 headroom (`capRiskUsd`), opened with its own
`maxLossUsd` = 10% of equity (openIn now keeps `maxLossUsd` on all-in trades, so `tick` trims against that, not the $20);
ONE big trade open or waiting as an order at a time (wait "a very-sure (big) trade is already open"); resting orders
(`RestingOrder.allIn / maxLossUsd`) and weekend pauses (`ResumeItem.allIn / maxLossUsd`) keep it. Every other trade (Maybe
rows, forex cells, Kojiro copies) stays at the $20 cap. Bot log "VERY SURE (…): big size, its tested stop loses ≤ $X".
`bigLossPct` 0 = all-in trades back on the $20 cap. As of Oct 28 no row on either desk is Edge → nothing trades big yet.
tests in forex-proven-only (+1).
## v27.97 a strategy trades a market only where it proved itself on THAT market (Oct 28, owner: "stop trying to rush trades,
REALLY think every trade through with extreme caution, I don't care if it's once a day, I need results")
VPS read 20:42 UTC (coin bot): 11 Maybe rows chosen (all passed unseen PF ≥ 1.3 + the forward check), but a row approved on all
coins together traded every coin — trendline_break:1h's BTC cell is −0.04R / PF 0.85, ifvg_cisd:1h BTC +0.03R, pivot_bounce:1h
BTC +0.04R. `FX_CONFIG.strict.marketMustPass` {fx: true, crypto: true} + `marketRecOf(…, pair)` (lab.ts; both labs pass
`t.pair`): `marketRec.ok` needs `cellPass` on that market (30+ unseen trades there, +0.1R, PF 1.3, 20+ before the test line
and positive there, Monte Carlo 95%); no trial / work / owner bar stands in; `marketRec.why` → syncBot wait "its own record on
this market isn't strong enough (…)" (practice.ts uses `why` when set). On top of: the row's verdict (+ coin Maybe PF 1.3),
profit floor, forward check, second setup (confluence), judge, live brake, the $20 cap. `BOT.maxSameSide.cbot` 2 → 1 (one coin
trade per direction at a time — coins move together). Expect far fewer trades on both desks. tests: forex-market-rec,
forex-strict, forex-proven-only (maxSameSide rule tested at 2).
## v27.96 the $ cap trims a trade, never pulls its stop in; the two capped ifvg_cisd longs struck (Oct 28, owner: "wtf is this … remove
the 2 out of 3 and never let it happen again")
The v27.95 tick pull-in moved the stops of trades opened under the old $50 rules to ~⅓ of their tested distance: the coin bot's
BTC + LINK ifvg_cisd 1h longs (opened 20:11 / before the 20:16 deploy) were stopped at −$20.00 at 20:28 / 20:46 UTC by those
pulled-in stops; their tested stops (BTC ≈ 80,231) were never reached. practice.ts `tick`: when a trade's stop would lose more
than its cap (`p.maxLossUsd ?? a.maxLossUsd`; loss = price move + the position's round-trip venue fee + swap paid), the EXCESS is
sold at the market as a part (`closePart`, reason 'partial') so the part sold now + the rest at the TESTED stop lose ≤ cap ×
`sizeToCapHeadroom` 0.9 (`keep = (0.9·cap − lossNow) ÷ (lossAtStop − lossNow)`; already at the cap / keep < 5% → closed at
the market); the stop stays where it was tested; a trade without a stop gets one at the cap. Bot-log "X trimmed to N% so its
tested stop loses ≤ $20 (…; stop kept at …)". New trades never need it (syncBot / copyOpen size to the cap incl. the fee).
One-time `v27.96-strike-capped-ifvg` (index.ts): `undoClosed('cbot', ifvg_cisd 1h BTCUSD / LINKUSD stop losses closed Oct 28
20:16–21:30 UTC)` → refs on skipRefs; the −$51.98 LINK pivot_bounce short stays. tests: forex-loss-cap rewritten for trimming.
## v27.95 every trade capped at $20, fee included (Oct 28, owner: "why did the bot AGAIN allow a −$51.98 loss"; "cut it all on 20")
The −$51.98: the coin bot's cap was $50 (v27.78) and size-to-cap only counted the stop ($47.50), not the 0.045%-a-side coin
fee booked at the close. Now `BOT.maxLossUsdByAcct` {cbot: 20, bot: 20}; `capRiskUsd(cap, stopFrac, feeRate)` (practice.ts,
pure) = the most a trade may risk on its stop so stop + round-trip venue fee ≤ cap × `sizeToCapHeadroom` (0.95 → **0.9**,
room for a gap fill) — used by syncBot sizing (every trade incl. all-in) and by `copyOpen` (his SIGNAL calls, full-conviction
calls, level trades: min(his % budget, the $20 cap) — they were 20% ≈ $200 a stop). `tick`'s cap pull-in now applies to
EVERY position (all-in and his copies too, open ones included) and leaves room for the position's round-trip fee (and swap
paid): the stop sits at (cap − fee) from the entry (≥ ¼ of the cap). The excursion study's per-strategy cap can no longer
outrank the account cap (a $25 study cap used to give a trade $25). A gap through the stop can still book a little past $20.
tests: forex-loss-cap (+1), forex-proven-only / forex-link-cap50 / forex-discord / forex-discord-levels updated.
## v27.94 his full-conviction calls are taken, lab-only or not (Oct 28 ~16:00 UTC, FOMC day; owner: "Fullport FOMC longs is
also a call … make sure it happens at all costs")
discord.ts `fullCall(up)` → `parseSignal` returns {kind 'open', price null, `conviction: 'full'`, `event`} for "fullport /
full port / full send / full size / all in / max size … longs|shorts|calls|puts" and for event calls with the side next to the
event ("FOMC longs", "longs into CPI"; FOMC / CPI / PPI / NFP / PCE / Powell / Fed / jobs report / rate decision); no market
named → `POSTED_LEVELS.defaultPair` NDXUSD. NOT a call: negations / exits / recaps (no, not, don't, avoid, careful, closed,
exit, sold, covered, took, trim, flat, paid, profit, recap, won, lost…) or an event and a side far apart in a sentence.
handleSignal: a full call saves his lean (bias ±1) and is opened at OUR market price (no price of his → no mismatch check)
even while `DISCORD_COPY.live` is off and past `kojiroGate` (`DISCORD_COPY.fullLive`, env `DISCORD_FULLPORT_LIVE=off` = lab
only); late arrival allowed up to `fullMaxAgeMs` 45 min (others 10); same 20% / 0.5% safety stop / fee checks / copy lock as
his other calls. `catchUpFullCalls` (index.ts, 75 s after start, retried every 60 s ×6 while it can't open, e.g. no live
price): log rows of the last 4 h that the old parser marked "not a trade message" / lab only and that parse as a full call
now are taken at the market once (`fx:discord:fullcatch:<id>` NX), bot-log + copy-log line "posted N min ago, missed then —
taken now". tests/forex-fullport (3).
## v27.93 coins trade solid Maybe rows again (Oct 28, owner: "crypto will still trade solidly enough — check the past crypto
trades, turn the best strats on")
`FX_CONFIG.provenOnly.verdicts.crypto` ['edge','maybe'] + `maybeMinPf` {fx 0, crypto 1.3} + `verdictOk(universe, row)` (lab.ts,
used by the hourly chooser, the forward-check "held" list and fast `chosenOf`): a coin Maybe row needs unseen PF ≥ 1.3 on top
of the profit floor (30+ unseen, +0.05R, PF 1.2, first part positive, MC 90%) AND the forward check (10+ forward paper trades,
+0.05R, PF 1.2). Sized at the risk mode's size, the tested stop losing ≤ $47.50 (sizeToCap); only Edge rows all-in. The live
brake (3 own losing trades → 14-day pause) still applies. VPS read 15:40 UTC — rows that qualify on those numbers: stoch_trend:1h
(unseen 807 / .06R / PF 1.43; forward 41 / .15R / 2.79; bot +1.03R), pivot_bounce:1h (2941 / .06 / 1.35; fwd 84 / .09 / 2.16),
bb_squeeze:1h (516 / .13 / 1.66; fwd 14 / .34), breakout_retest:1h (984 / .09 / 1.42; fwd 16 / .28 / 1.98), round_break:1h
(1007 / .11 / 1.59; fwd 24 / .18 / 4.49), trendline_break:1h (1140 / .08 / 1.39; fwd 44 / .10 / 1.63), maybe fib_pullback:4h.
Out: news_drift:1h / momentum_bar:1h / of_thrust:1h (forward paper losing), thin rows (PF < 1.3: fib_pullback:1h, cci_break).
The same read showed coin forward paper donchian20:4h −1.22R / supertrend:4h −1.70R / donchian55:4h −1.56R a trade (worse than
the stop): their exit was 'strict' — a 0.15–0.24% stop, so spread + the 0.045%-a-side coin fee ≈ 0.6R per trade (not a
bookkeeping bug; rows 'no', never traded). `strictStopDist` on coins now ≥ 5 round-trip costs (spread + `feePxOf`) ≈ 0.45%
of the price → costs ≤ 0.2R; FX / indices / metals keep the owner's sizes.
## v27.92 clash rule back to lab-gated (Oct 28, owner: "remove clash rule thing then")
`OPPOSED.always` false: the VPS read (15:31 UTC) showed trades with an opposite-way signal did BETTER on unseen data (forex
+0.10R vs +0.03R, 2,237 / 1,191 trades; coins +0.087R vs +0.061R), so forcing the skip cost money. The clash test still runs
hourly and switches the wait on by itself only if clashing trades turn out ≥ 0.1R worse (v27.86 rules).
## v27.91 Databento CME history (Oct 28, owner: "can I just give you an API key and you do it for me")
`src/forex/databento.ts`: historical HTTP API (`hist.databento.com/v0`, basic auth key:'' , dataset GLBX.MDP3, continuous
front month by volume NQ.v.0 / ES / YM / RTY / GC / SI, `stype_in` continuous, CSV + pretty_px / pretty_ts). Key: Forex →
Setup card **"Databento (CME futures data)"** (`components/DatabentoCard.tsx`; GET / PUT `/api/forex/databento` {key | clear |
refresh}: tested on `metadata.list_datasets` (must list GLBX.MDP3), saved in BotConfig `_databento` (DB only, masked)), or
`DATABENTO_API_KEY` in the VPS .env. NEVER take the key in chat — the owner pastes it into the card. `DatabentoSync` (main
process, index.ts; 2 min after start, then every 6 h, at once after a key is saved): `refreshDatabento` = newest piece first
(180 days), catch up to `metadata.get_dataset_range` end, then back-fill to `historyDays` 1100 (or until Databento has
nothing older); EVERY request priced first with `metadata.get_cost`; a piece over $3 skipped; total spend capped at
`DATABENTO_MAX_USD` (default $20 of the $125 free credit; spent in `fx:db:meta`); 3-min budget a run. Store Redis
`fx:bars:db:<id>` [t,o,h,l,c,v]. Lab (`filledBars`, inline or child): futures → `stitchFutures` puts Databento's older hours in
front of Yahoo's when the seam lines up (≤ 4 days, ≤ 0.6% apart) → ~3 years of index / metal history (expect ONE re-pick on
those rows once it lands). Card also shows (daily, `orderFlowEstimates`, display only) what a year of every-trade data
(NQ / GC / ES, schema `trades`) would cost — NOT downloaded without the owner's say-so (next step: real buy / sell delta for
the order-flow strategies). Live CME prices need Databento's monthly plan (~$199/mo) — not wired. Feed 'databento' on the
Data feeds card ('off' without a key). UNVERIFIED against the real API (sandbox can't reach it); endpoints / params taken from
databento-python. tests/forex-databento (5). Also: the liquidation stream's Binance watchdog 90 s → 15 min
(`DERIVS.watchdogMsBySrc`; Binance's `!forceOrder@arr` is quiet between liquidations — VPS showed 'binance: silent' reconnects).
## v27.90 code review fixes (Oct 28, owner: "re-read your own code, look for bugs, make future work smooth" — four independent
reviewers: bot account, lab chooser / live path, backtest engine, process; each finding traced before fixing)
Bot account (practice.ts): `usdPerPx(pair, mids)` = USD per 1.0 price move per unit at today's prices — every
`pnlUsd(…, entry + 1)` probe swapped the pair's own mid for entry + 1, so USD/CAD / USD/CHF were 0.4–2.3× off (the $ cap
pulled a USD/CAD short's stop to ~29% of the tested distance, never capped a USD/CHF short; spike exit / news lock / copy
sizing too); a stop moved inside the forming minute no longer "gaps" at that minute's earlier open (a lock hit in the same
minute booked a loss); the entry / fill minute is re-checked (only its close — `stopMovedT`), `checkedT` only past complete
minutes on the trailing-TP path; resting orders never fill on prices from before they were placed (placement minute: its
close only); manual edit rejects NaN / wrong-side stops and targets; `snapshot` fetches prices before taking the lock.
Engine: a trade that ends in its own entry bar now counts in `equityCurve` and frees its slot in `simulatePortfolio` (it was
lost / held a slot forever — the honest test, rolling picker, heat grade); a limit / pullback fill inside a candle gets no
credit for the high (long, red candle) / low (short, green candle) that came before the fill (`Pos.limIdx`; coins choose
pullback entries on these numbers — expect pullback to look less good); one more venue-fee round trip per weekend crossing
(the bot closes and re-opens); coins: taker fee 0.045% a side as a % of the position (`VENUE_FEES.cryptoPct`), spreads
cut to the real exchange spread (BTC 2, ETH 2, SOL 2, XRP 1, DOGE 2, ADA 2, LINK 3, AVAX 3 pips) — the old fixed spread
was 3–4× cheaper in % on today's prices than in 2023 (flattered the unseen 30%); coin closes now pay the fee live too.
Lab: no duplicate open trades for limit / pullback rows (only market trades whose order would still be alive at the newest
close and not already held by the entry variant); an expired resting order is never handed over as a market buy
(`orderGone`); confluence / clash look only at trades entered at or BEFORE the trade (look-ahead in the studies), live mates
= the strategies the study counted (picked on the first 70%), opponents / mates include just-finished paper trades; owner
trials and rolling-picker sizes off while provenOnly; the worker child gets the parent's "said once" log memory + chosen
list; fast `chosenOf` applies the forward check; derivs: OI / account rows count from their hour's END, Binance funding in
1000-hour windows, a late liquidation adds to its hour. Process: coin 15-minute test at :41 (forex :31), Dukascopy + CFTC /
BIS refreshed by the forex lab only, `oneTimeUpgrade` writes its marker in one serialized read-modify-write, destructive old
upgrades (v20.1, v26.5, v27.29, v27.42) refuse to run after their window (`pastWindow`), lab / fast timers don't re-arm after
stop(), Kojiro post history trimmed to 5,000, one Kojiro study at a time. EXPECT one re-pick event on both desks (fees,
fills, one-sided confluence). Not changed (owner's call): after two heavy (out-of-memory) worker failures the lab still
runs inline for 6 hours (v18.5) — risk of a parent out-of-memory restart; funding is still not charged on coin trades.
tests/forex-review-v27-90 (4) + updated: forex-clash, forex-v27-24, forex-venue-fees, forex-coverage.
## v27.89 coin derivatives data (Oct 28, owner: "get all the data you can and build it properly")
`src/forex/derivs.ts` (free public APIs, no account): funding history (Binance `/fapi/v1/fundingRate`, fallback Bybit
`/v5/market/funding/history`), hourly open interest (Bybit `/v5/market/open-interest` paged back, fallback Binance
`openInterestHist` — 30 days only), hourly long / short account ratio (Bybit `/v5/market/account-ratio`, fallback Binance
`globalLongShortAccountRatio` — 30 days). `refreshDerivs` (coin lab `computeRun` on a refreshing run, 90 s budget, pages
back toward `DERIVS.historyDays` 1100 over a few runs, ≤ 400 pages a series, one source per series — two exchanges' OI don't
line up) → Redis `fx:deriv:<fund|oi|ls>:<id>` rows [t, value] + `fx:deriv:meta` {src, full, okAt, error}; feed `derivs`.
Live liquidations: `LiquidationLive` (index.ts) on Binance `!forceOrder@arr` (SELL = a long liquidated; Binance sends at
most one per symbol a second) + Bybit `allLiquidation.<SYM>` (Buy = a long), summed per coin per hour → `fx:deriv:liq:<id>`
[hour, long USD, short USD] (120 days), feed `liquidations` — display only (no free history to test on).
Causal per-bar series (`derivSeriesFor`: newest row stamped ≤ the bar's close; funding > 12 h / hourly rows > 3 h old =
NaN): `fund` (% per 8 h), `fundZ` (vs the last 90 settlements), `oiChg` (24 h %), `oiZ`, `lsZ` (log ratio vs 30 days) →
`ctx.ext` + `FilterEnv` via `makeSeries` (`MarketBook.derivs`; the fast lab reads the same book). Lab-graded uses (picked on
the first 70% like everything): filters **funding** (no long with longs crowded + paying, fundZ ≥ 2 / mirror), **oi** (trend
rules need OI rising over 24 h, fades need it falling), **ls** (no long with accounts unusually long, lsZ ≥ 2 / mirror) —
16 filter variants; on markets without the data `allowFor` returns undefined and evaluateTf REUSES the unfiltered trades
(copied), so the forex lab pays nothing; strategies `funding_squeeze` (fundZ ≤ −2 & funding < 0 + break of the 6-candle
high → long, 2 ATR stop, 2R, 3 ATR trail, 3 days; mirror) and `oi_flush` (oiZ ≤ −2 after a ≥ 2 ATR day down + a green
candle closing above the previous high → long, stop under the 12-candle low, 2R, 2 days; mirror) — `ONLY_CRYPTO` in
`runsOn`, no rows in the forex lab; judge features `fundZ` / `oiChg` / `lsZ` (appended, signed by side, in `JUDGE_SOFT` so a
dead feed falls to the backup judge). Market card (coins): `MarketNow.derivs` (`derivNow`) → Markets drawer rows
"Funding", "Open interest", "Long / short accounts", "Liquidated in 24 h", "Futures read". Expect one coin re-pick event
(3 new filter choices) and a ~20% longer coin lab run. Binance / Bybit block US IPs — Setup → Data feeds says what arrived.
tests/forex-derivs (7), forex-judge-fallback (soft list).
## v27.88 the clash rule is always on (Oct 28, owner: "the bot ignored the strategies and messed it up, never do that again")
`OPPOSED.always` true (confluence.ts): every bot trade (both desks, hourly lab) waits when another strategy's open lab trade
entered the OTHER way on the same market within 2 candles ("X fired the other way here — strategies disagree, it skips this
one (clash rule)"), whatever the lab's clash test says (it still measures and reports `opposed`). The Oct 28 BTC long would
have been skipped (pivot_ladder / pivot_bounce / stoch_trend 4h shorts on the same close). Set false = lab-gated again.
## v27.87 the forward check: backtests must be confirmed by forward paper trades (Oct 28, owner: "trade quality is very shit,
adjust yourself and improve")
VPS read 14:00 UTC — coin bot's own closes Oct 21 → now: 53 trades, −6.5R, −$240 (most from rows no longer live: pivot_bounce:4h
−2.6R / 8, round_break:1h −2.3R / 7, donchian20:1h, trendline_break:1h, pivot_ladder:4h); forex bot +0.13R / +$65 on 10. Lab
FORWARD paper (trades opened after paper-since: coins Oct 20, forex Oct 18) vs unseen backtest: coin news_drift:1h +0.26 →
−0.58R (12), momentum_bar:1h +0.10 → −0.62 (13), of_thrust:1h +0.12 → −0.45 (19), keltner:1h +0.13 → −0.11 (46); coin Edge
round_break:4h +0.23 → +0.25 (24, PF 6.7); forex round_break:4h +0.08 → −0.02 (95), pivot_bounce:4h +0.14 → +0.31 (17).
`FX_CONFIG.forwardCheck` {on, minN 10, minAvgR 0.05, minPf 1.2} + `forwardOk(stats)` (lab.ts): the hourly chooser, the bot's
cell path (`chosen` in botTrades) and `labOpen` also need the row's forward paper record (`report.paper.rows[].stats`, pooled
markets, current filter / exit / entry) to clear it; fewer than 10 forward trades = wait (the lab keeps paper-trading it).
Bot-log line once per change "forward check: N tested strategies wait … (why)". On the 14:00 numbers: coins = round_break:4h
only; forex = pivot_bounce:4h only (+ its cells). 15m charts not wired (not traded). tests/forex-forward-check (2), forex-ict.
## v27.86 proven trades obey the $ cap + the clash test (Oct 28, owner after the BTC round_break 4h long stopped at −$132.95
= −1R, 11.1% of the coin account: "that was a stupid trade going long against BTC like that")
VPS read 13:51 UTC: opened 12:31 at 80,801 (pullback order already through its limit → market fill), stop 80,302.81 = the tested
stop, closed 13:48; round_break:4h coins = Edge (1,259 unseen, +0.23R, PF 2.91, 88% won, exit 'tight'), BTC cell 439 / +0.19R.
mtf at the 12:00 close: 1h up, 4h flat, daily up — not against the trend; but on the SAME 4h close pivot_ladder / pivot_bounce /
stoch_trend fired SHORT (and round_break / ifvg_cisd 1h short at 13:00); the confluence mates were donchian20 / inside_bar 4h longs.
(1) `BOT.sizeToCapAllIn` {cbot, bot}: the v27.79 size-to-cap rule now sizes all-in (Edge) trades too → the tested stop loses ≤
$47.50 on coins / ≤ $19 on forex (was up to 20% of the account). (2) confluence.ts **clash test** (`OPPOSED` {bars 2, minUnseen
60, minEdgeR 0.1}, `entryIndex`, `opposedBy`, `opposedStudy`, `clashWait`): the picked strategies' trades split by "another
strategy (any row, not random) entered the OTHER way on that market within 2 candles" vs not, first 70% / unseen 30%; active
only when clashing trades did ≥ 0.1R worse on the unseen part (60+ of them) and worse before the line too → hourly lab
(`fx:opposed` / `cm:opposed`, `/api/<desk>/bot` `opposed`) hands such trades a `soloWait` "X fired the other way here —
strategies disagree" (why.ts kind 'clash', shadow book scores them). Off = clashes trade as before. 15m charts not wired (not
traded). Trades page loss-review card shows the clash verdict. tests/forex-clash (3), forex-proven-only (all-in sized to cap).
Then (owner: "revert the trade"): one-time `v27.86-strike-btc-round-break` strikes that BTC trade (undoPositions + undoClosed,
ref round_break:4h:BTCUSD:1793188800000 → skipRefs).
## v27.85 forex may trade Maybe strategies again, coins stay Edge-only (Oct 28, owner: "forex is allowed to use maybe
strategies because crypto needs to be the safer and main priority")
`FX_CONFIG.provenOnly.verdicts` {fx: ['edge','maybe'], crypto: ['edge']} (hourly chooser + fast `chosenOf` per desk) and
`cells` {fx: true, crypto: false}. `toLabTrade(…, { edge })`: only Edge rows get the 20% all-in size; Maybe rows and forex cells
trade at the risk mode's size, and `BOT.sizeToCap` / `capFloorAccts` now include the forex bot → every forex trade risks at
most ~$19 (the $20 cap × 0.95) on its TESTED stop, the stop never pulled in. Still on both desks: the second-setup rule
(v27.83), the live brake (v27.84), the judge, losing-market record, profit floor. Kojiro calls stay lab-only (v27.77) until
the owner switches them back on. tests: forex-proven-only (verdicts, Maybe never all-in, chosenOf per desk), forex-ict
(chooser source), forex-v15 / v16 set `BOT.sizeToCap.bot = false` (they test risk-mode sizing).
## v27.84 the live brake on the forex bot too (Oct 28, owner: "I only want working strategies, I don't care if it's one trade a
week, I want what works") — `BOT.liveBrake.bot` {since Oct 28 13:00 UTC, minN 3, days 14}: a forex strategy × chart whose own
live trades lose after 3 of them pauses 14 days, like the coin bot (v27.79). With v27.82 (Edge rows only) + v27.83 (second
setup required, coins on their tested entry) that is the full "only what works" gate on both desks.
## v27.83 coins wait for the pullback; no lone signals on either desk (Oct 28, owner: "wait for good entries, I don't want
weak ones")
VPS read 12:09 UTC (coin report 11:45), the 12 coin rows holding a deeper-bar cell: unseen total R by entry — pullback best on
10 of 12 (e.g. momentum_bar 4h .44R vs market .26, round_break 1h 380R vs 244, bb_squeeze 1h .28 vs .17), market best only on
momentum_bar 1h, donchian20 1h a tie; fills limit 96–99%, pullback 84–96%, confirm 23–50% (confirm earned least). Confluence
study (cm): unseen together 57,234 trades +0.071R vs alone 4,984 −0.138R (first 70% +0.137 / −0.181); forex Oct 23 +0.02 /
−0.13. (1) `FX_CONFIG.liveEntries` → per desk {fx: false, crypto: true}; evaluateTf reads the desk from its series; `chooseEntry`
still picks per row on the FIRST 70% and the row is then graded on that entry's trades (v18.4 resting orders, unchanged
code). (2) `FX_CONFIG.requireConfluence` {fx: true, crypto: true} + `needsMate(strategy, pair)`: every strategy's trade
waits (soloWait, both labs) unless another strategy has an open lab trade / a signal the same way on the same market within
`confluenceBars` 2 candles; the v24 doubling-up 1.5× size stays. Coin bot record Oct 25 08:00 → now (before v27.81): 12
trades +0.31R +$9.92; the 10:09 LINK copy hit the tested stop at 12:03 (−$46.49) before v27.81 deployed — that strike
removes it too. tests: forex-strict (liveEntries shape), forex-ict (+requireConfluence).
## v27.82 only Edge rows trade, both desks (Oct 28, owner: "we don't settle for a maybe, we settle for: this strategy makes
us money")
`FX_CONFIG.provenOnly.cells` {fx: false, crypto: false} (was true / true): a per-market cell (`cellPass` / `coinCellPass`)
whose strategy row is only Maybe / no no longer trades — with ~1,000 market × strategy tries graded, some pass by luck
(the LINK keltner / ETH donchian20 / DJI round_break trades of Oct 28 were all cell trades on Maybe / no rows). Only rows
with verdict 'edge' (30+ unseen, both halves positive, PF 1.2+, beats random, luck twins, deflated Sharpe ≥ 50%, profit
floor, not dropped by the learner) trade, all-in 20% as before. Open cell trades run out on their own stops. Expect long
idle stretches: as of Oct 28 neither desk had an Edge row. tests in forex-proven-only (cells switched on inside the two
cell tests).
## v27.81 the two reopened coin trades struck (Oct 28, owner: "revert them both, remove them, these were bad calls")
One-time `v27.81-strike-link-eth` (index.ts): `undoPositions` + `undoClosed` on cbot for refs keltner:1h:LINKUSD:1793181600000
and donchian20:1h:ETHUSD:1793178000000 (the v27.78 / v27.79 replays, −$33.53 / −$14.61 open at 11:45) — as if never taken;
refs → skipRefs. The 04:07 LINK replay (+$9.29, closed by the profit lock) stays.
## v27.80 the Dow is off the forex desk + its open trade closed (Oct 28, owner: "skip the Dow charts, remove it, also stop
the current trades of Dow")
VPS read 11:45 UTC: the forex bot's DJIUSD round_break 1h short (11:40, risking $117.94, all-in cell path) filled 19 points
worse than the lab's entry on Yahoo's ~10-min-late YM=F price = −0.16R at the door vs the DJI cell's +0.10R a trade
(458 unseen, PF 1.48); Hyperliquid lists no Dow market. types.ts `OFF_MARKETS` {DJIUSD}: `ForexLab.insts` and plan.ts
skip it → no candles refreshed, no lab rows / market card / plan row, no trades (fast lab too, via `lab.insts`). One-time
`v27.80-close-dow`: every open bot DJIUSD position closed at the market (`Practice.close`, reason manual — learners ignore
it), bot-log lines. Bring it back = remove the id from `OFF_MARKETS` once a live Dow price exists (DIA on the Yahoo stream,
an OANDA / IG demo, or Databento CME — options given to the owner). tests: forex-ict plan count 18 → 17.
## v27.79 coin bot: the tested stop, never a pulled-in one + a live brake; the ETH trade replayed (Oct 28, owner: "same with
eth/usd … do whatever is needed so profit is doable, as small as amounts may be, adjust itself properly, only take trades if
the bot is sure")
VPS read 11:29 UTC: one ETH trade — donchian20 1h long (ETH cell 463 unseen, +0.15R, PF 1.76) 09:09 at 2367.66, the $20 cap
put its stop at 2359.55 ($8 under; tested 2341.31, $26 under) → −$20.00 at 11:06; the lab's trade still open (low 2356.5).
Coin bot's own R ledger, 14 days: 55 trades, −7.6R (pivot_bounce:4h −2.59R / 8, round_break:1h −2.30R / 7, donchian20:1h
−1.65R / 4; news_drift:1h +2.15R / 4) — run with stops ~¼ of the tested ones. practice.ts `BOT.sizeToCap` {cbot}: risk % cut
so the TESTED stop loses ≤ the account cap × `sizeToCapHeadroom` 0.95 ($47.50 of $50) → the cap never pulls the stop in, the
live trade is the graded one (smaller trades when the tested stop is wide). `BOT.liveBrake` {cbot: since Oct 28 12:00 UTC,
minN 3, days 14} + `liveBrake(rows, now, cfg)` (pure, R ledger, manual closes ignored): a strategy × chart whose own live
trades made < 0R after 3+ of them is paused (syncBot wait "its own live trades lost … paused until …") until the oldest of
them is 14 days old. One-time `v27.79-eth-cap50`: `replayBotTrade` on ref donchian20:1h:ETHUSD:1793178000000, $50.
tests in forex-link-cap50 (+3).
## v27.78 coin bot loss cap $50 + the two LINK trades replayed (Oct 28, owner: "what went wrong in the last 2 trades"; "redo
those 2 trades with a limit of 50 loss and let it grow properly as if it never closed")
VPS read 11:05 UTC: both were keltner 1h LINK longs (a proven cell: 288 unseen, +0.16R, PF 1.63) stopped by the $20 cap —
04:07 entry 11.717, cap stop 11.6775 (0.34%, the tested stop was 11.5838 / 1.4%) → −$20.04 at 04:28 while the lab's same
trade won +0.42R (trail, 08:00 hour; loss review: AVOIDABLE loss_cap, capDelta −$48); 10:09 entry 11.8435, cap stop 11.789
→ −$20.00 at 10:35, lab trade still open. At turbo size the $20 cap left ~¼ of the tested stop room = inside one normal
15-minute LINK candle. `BOT.maxLossUsdByAcct.cbot` 20 → **50**; `BOT.capFloorAccts` {cbot}: the excursion study's per-strategy
cap ($10–40) may not pull a coin trade tighter than the account's $50. `replayBotTrade(a, ref, capUsd, after, closeAt)`
(practice.ts, pure) + `Practice.replayBotTrade`: strike the close, re-walk from the entry on 1-minute candles with stop =
the tested stop pulled in only to the cap, the profit lock measured on the tested stop (`walkTrade` 8th param `lockFrom`),
`closeAt` = when the bot would have followed the lab's exit; ended → booked, else left open. One-time `v27.78-link-cap50`
(Coinbase 1-minute candles from 04:00, retried ×10): A with closeAt 09:09 UTC, B open-ended. tests/forex-link-cap50 (4).
## v27.77 Kojiro calls are LAB ONLY; the 02:32 NQ short struck (Oct 28, owner: "do as if it never happened and keep all Kojiro
calls in labs for now — they always work out for him but apparently not for us")
- discord.ts: `DISCORD_COPY.live` (env `DISCORD_COPY_LIVE=on`, default OFF): his SIGNAL posts are parsed, gated and logged
  ("lab only — not traded …"), saved to his history and graded by kojiro-study.ts as before — never opened; his exit posts
  still close any copy left open. `POSTED_LEVELS.trade` default OFF (env `DISCORD_LEVEL_TRADES=on`; was on unless 'off').
  His levels / plan / bias are still saved and drawn.
- level-watch.ts **level lab** (`LEVEL_LAB` {key `fx:discord:lvlab`, max 300, maxOpenMs 24 h}, `LabLevelTrade`,
  `loadLevelLab`, `gradeLevelLab` (pure: `walkTrade` on the live minutes after it — stop first, the fee-aware profit lock,
  target; R after the venue fee; 24 h without stop / target → 'expired' at the last close), `levelLabSummary`): with level
  trades off, LevelWatch (still every 20 s, gated on `DISCORD_COPY.on` only) records every level setup once per candle (fee
  check as live) with a bot-log line "Kojiro level (LAB, not traded): would sell …", and grades open lab rows of every
  market it can read (also after his levels expired). GET `/api/forex/discord` → `live`, `levelLab` {n, done, wins,
  totalR, avgR, open, byWhy, rows (30)}. The 15-minute pass takes no level trades while off (as before). No dashboard card yet.
- One-time `v27.77-strike-kojiro-toward-nq`: ref discord_kojiro_levels:signal:NDXUSD:1793154660000 (open + closed) struck.
- Back to trading his calls: VPS .env `DISCORD_COPY_LIVE=on` / `DISCORD_LEVEL_TRADES=on` once the lab + his graded record
  show they work for US (after fees, our fills). tests/forex-kojiro-lab (4); forex-discord / forex-live-candles switch the
  trading path on at the top.
## v27.76 "sell high toward his levels" measures from ALL his levels (Oct 28, owner: "is the current trade correct from the
Kojiro call?")
02:32 UTC the toward rule shorted NQ at 29,856.25 (stop 29,881, target 29,804) — his bearish lean and his target, but only
21 points above his newest level 29,835: the poke (29,867) was measured against his older "Short Levels" list (top 29,783,
Oct 27 17:35, still valid 24 h), whose levels the set loop tried first. `towardSignal` now takes the stretch from every live
level (`levels` + `targets` = all his lists) → the price must be 0.15% past his nearest level of ANY list. The open trade was
left running (owner's call). tests in forex-level-toward (+1).
## v27.75 which markets have a live price — said in the bot log and on the trade card (Oct 28, owner: "the live price updating is
being delayed")
VPS read 02:16 UTC: Hyperliquid live prices (gap measured) for NDXUSD / SPXUSD / XAUUSD only; DJIUSD, RUTUSD and XAGUSD had no
builder market matched → Yahoo's CME price, ~10 min late (the open Dow round_break:1h short priced from 02:06 at 02:16).
hyperliquid.ts: more Dow / Russell / metal names (`HL_FUTURES`: USA30, DJ30, WS30, DOWJONES, US2K, R2K, R2000, SMALLCAP…) +
`lookalikes(names, found)` (index-looking builder names that matched nothing) → `HyperliquidLive.onMarkets` → index.ts bot-log
line once per change "live prices: NDXUSD ← Hyperliquid xyz:XYZ100 … · still ~10 min late (Yahoo): … · other index-like
markets there: …" (read it after deploy; add a listed name to `HL_FUTURES` if it is the right market). Practice `snapshot`
positions carry `priceAgeMs` (`quoteAge`), `botStatus` passes it; dashboard active-trade card "Price now" sub reads "price N min
late" when ≥ 3 min and no live tick. NOT done (owner to decide): stop new trades on markets without a live price.
**Ticking P&L for Nasdaq / S&P / gold** (owner: "the profits are delayed too, not only the chart"): the builder markets' moves
never reached the dashboard push (they aren't the futures price), so their P&L only moved on the 5-s page refresh.
`HyperliquidLive.onFutTicks` (raw futures-market moves, a separate listener set — `onTicks` / `get()` still never see them) →
`Practice.liveFutTick(id)` (= `hlQuote`: + the measured gap, CME open only) → a second `startLivePush` in index.ts → the same
'fx' bus event the currency pairs use → `useFxLive` moves the P&L between refreshes. Dow / Russell / silver have no live
source, so they still move only with Yahoo's late price. tests in forex-hl-index (+2).
First VPS line (02:27 UTC, 20d078d): live = NDXUSD xyz:XYZ100, SPXUSD xyz:SP500, XAUUSD xyz:GOLD, XAGUSD xyz:SILVER (gap
0.039); late = DJIUSD, RUTUSD; other index-like: xyz:USAR, xyz:KR200, xyz:SPCX, mkts:US500, mkts:USBOND, mkts:SMALL2000,
mkts:USTECH → `SMALL2000` added to the Russell names (the gap check — < 3% of the price, ≥ 10 shared minutes — refuses it
if it doesn't track the RTY future). Hyperliquid lists no Dow market: DJIUSD stays on Yahoo (~10 min late).
## v27.74 sell high / buy low TOWARD his levels (Oct 28, owner: "he did post it, it's these levels" — his NQ short at 29,879 →
29,804, in #signal-proofs: sold ABOVE his three levels 29,835 / 29,804 / 29,782.5 with his bearish lean and used them as targets)
The bot only traded AT his levels (bounce / break-and-retest), so a sell above them had no rule. strategies.ts **`towardSignal`**
(`TOWARD` {look 15, awayPct 0.15, minR 1.5, stopAtr 0.15}): needs his bias (none → nothing); bearish: a candle pokes above the
high of the 15 candles before it, at least 0.15% above his nearest level, and that candle or the next closes back under the
old high on a red candle → sell, stop 0.15 ATR past the poke (≥ 0.3 ATR / the watcher's 0.08% floor), target his nearest level
≥ 1.5R away (none → no trade); bullish mirrored. Fires once per poke. `postedLevelSignal` = absorption → retest → toward, so
LevelWatch (1-minute) and the 15m pass both take it; `Signal.note` names the rule in the bot log ("sold high toward his
level" / "break and retest of his level" / "absorbed at his level", `LevelTrade.why`). Same size / fee checks / profit lock as
his other level trades (20%, ≤ 1% fee, fee ≤ 25% of the stop). NOT lab-tested — the owner's call; judge it on the
`discord_kojiro_levels` P&L rows. Kojiro's 29,879 short itself: 01:41 UTC entry, high 29,903 at 01:52, 29,856 at 02:09, target
not reached then. tests/forex-level-toward (3).
## v27.73 the coin bot's "NO strategies" line was wrong (Oct 28, owner: "both cryptos been rather silent today")
VPS read 01:58 UTC: coin lab 0 Edge / 37 Maybe; `chosen` [] but 35 cells pass the deeper coin bar (`coinCellPass`: momentum_bar
1h / 4h, news_drift 1h, bb_squeeze 1h, round_break 1h / 4h, keltner 1h, of_thrust 1h, inside_bar 1h, breakout_retest 1h,
donchian20 1h, trendline_break 4h ADA) — the plan watches 13 setups on 8 coins; none fired since 22:00 → no trade, working as
designed. why.ts said "NO strategies to trade" because it read only `chosen`: `WhyInput.proven` (count of `provenCells`, the
server passes `fx.proven`) → the verdict names "N strategies + M one-market setups"; the coin desk's why uses `CRYPTO_CLOCK`
(was the forex clock → "forex market is closed" on coin weekends). Display only. tests in forex-why (+1).
## v27.72 gold level trades struck + no trade the fee can eat (Oct 28, owner: "it got in a weird signal, longed it then
insta sold, lost 90"; "super big trades with insane fees"; "+50 pips but −40")
VPS read 01:04 UTC: his GC levels (4,072.7 / 4,074.4, 23:39) made the level watcher buy gold twice — 12 oz ≈ $50k at 50× on a
$1k account, stop ~$3.3 while the round-trip gold fee (0.05% a side) is ~$4.07 an ounce = ~$50 a trade: 00:49 +$0.56 (lock),
01:01 −$93.60 in 45 s (stop $43 + fee $50). They could not win after fees. Fixes: level-watch.ts `feeTooBig` (round-trip fee
> `LEVEL_WATCH.maxFeeShare` 25% of the stop → "not taken", also in the missed-level replay; `LevelTrade.entry`); practice
`copyOpen` (his SIGNAL copies + level trades): refused when the fee is > `DISCORD_COPY.maxFeeShare` 25% of the stop, and
made smaller until the round-trip fee is ≤ `maxFeePctOfEquity` 1% of the account (`DISCORD_COPY_MAX_FEE_PCT`); the LIVE
profit lock counts the venue fee (`lockPlanNet`, profit-lock.ts: locked stop past entry + spread + round-trip fee; when that
is past the normal arming price it arms one trail-gap later instead of never) in `tick`, the news-tight lock and
`walkTrade` — the lab engine keeps `lockPlan` (fees come out of R there). One-time `v27.72-strike-gold-levels`: every
`discord_kojiro_levels` XAUUSD trade opened Oct 27 20:00 – Oct 28 06:00 UTC struck (open + closed). His NQ level shorts
(asked for in v27.69) stay. venue-fees.ts `feePxOf`. tests/forex-level-fees (4).
## v27.71 the old index fee given back on every closed index trade (Oct 28, owner: "yes revert it … also on the one today, I
need it accurate")
VPS read 00:46 UTC (b77c552): the wrong-side 00:33 long was struck (open, never closed); the v27.69 replay (run by 71d2f6d,
still at the old fee) booked his two break-and-retest shorts — 00:03 at 29,827.75 → 29,817.50 (−$12.50, fee $29.27) and 00:13
at 29,831.25 → 29,827.59 (−$23.02, fee $28.94), both closed on the profit lock with the move in their favour; older index
closes (Oct 26 Kojiro SELL $25.29, Oct 23 RUT / DJI) paid 0.03% too. practice.ts `refundIndexFees(a, oldPct, newPct)` (pure)
+ `Practice.refundIndexFees`: a closed index row whose stored fee IS the old rate's (2 × oldPct × margin × leverage, ±1%)
gets fee × new/old, the difference back in the balance, the row's P&L, its stats entry, its R ledger row (R from `riskUsd0`)
and its P&L-log row; can't refund twice. One-time `v27.71-refund-index-fees` (bot account, 0.03 → `VENUE_FEES.indexPct`).
NOTE for later: the profit lock's "locked" level counts the half spread but not the venue fee (`lockPlan` costPx = half), so a
locked exit 3–5 NQ points in profit is about flat after the ~5-point fee round trip; not changed (owner asked for tight).
tests in forex-level-retest (+1).
## v27.70 index fee = Hyperliquid's real rate; the wrong-side NQ long struck (Oct 28, owner: "did it take the call correctly?";
"are you sure it's a 25 euro fee, go look, that's way too much")
Before v27.69 deployed, the old build (bias still bullish) BOUGHT NQ at 29,815.75 at 00:33 UTC off his 29,804 level while he
was leaning bearish → one-time `v27.70-strike-wrong-side-level` (runs at start, before the level watcher's first minutes
matter): every discord_kojiro_levels NDXUSD LONG opened 23:59 Oct 27 – 03:00 Oct 28 struck (`undoPositions` + `undoClosed`,
never re-opened) and the bearish bias saved there (moved out of the delayed v27.69 replay). Fee: `VENUE_FEES.indexPct`
0.03 → **0.009** % a side = Hyperliquid trade[XYZ] XYZ100 under growth mode (2× the normal HIP-3 rate cut ≥ 90%,
docs.trade.xyz → Fees; DefiLlama ~0.45–0.9 bps taker; top of the range) — the market the bot already prices NQ from. A
1.6-unit NQ round trip: ~$29 → ~$9. CME micros (MNQ) would be ~$0.75–1.80 a contract round trip. Lab: every index row's R
changes a little → one re-pick for indices. Already-booked closes keep the fee they paid.
## v27.69 his "Leaning towards bearish" + break and retest at his levels; tonight's missed trades booked (Oct 28, owner: "it legit
had levels but the bot didn't take em, go in them at the exact time, pull yourself back to learn from it, DO BETTER")
VPS read 00:22 UTC: his NQ levels 29,835 / 29,804 / 29,782.5 (23:59:06 UTC) were saved and watched on live 1-minute candles,
but "Leaning towards bearish" (00:08:44) and "Break and retest" (23:51) were logged as "not a trade message" → the stored bias
stayed the morning's bullish (longs only), and the 00:00–00:20 break under 29,835 + retest from below (15m high 29,842.75,
close back under) had no rule at all (the bounce rule needs a fresh untouched level + a new 10-candle extreme). Fixes:
`parseBias` also reads "Leaning (towards / more / slightly) bearish / bullish / shorts / longs"; strategies.ts
**`retestSignal`** (`RETEST` {lookMin 180 → 6…60 candles, leaveAtr 0.5, touchAtr 0.1}): a candle after his post closed
through one of his levels, the price left it by ½ ATR, THIS candle is the first back to it, holds (≤ ½ ATR through) and closes
on the break's side → trade the break's way, stop 0.15 ATR past the retest candle (≥ 0.3 ATR / the watcher's 0.08% floor),
target his DOL / next level ≥ 1R; `postedLevelSignal` falls back to it (so LevelWatch + the 15m pass both take it). Booking:
practice.ts `walkTrade` (pure: stop first when a minute touches both, the profit lock moving the stop from the next minute)
+ `bookLevelTrade` / `Practice.bookLevelTrade` (sized like his level trades, closed at stop / target / locked stop on the
minutes since, else left open from the last minute on); level-watch.ts `replayMissedLevels` (the minutes since his post with
today's rules, one trade at a time, ≤ 3, ref = the signal minute, `lvdone` key set). index.ts one-time
`v27.69-kojiro-levels-oct28` (90 s after start, retried every 60 s ×10 until Yahoo has the 1-minute candles): NDXUSD bias −1
at 00:08:44 (force) + replay of 29,835 / 29,804 / 29,782.5 shorts only from 23:59:06 → bot-log lines "Kojiro level (missed,
booked as if taken): …". tests/forex-level-retest (6).
## v27.68 Kojiro's history upload retries (Oct 27, VPS read 16:25 UTC: copier heartbeat fine, but `study` posts 0)
The copier's first history upload ran right after a deploy, while the bot itself was still starting (both restart
together) → every POST failed → nothing saved, and the next try was 12 h away. bot.py `backfill_history()` now returns
True only when every batch got `ok` back; `catch_up` retries after 10 min on failure (not every 2-min sweep — it reads up to
3,000 posts a channel), else 12 h. GET `/api/forex/discord` → `historyPosts` (HLEN of `fx:discord:hist`).
## v27.67 sell into a big spike (Oct 27, owner: "you sure these are profitable charts … the bot loses because it's too
focused on the tight TP, I close it way earlier — if there is a big spike, sell")
VPS read 15:44 UTC (cbot, all time +$188.44): bot-closed 52 trades −$126.05, hand-closed 19 +$314.49 (17 in profit, +0.04…+1.17R,
median ≈ +0.3R on `riskUsd0`). The named losers (pivot_bounce:4h −$66, pivot_ladder:4h −$46, trendline_break:1h −$38,
donchian20:1h −$32) all opened before v27.44 (Oct 25 08:00) / most before the $20 cap (Oct 22 17:00); under v27.44 none of
them can trade (pivot_bounce / pivot_ladder / trendline_break:1h rows 'no' → coinCellPass needs Edge / Maybe; donchian20:1h
cells +0.11–0.14R < 0.15). Since Oct 25 08:00 the bot's own closes: 8 trades +$16.18. practice.ts `SPIKE_EXIT` {on, jumpR
0.3, windowMs 5 min, minR 0.3, minUsd 5} + `spikeExitFor(p, q, mids, half, now)` (pure): a bot trade (has a lab ref, not tf
'signal') whose price jumped ≥ 0.3R its way from the worst 1-minute price of the last 5 minutes and now sits ≥ +0.3R (R =
`riskUsd0` ÷ units) and ≥ $5 after the close fee → `tick` closes it at the market, reason **'spike'** (`LEDGER_WHY.spike` 6;
dashboard "sold into a spike"; push FX_WHY). Both bots. Live rule, NOT lab-graded (the engine's 1h / 4h candles can't see
a minutes-long spike) — judge it on the P&L ("sold into a spike" rows) vs the trades it would have held.
tests/forex-spike-exit (3).
## v27.66 the bot learns which of Kojiro's calls hit + a tight trailing stop around big news (Oct 27, owner: "lock in and be
more accurate, scan Kojiro's calls, see which one hits and take it; with a tight trailing SL in moments of need")
`src/forex/kojiro-study.ts`: his posts (copier uploads his last 120 days at start + every 12 h → POST
**`/api/forex/discord-history`** {items} → Redis HASH `fx:discord:hist`, ≤ 5,000; every post handleSignal sees from him is
added too) → `callsFrom` (each SIGNAL with his later exit post — "SELL @" closes the oldest open long, "BUY / COVER @" a short —
his SL, his plan bias that day (with / against / none), at one of his levels (± 0.1%)) → `simCall` on the bot's NDX candles
(15m, else hourly; the entry candle skipped; stop first; a price outside the entry candle ± 0.35 stop = another contract →
`mismatch`, not graded; 24 h max) under 3 holds: `none` (his exit / 0.5% safety stop), `copy` (COPY_LOCK, live before),
`tight` (PROFIT_LOCK); R after the venue fee. `buildCard` → `fx:discord:study` (`runKojiroStudy`: hourly + 5 min after start
+ after each history upload): per hold n / win / avg R / PF; `best` = most per call with 15+ calls (current kept unless
beaten by 0.05R); slices side / NY session / plan / level / SL with their `rest`. **`kojiroGate`** in handleSignal (open):
a call is NOT copied when a kind it belongs to has 8+ graded calls, avg < 0R, PF < 0.9 AND his other calls average > 0R
(a losing record across the board skips nothing — reported only); log "not copied — his record: …"; the copy is opened with
`best`'s trailing stop (`copyLock: 'tight'` → PracticePosition.copyLock → tick uses PROFIT_LOCK; 'none' → no lock).
**Moments of need**: `Practice.tightNow` = `ForexCalendar.newsNow` (High-impact / central-bank speech for the pair within
20 min, holidays not counted) → tick switches an open copy (tf 'signal', no target, lock not null) to the tight lock measured
on its ORIGINAL stop (`riskUsd0`), `tightWhy`, event line; only ever tighter. GET `/api/forex/discord` → `study`. NOT
lab-graded on unseen data (one caller's record, read plainly); nothing switches until the card has the calls.
tests/forex-kojiro-study (8).
## v27.65 the missed Oct 26 SELL booked + the copier can't silently miss his posts (Oct 27, owner: "count it in as well in the
portfolio and don't miss shit again")
His "SIGNAL · NQ — SELL @ 29,189.75" (Oct 26 ~01:55 UTC, +$770 on 1 contract in his screenshot) came before the copier ran on
the server (v27.50 fixed its install / syntax errors ~14:30 UTC that day) — no log row, nothing copied. `bookMissedCopy(a, …)`
(practice.ts, pure) + `Practice.bookMissedCopy`: a 20% copy on the 0.5% safety stop (1.444 units, $843 margin at 50×), his
price → 29,151.25 (38.5 points), reason 'signal', venue fee $25.29 → **+$30.31**, through `closePos` (balance, record, R
ledger, P&L log on Oct 26); refused when the ref is already booked. One-time `v27.65-book-kojiro-nq-sell-oct26`.
Copier (scripts/discord-scanner/bot.py, rebuilt by the auto-update with the `discord` profile): `catch_up()` every 2 min
(started once from on_ready) re-reads the newest 30 posts (last 12 h) of each signal channel and hands over any the live
event missed (`SENT_IDS` skips ones already sent; the bot's seen-key refuses repeats; opens older than 10 min are still
refused, levels / plans still saved), then POSTs **`/api/forex/discord-heartbeat`** {channels, sent} → Redis `fx:discord:hb`
(`saveHeartbeat` / `loadHeartbeat` / `copierDown`, `COPIER_HB.staleMs` 15 min). Posts in his channels by OTHER authors are
sent with `other: true` → logged as kind 'other' ("posted by X, not him — logged, not copied"), never traded — so a plan
posted by another account shows up in the log instead of vanishing. index.ts `copierWatch` (60 s): heartbeat quiet 15 min →
bot-log line + phone alert (FxNotice kind **'copier'**, push.ts always sends it), and again when it is back (state in Redis
`fx:discord:hbalert`; a copier that never reported = no alert). GET `/api/forex/discord` → `copier` {lastSeen, channels,
down}. Verified `channel.history(limit, …)` / `wait_until_ready` exist in discord.py-self 2.1.0 (installed in a venv).
tests/forex-copier-v27-65 (4).
## v27.64 his "Short Levels" are shorts only and no longer wipe his other levels (Oct 27, owner: "Short Levels (for today) …
do the levels that were said, don't miss out")
VPS read 15:14 UTC: the 14:55 "Short Levels" post (29,713.75 / 29,727.75 / 29,736.25 / 29,765 / 29,783) REPLACED his 13:24
levels (one list per market) and had no side, so the bullish plan would have made the bot only BUY at his short levels.
discord.ts: `parseLevels` → `side` −1 on "Short / Sell levels", +1 on "Long / Buy levels"; `PostedLevels.shortLevels` /
`shortT` / `longLevels` / `longT` (each valid a day from its own post, `loadLevels`); `savePosted` (exported, `force` for
hand corrections) fills the side list and leaves the plain levels alone; `levelSets(x)` → plain levels (his bias + DOL),
short list (side −1), long list (side +1), targets from ALL his levels (`postedLevelSignal(…, targets)`; DOL only on the bias
side). LevelWatch (1-minute) and the 15-minute pass loop the sets; the chart draws every list. One-time
`v27.64-kojiro-short-levels-oct27`: NDXUSD levels back to the 13:24 list + the short list (force). The channel the owner
named (1495278719647088650) was already watched — his plan post went missing for another reason (posted by another
account / an embed or forward the self-bot didn't read); unexplained. tests in forex-discord-levels (+2).
## v27.63 Kojiro's plan of Oct 27 saved by hand (Oct 27 ~14:40 UTC, owner pasted "Bias: bullish · DOL: 29,713.75 · Narrative:
manipulation to the downside, then long off my levels")
It never reached the copier (no log row at all — his 13:24 levels did, so the plan went in a channel / as a post the copier
doesn't read). One-time `v27.63-kojiro-plan-oct27` (index.ts) runs it through `handleSignal` (id owner-paste-plan-2026-10-27,
at 14:25 UTC) → NDXUSD bias bullish (level trades long only), DOL 29,713.75 as the target, valid 24 h. Owner asked to watch
that channel too: add its ID to `copy.channel_ids` in scripts/discord-scanner/config.example.json once they send it.
## v27.62 his NQ long struck as if it never happened (Oct 27 ~06:15 UTC, owner: "revert the trade as if it never happened")
One-time `v27.62-strike-kojiro-nq` (index.ts): `undoPositions` + `undoClosed` on the bot account for ref
discord_kojiro:signal:NDXUSD:1564452300599066716 and any `:re…` re-entry (open legs, closes, parts, rolls, stats, R ledger,
P&L log). The copier settings (20%, copy lock) are unchanged.
## v27.61 a looser trailing stop on Kojiro's calls (Oct 27, owner: "trailing SL on his calls is fine, just not too tight early on")
profit-lock.ts `COPY_LOCK` {atFrac 0.25, gapFrac 0.25, keepFrac 0.03, tightAtFrac 0.6, tightGapFrac 0.15} + `LockPlan.tight`
(`lockPlan` cfg takes tightAtFrac / tightGapFrac; `lockedStop` uses the tight gap once the best price passes `tight.from`):
for a call with no target (D = 2 × the starting stop) it arms at +0.5R, locks entry + costs + 0.06R, trails 0.5R behind,
and past +1.2R trails 0.3R (the bot's normal lock). Practice `tick` picks it for tf 'signal' positions with no target; the
level trades (with a target) keep `PROFIT_LOCK`. `DISCORD_COPY.profitLock` back ON by default (`DISCORD_COPY_LOCK=off`
= his exit only). `reviveCopy` leaves `lock` unset (worked out at the next check); one-time `v27.61-relock-kojiro`
(`Practice.relockCopies`) gives open calls with `lock: null` the copy lock. Engine / lab untouched (copies aren't graded).
tests in forex-discord (+1).
## v27.60 his NQ long put back as if it never closed, at 20% (Oct 27, owner: "just revert exiting and put it at 20% instead
of 1 … enter it where you were earlier and continue the trade")
`reviveCopy(a, ref, pct)` (practice.ts, pure) + `Practice.reviveCopy`: the copy's close (and parts) struck via `undoClosed`
(balance, stats, ledger; P&L-log row dropped), the position pushed back with its original entry / opening time / ORIGINAL
stop (`riskUsd0` ÷ units), `lock: null`, checks resuming from the minute it closed, then `resizeCopies` to `pct`. One-time
`v27.60-revive-kojiro-nq` (ref discord_kojiro:signal:NDXUSD:1564452300599066716, 20%): strikes the v27.59 market re-entry
(`:re…`) if it already opened, then revives. The v27.59 one-time re-entry was REMOVED from index.ts (replaced by this);
`reenterCopy` stays. tests in forex-discord (+1).
## v27.59 his NQ long re-entered + no profit lock on his calls (Oct 27, owner: "re-enter his trade, it sold, I didn't want that")
VPS read 01:53 UTC (d0804f7 — v27.58 had not deployed yet, so it was still 1.9% / $20): his NQ long (posted 29,470, copied
01:34 at 29,486, safety stop 29,338.57) ran to ~29,546; the v27.51 profit lock (no target → D = 2 × stop ≈ 295 pts, armed
at +44, trailing 44 behind) moved the stop to 29,501.77 and the pullback closed it at 01:51 (+15.8 pts, −$0.26 after fees).
Kojiro posted no exit. Fixes: `DISCORD_COPY.profitLock` default OFF (`DISCORD_COPY_LOCK=on` restores it) → his calls close
on his exit / his SL / the safety stop; the level trades keep their lock (they have a target). `Practice.reenterCopy(acct,
riskPct, pick)`: the newest closed copy opened again at the market on its ORIGINAL stop (`riskUsd0` ÷ units), new ref
`<ref>:reN`, refused past that stop / when already back in. One-time `v27.59-reenter-kojiro-nq` (that ref, 20%; first try
60 s after start, retried every 30 s ×10 while there is no live price; bot-log line "Kojiro copy: re-entered …").
tests in forex-discord (+1, lock expectation flipped).
## v27.58 the open Kojiro copy re-sized to 20% (Oct 27, owner: "adjust the current live trade as if it has 20% fast")
`resizeCopies(a, pct, mids)` (practice.ts, pure) + `Practice.resizeCopies(acct, pct)`: every open copy (tf 'signal') gets
more units as if it had opened at `pct`% of the balance on its ORIGINAL stop (distance = `riskUsd0` ÷ units; same entry),
all copies together ≤ pct, margin ≤ `BOT.allInMarginShare` of the free margin; `allIn` set, `maxLossUsd` dropped, a stop
the $20 cap had pulled in goes back to the original distance (a profit-lock stop stays). Nothing booked changes — the open
P&L simply counts the bigger size from the entry (a paper adjustment, not a real fill). Run once at start
(`oneTimeUpgrade('v27.58-resize-kojiro')`, bot + cbot, bot-log lines "Kojiro copy: … re-sized"). tests in forex-discord (+1).
## v27.57 Kojiro's calls risk 20% (Oct 27, owner: "use muchhhh more on kojiro calls … also 20")
`DISCORD_COPY.riskPct` 2 → **20** (default; `DISCORD_COPY_RISK_PCT` in the VPS .env still overrides it), `marginShare` 0.5 →
0.9. Practice `copyOpen`: all open copies (tf 'signal': his SIGNAL posts + the level trades) together risk at most that 20%
(a call while 20% rides → refused "already N% riding on his calls"); the account's $20 loss cap no longer sizes them and
`tick` no longer pulls their stop in (positions carry `allIn`); their stop is his SL / the 0.5% safety stop / the level
trade's stop, profit lock on. Separate budget from the lab's all-in cells (syncBot's 20% all-in sum skips tf 'signal').
One stopped copy ≈ −20% of the account. tests in forex-discord (+1).
## v27.56 the trade / market charts of indices and metals no longer lag 10 minutes (Oct 27, owner: "are the charts real
time and not delayed now?")
v27.52 only fed the BOT's candles; the dashboard chart (GET `/api/forex/candles` → `Practice.candles`, used by the
active-trade card) still drew Yahoo's CME candles, ~10 min late, when OANDA isn't connected. `liveTail(base, live, gap, now,
closed)` (basis.ts, pure): live candles of the same size at / after Yahoo's newest one, moved by the futures − Hyperliquid
gap, replace Yahoo's late last candle and are added after it (the forming one included); CME halt hour / closed market
skipped. `Practice.liveChartTail` (M1 / M5 / M15 / H1 / H4, futures only, needs a measured `hlGap`) via the swappable
`Practice.hlBars` (= `hlCandles` on the market from `hyperliquidLive.futuresFound()`; intervals now 1m / 5m / 15m / 1h / 4h).
No live market, no gap or an error → Yahoo's candles as before. Currency pairs / coins unchanged (Yahoo FX + Coinbase are
not delayed). tests in forex-live-candles (+2).
## v27.55 v27.54 reverted: the signal judge keeps its veto on forex cell setups (Oct 27, owner: "I don't want it to force
trades, but if it's a bug it's different")
Not a bug: the judge and the per-market bar disagreed and the stricter one won. Evidence read 00:06 UTC: the shadow book has
3 forex judge refusals, 1 finished (XAGUSD round_break:4h −0.10R → it saved ~$8); the judge's own unseen exam (AUC 0.64,
threshold 0.64, keeps 50%): kept −0.01R vs all −0.07R, the trades it skips −0.13R. So the judge cuts losers; nothing showed
it blocking winners. `cellOnlyTrade` removed (git revert of v27.54). Re-open the question only if the shadow book's judge
rows on proven cells finish clearly positive (20+ finished).
## v27.53 the login no longer runs out every week (Oct 26, owner: "I keep getting logged out of my app")
A dashboard token lasted 7 days from when the password was typed, however often the app was used. auth.ts: POST
`/api/auth/refresh` (behind `requireAuth`) returns a fresh 7-day token; dashboard `lib/api.ts` `renewLogin()` swaps it at
most every 6 h (`solbot.tokenRenewedAt`), called by App.tsx `useAuthed` on open, every 30 min and when the app becomes
visible → the login only runs out after 7 days without opening the app (same secret, same lifetime). tests/auth-refresh (2).
**Dukascopy** (owner: "make Dukascopy work"): the VPS gets HTTP 403 from jetta.dukascopy.com = its AWS bot firewall
blocking automated downloads on purpose. dukascopy-node 1.51.0 passes it with a hidden browser — NOT adopted: that is
getting around a site's bot protection (the action was refused in the session). Legit routes: Dukascopy's own manual
historical-data export (a person downloads CSVs) + an upload into the bot, or keep Yahoo's ~2 years (what runs now).
## v27.52 no more 10-minute-late index candles + his levels watched on live 1-minute candles (Oct 26, owner: "what happened
to not having delayed candles, I thought we fixed that"; "copy his trades immediately, or even 1–2 minutes later" — screenshot:
his MNQ long 9 contracts at 29,194.75 off his 29,182.25 level, +$3,973; VPS read 14:52: the copier started 14:32, after it)
- v27.48 only made the PRICE live; the candles of the indices / metals stayed Yahoo's (~10 min late). basis.ts
  `extendWithLive(base, live, barMs, now, closed)` (pure): the gap = `measureBasis` on the candles both have (≥ 10), then
  only FINISHED live candles newer than Yahoo's last are added, moved onto the futures price; volume × the median Yahoo ÷
  live ratio (else none); the CME halt hour (17–18 New York) and closed hours skipped; Yahoo's own candle replaces it at
  the next refresh (nothing is written to the stores). hyperliquid.ts `hlCandles(coin, '1m'|'15m'|'1h', from, to)` (REST
  candleSnapshot), `HL_FUTURES_KEY` `fx:hl:futures` (index.ts writes the discovered {id → builder market} map via
  `hyperliquidLive.onDiscover`; the worker child reads it with `loadHlFutures`). Used by the hourly lab (computeRun, after
  the DK fill: last 4 days of 1h, counted in `fillInfo.filled`) and the 15-minute pass (fast.ts decide: last 12 h of 15m).
- `src/forex/level-watch.ts` `LevelWatch` (index.ts, every 20 s): markets with posted levels and a Hyperliquid builder
  market → its live 1-minute candles (6 h) moved by `Practice.hlGap(id)` (the measured futures − Hyperliquid gap; none yet
  → waits, one log line) → `postedLevelSignal(…, minRisk = 0.08% of the price)` on the newest finished minute (≤ 3 min
  old) → `takeLevelTrades` (moved here from fast.ts; one per candle via Redis NX, one open per market). The 15-minute
  pass keeps posted levels only for markets the watcher can't cover. His SIGNAL posts were already copied the moment
  the self-bot sees them. tests/forex-live-candles (5).
## v27.51 Kojiro's levels + daily plan traded, tight trailing stop on every copy (Oct 26, owner: "he also sends Levels
29,220.00 (29,182.25) (29,160.00) (29,070.50)"; "it can trust his trades, I want it to take it and trail it tight SL"; then
his plan post "Bias: bullish · DOL: Around 29,385.25 · Narrative: manipulation to the downside, then long off my levels")
- Copies: `DISCORD_COPY.profitLock` now ON by default (`DISCORD_COPY_LOCK=off` = his exit only): no target → lock D =
  2 × the safety stop (0.5% ≈ 145 NQ points) → arms ≈ +43 points, trails ≈ 43 behind the best price; his exit still closes it.
- discord.ts `parseLevels` (a post with the word Level(s) + ≥ 2 prices within 10% of their median; brackets / commas / list
  numbers ignored; no market named → `POSTED_LEVELS.defaultPair` NDXUSD) and `parseBias` (Bias bullish / bearish /
  neutral + DOL price) → one record per market in Redis `fx:discord:levels` (`savePosted` merges; levels and plan each
  valid 24 h from their own post, `loadLevels`); log row kind 'levels', bot-log line. Never a trade by itself.
- fast.ts (15m pass, both desks): `postedLevelSignal(ctx, i, levels, postedT, bias, dol)` (strategies.ts) = the
  level_absorb test on HIS levels (absorption candle after his post, first touch, ≤ ½ ATR through) only in his bias
  direction; stop 0.15 ATR past the candle (≥ 0.3 ATR — not the 10-point strict stop: the % venue fee would eat it);
  target = his DOL when ≥ 1R away, else his next level ≥ 1R, else none. `takeLevelTrades`: one trade per candle (Redis NX
  `fx:discord:lvdone:<ref>`), one open per market, stale data skipped, `practice.copyOpen` with explicit `stop` / `target`
  (new optional fields; refused when the price is already past the stop), strategy `discord_kojiro_levels`, tf
  'signal', 2% / $20 cap, profit lock on. `DISCORD_LEVEL_TRADES=off` = save + draw only. NOT lab-tested (no history of
  his posts) — owner's call ("trust his trades"); judge it on its own strategy line in the P&L.
- `/api/forex` (+ crypto) draws his levels + DOL on that market's chart (drawings level kind 'posted', amber "Kojiro …"
  label in MarketChart; Markets drawer row "Kojiro's level"); GET `/api/forex/discord` → `levels`, `levelTrades`.
- bot.py `message_text` also reads forwarded posts (`message_snapshots`; his plan arrived "Forwarded").
  tests/forex-discord-levels (8), forex-discord expects the lock.
## v27.50 Discord copier on the VPS (Oct 26, owner: "I want the bot also to run when my PC isn't on")
`docker-compose.yml` service **discord** (`profiles: ["discord"]`, build `scripts/discord-scanner/Dockerfile`, python
3.12-slim, 256 MB, `BOT_API_URL=http://bot:8080`, env_file .env): off unless .env has `COMPOSE_PROFILES=discord` +
`DISCORD_TOKEN` (the owner adds both over SSH, README "On the VPS"); bot.py logs in with `DASHBOARD_PASSWORD` when
`BOT_DASHBOARD_PASSWORD` isn't set; a missing / refused token waits an hour before exiting (no login hammering). Fixed
on the way (the v27.46 script never ran): requirements pinned `discord.py-self==1.9.2` (needs aiohttp < 3.8 — no
install on modern Python) → **2.1.0** + aiohttp ≥ 3.9 (checked: installs and loads on 3.12 + 3.13); `global CFG` sat
after CFG was used in `handle_command` (SyntaxError on every Python) → moved to the top.
Oct 26: second signal channel 1495278719647088650 (Kojiro, mostly Nasdaq 100) added to `copy.channel_ids` in
`config.example.json`; the container makes its config.json from it on every recreate (auto-update rebuilds it).
## v27.49 coin bot: daily / hourly trade caps OFF (Oct 26, owner: "turn it off then if it's that good") — VPS read 11:08 UTC:
the coin shadow book's biggest refusal bucket was `day_cap` (47 held back, 46 done, 89% won, +29.57R ≈ +$2,774 at base
risk). `BOT.maxTradesPerDay.cbot` 15 → 0 and `maxTradesPerHour.cbot` 3 → 0 (0 = no cap; the v27.38 / v27.42 code stays).
Still on: `maxSameSide` 2 (no burst of same-way trades), one bet per market and direction, the $20 / smarter loss cap.
Same read: forex news_drift / news_fade are retired (lost unseen), the forex news pause skipped 5 trades worth −$314 net;
coin news_drift:1h is the best coin row (1,326 unseen, +0.23R, PF 1.58; cells ETH / BTC / XRP / SOL) and trades already.
## v27.48 live index / metal prices from Hyperliquid, no account (Oct 26, owner: OANDA's demo login + password reset both
fail, so no token)
hyperliquid.ts: `HyperliquidLive.discover()` (singleton gets a fetcher; at start + every 6 h): POST
`api.hyperliquid.xyz/info` {type perpDexs} → {type meta, dex} per builder dex (≤ 40) → `matchFutures` (`HL_FUTURES` name
patterns, only `dex:NAME` markets — the main dex's "SPX" is the SPX6900 memecoin): NDXUSD (XYZ100 / NDX / NAS100 / US100…),
SPXUSD (SP500 / SPX / US500…), DJIUSD (US30 / DOW…), RUTUSD (US2000 / RUSSELL…), XAUUSD (GOLD / XAU), XAGUSD (SILVER / XAG)
→ their l2Book subscribed on the same socket; `idOf` coin → id; `parseL2` returns `coin`. A builder market's price is NOT
the CME future: never in `get()` / the tick push (so the LiveFeed and the dashboard live P&L never see it raw); `book(id)`,
`futBars(id)`, `candles(id)` (info candleSnapshot 1m, else the bars built from the book), `futuresFound()`. Practice: gap
store keyed `src:id` ('oanda' | 'hl'), `basisFor(id, src, now, s?)`, `measureBasisFor` (Yahoo 1m vs OANDA M1 or HL
candles), `hlQuote` = book + gap (bars shifted, source 'hyperliquid', no delay) used by `quote()` for futures markets
only while the CME clock is open and a gap ≤ 1 h old exists (weekends / halts → Yahoo; the builder market trades 24/7
on its own). OANDA, when connected, still goes first in `quotes()`. `basisNow()` → {basis, n, at, src} (OANDA preferred);
Setup "Live price feed" card lists each market as "live via Hyperliquid / OANDA · gap ±x" or "10 min late"; feed label
'hyperliquid-live' mentions indices / metals. UNVERIFIED: which builder markets exist (the sandbox can't reach
Hyperliquid) — the bot log says "Hyperliquid index / metal markets found {…}" or "none found" at start. tests/forex-hl-index (4).
## v27.47 OANDA demo = live index / metal prices, moved onto the futures price (Oct 26, owner: "why is ours 10 min behind,
make it on time"; OANDA for charts only, never trading; the demo account should need no ID)
Yahoo's CME futures (NQ=F, ES=F, YM=F, RTY=F, GC=F, SI=F) are ~10 min late (exchange data licence). oanda.ts `toOanda`:
NDXUSD → NAS100_USD, SPXUSD → SPX500_USD, DJIUSD → US30_USD, RUTUSD → US2000_USD (before: NDX_USD etc. → HTTP 400 failed
the WHOLE pricing call), coins → null (Coinbase stays their feed); `fromOanda`; `oandaPrices` on a 400 finds the name this
account can't price (one call each) and skips it 6 h (`oandaCovers`). OANDA's index / metal prices are CFD / spot, the
lab / stops / Kojiro are futures → `src/forex/basis.ts` `measureBasis` (median futures − OANDA close over the 1-minute
candles both have, ≥ 10 minutes, < 3% of the price); Practice `basisFor` re-measures every 10 min in the background
(Yahoo 1m via `fetchQuote` vs OANDA M1 300), trusts a gap ≤ 1 h old; `quotes()`: a futures market goes through OANDA only
with a gap (bid / ask / mid / 1m bars + gap, no `delayMs`, priceT = OANDA's → no 10-min delay), else Yahoo as before.
Fixed on the way: with OANDA connected, markets OANDA didn't price (coins) were MISSING from `quotes()` — now every
market not priced by OANDA gets its normal quote. `candles()` (charts): futures OANDA candles + gap, no gap → Yahoo.
Fast lab: OANDA history for currency pairs only (`!needsBasis`). GET `/api/forex/oanda` → `basis` per market; Setup card
"Live price feed" lists Nasdaq / S&P / Dow / Russell / gold / silver as "live · gap ±x (n min ago)" or "measuring the
gap…". UNVERIFIED against the real OANDA API (sandbox can't reach it). tests/forex-oanda-basis (6).
## v27.46 Kojiro's Discord signals copied as paper trades (Oct 26, owner uploaded their own self-bot: "you don't have to
build it, just implement it with the bot")
`scripts/discord-scanner/` = the owner's self-bot (discord.py-self 1.9.2; logs in as the OWNER's account — breaks Discord's
terms, ban risk, owner's call) + a copy step: every post in `config.json` `copy.channel_ids` (optionally only
`copy.author_ids`) — content + embed text — is POSTed to **`POST /api/forex/discord-signal`** {id, text, at, source} with
a JWT from `/api/auth/login` (`BOT_DASHBOARD_PASSWORD` env; `DISCORD_TOKEN` env for Discord). `config.json` + the hit log
are gitignored (`config.example.json` committed; first run copies it). `src/forex/discord.ts`: `parseSignal` (pure)
"SIGNAL · NQ — LONG @ 29,026.25" → open (LONG / SHORT anywhere, BUY / SELL only with SIGNAL; optional `SL @` / `TP @`),
bare "SELL @ x" → close longs, "BUY / COVER @" → shorts, "CLOSE / EXIT @" → both, "SL to BE" → stop to entry; `symbolToPair`
(NQ / MNQ / NAS100 / NQZ6 / MNQ1! → NDXUSD, ES → SPX, YM → DJI, RTY → RUT, GC → XAU, SI → XAG, BTC / ETH / SOL, our ids).
`handleSignal`: Redis SET NX `fx:discord:seen:<id>` (7 d, once per message), opens refused when posted > 10 min ago, every
message logged (`fx:discord:log`, 200; GET `/api/forex/discord`), action lines into the desk's bot log. Practice
`copyOpen` / `copyClose` / `copyBreakeven`: account **bot** (coins → cbot), strategy `discord_<source>` (`discord_kojiro`),
tf **'signal'** (ref `discord_kojiro:signal:<pair>:<msgId>` → outside every syncBot scope, so the lab never manages / closes
it), safety stop = his SL when on the losing side else `stopPct` 0.5% of the price (`copyStop`), sized so that stop loses
`riskPct` 2% of equity capped at the account's $ loss cap (`copySize`, ≤ 50% of free margin, leverage 50 capped per
market), no target, `OpenReq.noLock` → `lock: null` (follows HIS exit; `DISCORD_COPY_LOCK=on` adds the profit lock),
entry at our quote (Yahoo NQ ≈ 10 min late — `feedDelayOk`), refused when our price is > 1.5 stop distances from his
(wrong market). Exits close at the market with reason 'signal'. Weekend flatten: a copy ENDS (no resume item —
`pausable`). Env (VPS .env): `DISCORD_COPY` off, `DISCORD_COPY_RISK_PCT`, `DISCORD_COPY_STOP_PCT`, `DISCORD_COPY_LEVERAGE`,
`DISCORD_COPY_LOCK`. Copies count toward the bot's open caps (one slot each). tests/forex-discord (9).
## v27.45 smarter $ stop from how trades really dipped (Oct 25, owner: "how much it bounced from loss to high, how long it is red
before it makes profit, how low it goes before it bounces; instead of a flat $20, could it be $25 or $15 — a smarter SL based on
trade performance; and chart it")
`src/forex/excursion.ts` (pure, `EXCURSION`): per closed bot trade (not partial / weekend legs) from the 15m candles (hourly when
15m doesn't reach back): MAE / MFE in USD (+ ×1R), minutes to the bottom, winners' minutes back to break-even, and for trades the
$ cap closed (stop at ≈ −cap while the tested stop was further) what the tested trade did over the next 72 h (target / tested
stop / neither). `underCap` replays every trade under caps $10…$50 (adverse side of a candle assumed first; profit lock not
replayed) → total per cap, best cap overall / per strategy × chart / per market. Suggestion per strategy × chart = blend of its own
best (8+ trades) and the overall best, weight n ÷ (n + 10), rounded to $2.5, kept $10–40; ACTIVE only with 30+ analysed trades,
and a cap other than today's only counts when it changes 3+ trades for $10+ more (`provenCap`; a capped trade whose 72 h
after-story isn't finished counts as what it did). First VPS read (08:27 UTC): coins 61 trades → $20 is the best cap (winners
dipped median $5.61, 75% within $10.32, bottom after ~77 min, back to even ~58 min later; $10 cap would have made $15 vs $203);
forex 20 trades → the raw best ($35) came from ONE still-open RUT trade → the evidence rule above was added, forex stays $20.
`ForexLab.noteExcursions()` (after noteLosses, ≤ once per 50 min, both desks) → Redis `fx:excursion` / `cm:excursion`,
`Practice.slCaps[acct]`; syncBot opens each NEW trade with `PracticePosition.maxLossUsd` = its strategy's cap (never all-in;
`tick` + loss review use `p.maxLossUsd ?? a.maxLossUsd`); bot-log line "smarter stop: …" when the caps change. Trades opened
before Oct 22 17:00 UTC (`EXCURSION_CAP_SINCE`) count as uncapped. Size unchanged (turbo, v27.20). API GET
`/api/<desk>/excursion[?refresh=1]`; Trades page card "How far trades go red before they win" (`components/FxExcursion.tsx`:
headline, winners-that-went-$10/15/20/25-red tiles, scatter red-depth × final $ with today's cap dashed + the suggested cap
solid, capped trades that later hit the target, total per cap bars, per-strategy caps). tests/forex-excursion (3),
forex-loss-cap (+1).
## v27.44 the coin bot trades smarter: a deeper bar per coin + one market move counted once (Oct 25, owner: "make it trade
smarter, I have no issue with it trading a lot, but what it just did is an account drainer — I need in-depth research before a
trade, I want to be profitable")
VPS read 08:03–08:07 UTC: 1 coin Edge row, 39 Maybe, 134 no; 108 of 1,058 strategy × chart × coin cells passed the strict market
bar (~10% — what luck gives over that many tries), and those were all live (v27.34). Two changes, coin desk only (forex unchanged):
- `coinCellPass(cell, pooledOf(row))` + `COIN_CELL` {minN 50, minAvgR 0.15, minPf 1.5, poolMinN 30, poolMinAvgR 0, poolMinPf 1.1}
  (lab.ts): on top of `cellPass` a coin cell needs 50+ unseen trades on that coin at +0.15R and PF 1.5, AND the same strategy ×
  chart's pooled row (all coins together, `Row.outSample` + `verdict`) must be Edge / Maybe with a positive unseen average and
  PF ≥ 1.1. `planChosen(…, pooled)` (8th param; hourly via `allRowOf`, fast via the row), `provenCells`, the weekend prep list.
  On the 08:03 report: 108 → 32 cells (momentum_bar 1h / 4h, news_drift 1h, bb_squeeze 1h, inside_bar 1h, of_thrust 1h,
  keltner 1h, round_break 1h / 4h, trendline_break 4h ADA, breakout_retest 1h); cut include pivot_bounce:4h (luck twins 20 of
  20, −$52 live this week) and pivot_ladder:4h (−$46).
- `BOT.maxSameSide` {cbot: 2} (practice.ts syncBot): at most 2 open trades + resting orders in the same direction across the
  account (coins move together — the 06:00 burst shorted 4 coins at once); best-tested (`prio`) first; wait "already N sell
  trades open across the coins". The $20 loss cap / turbo sizing were left as the owner set them (v27.20).
tests in forex-proven-only (+1 behavioural, expectations).
## v27.43 15-minute trades off, both desks (Oct 25, owner: "turn off 15 min trades, back to lab") — `FX_CONFIG.botFastCharts`
false, `botFastChartsCrypto` false, `botFastStrategies` [] (the ICT session rules too). The fast lab still tests 15m every hour
(Strategies / Lab) and still MANAGES any 15m position the bot holds (`chosen: false` = manage, never open); the plan marks 15m
signals "lab only". Turn any of the three back on to trade 15m again.
## v27.42 coin bot: max 15 trades a day, 3 an hour; the burst after today's peak struck (Oct 25, owner: "trading way too
much and too risky … revert all trades till the point where it made 60+, cancel all current trades, 15 trades max so it can
still trade throughout the day, not 18 trades at night all at once") — `BOT.maxTradesPerDay.cbot` 15 (forex bot still 0 = no
cap) + `BOT.maxTradesPerHour` {cbot: 3} (rolling hour, `tradesOpenedSince`; wait "hourly limit reached", why.ts day_cap). VPS
read 07:55 UTC: today (owner's clock, from 22:00 UTC) peaked at +$63.09 after LINK stoch_trend:1h +$67.61 (06:00 UTC); after it
6 closes −$39.07 (three −$20 cap stops). One-time `v27.42-undo-coin-after-peak`: `undoClosed('cbot', closedAt ≥ 06:00 UTC Oct
25 except that LINK close)` + `undoPositions('cbot', all)` (LINK keltner:1h + ETH williams_r:1h shorts then); refs → skipRefs.
## v27.41 less lag (Oct 24, owner: "the app keeps lagging and not properly responding") — dashboard `useApi`: a timer poll
is skipped while the same request is still out (a slow server used to get a pile of copies); reloads after a button / event
queue one re-fetch instead. Server `/api/<desk>/bot` (every open screen polls it every 5 s; it builds the plan, shadow book,
loss review…) = one build per desk shared for `BOT_CACHE_MS` 3 s, never two builds at once (`botCache`, cleared on a
risk-mode change). Caddy already gzips the JSON.
**The real cause** (VPS latency read 23:06–23:12 UTC): `FX_LAB_WORKER` was not on, so the forex lab (≈ 6 min) and the coin
lab (≈ 9 min) ran IN the bot process every hour → event loop frozen up to 13.6 s, /api/health timing out at 30 s, /bot 57 s,
heap 1.05 GB. `labWorkerOn` (lab-runner.ts) is now ON by default when NODE_ENV=production (tests / dev inline;
`FX_LAB_WORKER=off` forces inline, `on` forces the child anywhere), and `forkLabRun` queues children — one at a time (each
child's timeout starts on its turn), so the two labs never need 2 × 900 MB at once inside the 2 GB container. The v17.7 /
v18.5 fallbacks stay (failures → bigger child heap, then a few inline runs). Still in-process: the 15m fast test at :31.
## v27.40 no daily trade cap (Oct 24, owner: "remove the daily limit") — `SIZING.maxPerDay` 0 (= `BOT.maxTradesPerDay` on
both bots): no cap live or in the honest test / rolling picker (0 = off in both). The v27.38 code stays; set 5–10 to restore it.
## v27.39 world events + central-bank press + chart reading (Oct 24, owner: "look up Fincept Terminal — it scans everything, an
oil tanker gets hit, war…"; then "build whatever improves the trading, information and chart reading")
Fincept Terminal (github.com/Fincept-Corporation/FinceptTerminal, AGPL-3.0 — NO code copied): its maritime / geopolitics
screens only call Fincept's paid server (`/marine`, `/research/news-events`, Enterprise); taken = its free RSS list and the
keyword-burst idea.
- `src/forex/world.ts` (pure): `WORLD_RULES` kinds conflict / energy / shipping / sanctions / disaster / cyber / crash (regex,
  markets moved, critical words: tanker hit / seized, strait closed, war declared, invasion, refinery hit…), `REGIONS` (Middle
  East → CAD XAU JPY, Russia/Ukraine → EUR CHF XAU, China/Taiwan → AUD NZD JPY, crypto words → coins…), `worldTag`,
  `worldAlarms` (`WORLD` {windowMin 60, baseHours 6, minHits 3, minSources 2, burstX 2, holdMin 45}: a burst = 3+ in the
  last hour from 2+ sources and ≥ 2× the usual hourly count of the 6 hours before, or ONE critical headline; it lasts until
  45 min after the last headline that was still unusual / critical — a steady stream ends it), `worldBlock`, `marketTags`
  (also fixes `headlineBlock`: DOGE / LINK / AVAX were cut to 3 letters and never matched), `mergeWorld`.
- headlines.ts: `WORLD_FEEDS` (Al Jazeera, BBC World, Guardian World, Middle East Eye, France 24, DW (RSS 1.0 — `parseRss`
  now reads dc:date), UN News, OilPrice) → only world-event headlines kept, Redis `fx:world` (3 days, 400), never in the
  normal headline list / big-headline pause; `CB_FEEDS` (Fed press_all, ECB press, BoE news) → the normal list tagged with
  the bank's currency, a statement / decision / minutes / press conference = 'high' (30-min pause). `blockFor` = headline
  block ?? world block → both labs' syncBot (news traders still exempt) and the plan; every new alarm → `fx:world:hist`
  (1,000) for grading later; feeds 'cb-press' / 'world-news'; why.ts kind `world`. API `/api/forex/calendar` → `world`
  {alarms, items}; News page card "World events" (`components/FxWorld.tsx`). NOT graded (no headline history) — a safety
  pause like the VIX brake.
- Chart reading: drawings.ts `flowDrawings` → `Drawings.profile` (POC / VAH / VAL, byVolume), `channel` (50-candle
  regression line + SD), `read` (lrZ, R², CMF, relVol, inValue); MarketChart draws the value area (amber band + POC line)
  and the channel (dashed sky blue, ±2 SD) on the Markets drawer + control-room big screen (`show.profile` / `show.channel`,
  default on; toggles in the drawer); "What it sees" rows: volume profile, regression channel, order flow. Verified by
  rendering (esbuild + Playwright). tests/forex-world (5).
## v27.38 max 10 trades a day + a busier weekend study (Oct 24, owner: "max 5–10 trades per day and I want the bot training a
lot this weekend, I want very profitable stats")
- `SIZING.maxPerDay` 10 (portfolio.ts) = `BOT.maxTradesPerDay` {bot, cbot} (practice.ts): syncBot opens at most 10 new trades a
  trading day per bot (day from 22:00 UTC = CEST midnight, `tradingDayStart`; `tradesOpenedToday` counts each ref once — its
  first opening — so parts / weekend legs / a re-opened paused trade don't count again; resting orders placed today do);
  best-tested signals first (`prio`), then wait "daily limit reached" (why.ts kind `day_cap`). The honest test /
  rolling picker (`simulatePortfolio` `maxPerDay`, default the same cap; the "before the upgrade" row null) trade under the
  same cap → `skipped.day`. Set 5 in `SIZING.maxPerDay` for the strict end of the owner's range.
- Weekend study busier: `PREP.everyHours` 8 → 4, `maxRows` 14 → 24. With the retired list rebuilt every weekend hour, the
  luck meter and the hourly re-test, that is the weekend training; told plainly that more training on the same history can
  only find / keep what passes unseen data, it can't make the stats profitable.
  tests/forex-daycap (2).
## v27.37 the friend's very strict stop + strategies with no promise retired (Oct 24, owner: "his SL is 10 points, make it
like that, very strict SL"; "remove all strategies which show no promise from the list")
- exits.ts `STRICT_STOP` / `strictStopDist(pair, px)`: 10 points on the Nasdaq, scaled per market (S&P 2.5, Dow 15, Russell 1.5,
  gold $1, silver 5¢), 5 pips FX, 0.15% coins, never under 3 spreads. `asia_absorb` / `level_absorb` now use the tighter of
  "past the absorbing candle" and that stop (targets 2–20R, else 3R); every strategy gets exit variant **'strict'** (stop
  pulled in to that distance, target unchanged — 13 exit variants), picked on the first 70% like every exit.
  FEES: the venue fee is a share of the position (gTrade model, `VENUE_FEES`), so on a 10-point NQ stop it costs ≈ 1.7R a
  trade (S&P 2.5 pts ≈ 1.9R, gold $1 ≈ 4.2R) — told to the owner; tight stops only pay on CME-style per-contract fees.
- Retirement (lab.ts `RETIRE` {minUnseen 60, promiseN 10}, `noPromise`, `deskWeekend`, `loadRetired`, Redis `fx:retired` /
  `cm:retired`): a strategy with ≥ 60 unseen trades over all its charts (hourly lab rows + the fast report's 15m rows) and no
  promise anywhere (no Edge / Maybe row, no row with 10+ unseen trades and a positive average, no market passing
  `cellPass` / `cellTry`) is retired: skipped on weekdays by both labs (`evaluateTf` `o.skip`, the live "what fired" lists),
  re-run at the weekend when the list is rebuilt (it comes back by itself). Its rows' unseen Sharpe ratios stay in the
  honest statistics as trials (`honestStats` `extraSr`). Report `retired` → Strategies page hides those rows ("Show the N
  retired strategies") and the Lab playbook lists them in one line. `RETIRE.on = false` restores the full list.
  tests/forex-retire (3); forex-absorb expects the strict stop.
## v27.36 the friend's method: Asia open, his level, absorption (Oct 24, owner relayed: "I only trade the Asia open and wait
until my level is hit; if sellers or buyers get absorbed there I enter; I check every timeframe and enter on the 1m")
His 9 clips (GC / NQ / ES / YM futures, 1m, TradingView "TradeAxis DOL" draw-on-liquidity targets): entries at a sweep wick,
stops $275–560, targets the nearest liquidity / FVG (5–10R), stop moved past entry early; winners only, mostly still open.
- flow.ts `absorptionAt(c, i, side)` (`ABSORB`): one of the last 3 candles made a new 10-candle low (mirrored) and closed in
  its top half on ≥ 1.5× normal volume — no volume: lower wick ≥ ½ the candle, close in the top third; no lower low since,
  newest close ≥ that candle's → {j, extreme}. `prevWeekLevels` (weeks roll Sunday 21:00 UTC) → `Flow.week`.
- strategies.ts `levelAbsorbSignal` (`ASIA`, `friendLevels`): his levels = yesterday's + last week's high / low + untouched
  major swing points (extreme of the 40 candles before, never traded through); first touch in 12 candles, absorption on the
  candle that tags it (≤ ½ ATR through) → enter at the close, stop 0.1 ATR past that candle (0.3–4 ATR), target the
  nearest opposite level 2–8R away else 3R, out after a day. **`asia_absorb`** (15m + 1h, candle closing 18:00–23:00 New
  York) and **`level_absorb`** (any hour, every chart — the yardstick for the Asia timing). Family 'ict'. 1m entries stay
  out of the bot (v18.8); his 1m entry is approximated on 15m.
- filters.ts **'absorb'** (13 filter variants; `FilterEnv.absorbUp / absorbDn` built in `makeSeries`): a strategy may be
  tested "only where the other side was just absorbed" — picked per strategy on the FIRST 70% like every filter.
- Nothing trades until it passes the strict test (provenOnly). tests/forex-absorb (4).
## v27.35 standard deviation, volume profile, order flow — graded by the lab like every rule (Oct 24, owner: "standard
deviation, orderflow, volume profile — I want you to train on that too")
- **Volume in the candles** (`Bar.v?`): Yahoo `volume` (kept only when > 0 → futures / coins; spot FX reports 0 = none),
  Coinbase's 6th column; stored rows [t,o,h,l,c,v] (`barOfRow`, `vol6`; old 5-wide rows still load), fast bars too, `to4h`
  sums v (only when every hour has it). One-time refill: a non-FX market whose stored history is < 50% volume (`volumeShare`)
  is pulled in full once (`fx:bars:vfill:<id>` marker; Coinbase 1,100 days, Yahoo 730) and the fast lab re-pulls its window
  once per start (`volFilled`). Dukascopy / DK-fill bars carry none.
- `src/forex/flow.ts` (`FLOW`, `buildFlow`, `flowOf(c)` → memo `Ctx.flow`, causal — tested): 20-bar z-score; 50-bar
  regression channel (`lrMid`, `lrSlope`, `lrR2`, `lrSd`, `lrZ`); volume profile of the last 96 candles in 24 bins, rebuilt
  every 4 candles (`vp(i)` → POC / VAH / VAL (70%), `byVolume`; TIME at price where a window has no volume); candle order flow
  (delta = v × (2c − h − l) ÷ (h − l), `cmf` 20, `dr5`, `relVol` = v ÷ the 20 before; NaN without volume).
- 8 strategies (strategies.ts, families **'deviation'** + **'volume'**, `DEV` thresholds, every chart / market): `sd_revert`
  (flat channel, ≥ 2.2 SD away then back inside 2 → to the line, ≥ 1R), `lr_channel` (R² ≥ 0.6 channel, dip to −1.8 SD,
  up candle → line + 1 SD), `sd_breakout` (R² < 0.3, close 2.5 SD off the line → follow, stop at the line, 2R), `vp_reentry`
  (closed outside the value area, back in → POC, ≥ 1R), `vp_breakout` (12 closes inside value, solid close out → 2R),
  `of_absorb` (new 20-bar low, CMF > 0.05 and rising, upper-half close → 2R), `of_thrust` (CMF crosses 0.15, relVol ≥ 1.3,
  with the 50 average → 1.5 ATR, 2R), `of_climax` (relVol ≥ 3, range ≥ 1.8 ATR to a 20-bar low, close in the top 40% → 1.5R).
  `of_*` are silent without volume (spot FX). Nothing trades until a row earns Edge / a strict cell (provenOnly unchanged).
- Signal judge +6 features (appended, so stored models keep their indices): `lrZ`, `lrR2`, `vpPoc`, `vaPos`, `cmf`,
  `relVol`; the presence mask blanks the volume ones on FX and REQUIRES them on coins / futures once known in 90%.
- Lab: ~190 ms per 12k-bar chart for all eight (synthetic), one re-pick of nothing (existing rows unchanged). Dashboard Lab
  playbook families "Volume profile & order flow", "Standard deviation". tests/forex-flow (8); forex-coinbase expects v.
  Order flow from candles is an estimate — tick-level order flow has no free history.
## v27.34 coins = experimental practice desk, forex = winners only (Oct 23 ~22:15 UTC, owner: "switch them on, I want crypto
to be more experimental for now and keep practising while forex is locked on only winnings")
VPS read 22:04 UTC: coin bot idle since the weekend luck meter (Friday 21:09 run) downgraded rsi_dip:4h to 'no' (its 20 random-
timing twins' top 10% made 0.242R vs its 0.20R; coin 4h random entries +0.08R — the market drifts up); 0 coin Edge rows, 75 rows
positive unseen, 94 coin cells on the strict per-market bar (news_drift:1h ETH / SOL / BTC +0.35–0.41R, momentum_bar, bb_squeeze…).
`FX_CONFIG.provenOnly.cells.crypto` **true** + new `cellAllIn` {fx true, crypto false}: a coin trade that is live only through
its cell (its row isn't Edge) gets NO all-in size → the coin bot's risk-mode size + the $20 loss cap (practice); Edge rows stay
20% all-in on both desks; forex unchanged (Edge rows + strict cells, all-in). `toLabTrade(…, { rowChosen })` (hourly: chosen
has the row; fast: `keep`). `provenCells` under provenOnly = strict cells on desks whose cells trade only (was also trial /
work bars → the plan listed setups that don't trade). plan.ts counts those per-market setups (`x.proven`, markets of this desk)
next to the chosen rows → no more "Nothing qualifies yet" while cells trade. tests/forex-proven-only (+1, expectations).
## v27.33 the weekend runs itself: stress test, time machine, next-week forecast, warm-up (Oct 23, owner: "make it an
automated system that all weekend max-extends on preparing for the next weeks"; "look up jakeschincariol trader skill")
`src/forex/prep.ts` (graded / display only), run by `ForexLab.applyPrep` inside `computeRun` (so also in the worker child)
right after the quality pass, only while the desk's market is closed (coins: UTC Sat / Sun), at most every `PREP.everyHours`
8 (or when the 70/30 line moved) → Redis `fx:prep` / `cm:prep` (`FX_PREP`). Rows studied (≤ `maxRows` 14): live Edge rows
(+ profit floor), rows with a `cellPass` market on desks whose cells trade (`provenOnly.cells`), then the near misses
(positive unseen, 10+ trades). Per row `studyRow`: (1) **plateau** — stop × / target × {0.75, 1, 1.25} (`scaleSignal` around
the signal close, after the row's exit), `plateauOf` = share of the 8 neighbours with 10+ unseen trades that made money;
< 50% = `fragile`; (2) **time machine** (ported idea from Jake Schincariol's day-trader-skill `trader-timemachine`, MIT):
`timeMachine(bars, trades, barMin, from, to)` replays each unseen trade 10× (seed 19) on paths bootstrapped from that
market's candles of the unseen weeks + 60 days before, same slot of the day ± 1 (O/H/L/C as ratios to the previous close,
weekend gaps left out), stop first when a candle touches both, hold = 2 × the trade's bars (≤ 120) → target first / stop
first / neither, replay avg R (no costs) vs the real avg R → `edgeR` = what its timing adds; `machineVerdict` = the skill's
wording on the break-even 1 / (1 + R) (coin flip < 5 pts, leans < 15, strongly; < 30 replays hitting a side = too few;
> 40% neither said); `poolMachines` across markets; (3) **next week** `weekForecast` (4,000 weeks, Poisson(unseen trades a
week) per live key, R drawn from its unseen trades, × `provenOnly.riskPct` (20) → % of the account; overlap not capped).
`prepNotes` → plain lines (fragile / holds up / timing adds / a near miss that looks solid / next week). The weekend
review (`weekend.ts`) reads `fx:prep` into the recap (`recap.prep`, its notes in `lessons`, a soft "weekend study done"
check that never fails readiness), re-runs the AI review once the study lands, keeps `steps` (what the weekend system did:
recap rebuilt, new study, AI review, warm-up, ready check), and **warms up** before the forex open: ≤ `warmUpMin` 120 min
and > `readyPushMin` (now 60) → `lab.run(true)` + `fastFx.evaluate()` once (`fx:warmup:<day>` NX), then the ready push.
Dashboard WeekendCard: next-week tiles (trades a week, green-week %, typical / bad week %), "Weekend stress test" rows
(holds up / fragile / not live, random paths vs real R, verdict), "What it did this weekend". NOT used to switch anything:
a fragile live row is only flagged. **Jake Schincariol's repos** (`Jakeschincariol/trader-skill`, `day-trader-skill`, MIT,
Python, read 2026-10-23; no install scripts; only subprocess = pdftotext): US-stock helper skills (13F copycat, Congress
trades, SEC XBRL, tax lots, rebalance, ORB scanner / close-confirmed entry / or-mid stop / time machine / risk / broker
tickets). Already in the bot: ORB (`orb_ny`), close-confirmed entries, stops / targets in R, risk caps, news watch, Monte
Carlo. Taken: the time machine. Not taken: equities-only data (EDGAR, House PTRs), volume confirmation (FX has no volume —
could be a coin / index filter later). tests/forex-prep (6), forex-weekend (+warm-up).
## v27.32 weekend review: recap the week, get ready for Monday (Oct 23, owner: "recap everything from the past week and think
how it can improve itself all weekend so it's fully prepared Monday; use the weekend as a hyper-learning experience")
`src/forex/weekend.ts`: `buildRecap` (pure) per desk from what the bot already records — this week's P&L log (weeklyLog, UTC,
vs last week), live vs tested per strategy:chart (R ledger this week vs the row's unseen avg R; `worse` / `better` at ±0.5R
with 3+ trades), chosen list at the week's start (`chosenAt` on `fx:chosen:hist`) vs now, the loss review this week (normal /
avoidable + causes), the shadow book's refusals this week per reason with the lab's R (what each hold-back rule cost / saved),
near misses (`missingFor`: rows positive on unseen data but not live + per-market cells within 2 checks of `cellPass`, each
with what it still misses), next week's High-impact news (coins: USD only), plain-words `lessons`, and a READINESS checklist
(lab report < 2.5 h old and no lab error, no stale markets, something proven live — "nothing passes" only waits, account
readable + risk mode, forex: no trade left open over the weekend). `WeekendReview` (index.ts, every 15 min): while it's the
weekend for the desk (`isWeekendFor`: forex market closed / coins UTC Sat–Sun) rebuilds the recap every `WEEKEND.everyHours`
4 → Redis `fx:weekend` / `cm:weekend` {recap, ai} + `fx:weekend:hist` (12); ONE Claude review a UTC day per desk
(`AI_WEEKEND_MODEL` → `AI_MODEL` → claude-sonnet-5-5, `aiBudgetUsd` 0.3/day in `fx:weekend:spend:<day>` + `ai:spend:<day>`,
`AI_WEEKEND=off` disables; summary / went well / went wrong / ideas for the lab to TEST / watch Monday); `readyPushMin` 90 min
before forex opens on Sunday → FxNotice kind 'ready' (`ok`) once per desk (`fx:readypush:<day>` NX), push rides the `fxWeek`
switch. API GET `/api/<desk>/weekend` {review, history}, POST `/weekend/run` (builds now, any day). Dashboard Trades page
`components/FxWeekend.tsx` `WeekendCard` (under the Today brief): headline, checklist, lessons, AI review, details (money,
live vs tested, held back, closest to live, big news). DISPLAY ONLY: nothing changes a rule, size or the chosen list — the
lab's hourly re-test (it runs on weekends too) + the weekend luck meter + the restricted learner remain the only things that
change what trades. tests/forex-weekend (5).
## v27.31 forex keeps pivot_bounce where it proved itself + the crypto "today" fix (Oct 23, owner: "forex may still use daily
pivot R1 / S1, it's performing too; I just want it to use what definitely works"; screenshot: crypto home "Account $1056,
−$67.01 today" next to "Today $0.00")
- `FX_CONFIG.provenOnly.cells` {fx true, crypto false}: under provenOnly `planChosen` = Edge row OR the strict per-market bar
  (`cellPass`: 30+ unseen there, +0.1R, PF 1.3, positive before the line, Monte Carlo 95%) on a forex-desk market. Oct 21
  VPS: that is pivot_bounce:4h on RUTUSD (108, +0.19R, PF 2.40) and NDXUSD (106, +0.19R, PF 2.47); trial / work bars stay
  off. Such trades get the same 20% all-in size (shared 20% cap). Coins stay rsi_dip only.
- ControlRoom hub "Account … today" summed the last 24 h of closes (rolling) — the 4 Oct 22 afternoon closes made −$67.01
  while the calendar day (P&L log) was $0.00 after the v27.29 strike. Now it shows `pnl.periods.today` (fallback: closes
  since local midnight). Week = Month = All time on the coin desk is correct: its account started this week (Oct 20) and
  $1056 = $1000 + $55.81. Hub label says "Your coin bot" on the crypto desk.
## v27.30 trade-open alerts, weekly log, skip the slices it loses on (Oct 23, owner: "a notification when it enters a trade,
a weekly log, and make it skip charts it loses on"; VPS 16:08 UTC: coin rsi_dip 4h by NY session over all 106 trades = Asia
50 / +0.50R, London 19 / −0.24R, NY open 11 / +0.17R, NY afternoon 26 / +0.10R; Asia positive on 7 of 8 coins, London
negative on 5; the report holds no per-trade list, so no weekday / side split)
- **Skip losers** (`FX_CONFIG.skipLosers` {on, minN 8, keepShare 0.6}, lab.ts `losingSlices` / `inSkipped`): in
  `evaluateTf` (both labs), after the filter / exit / entry picks, the New York sessions (montecarlo `sessionOf`) and the
  markets where the row's FIRST 70% lost on 8+ trades are cut from its trades — record, unseen grade (verdict / Edge),
  paper trades, per-market stats and the open trades handed to the bot — unless that leaves < 60% of the first-70% trades.
  `Row.skip` {sessions, pairs, cut [first, unseen]}; Strategies drawer line "Skips where it lost before the test line".
  Every row is re-graded → one re-pick event. The luck twins don't skip (their yardstick is a little easier).
- **Trade-open alerts**: `FxNotice.kind` 'open' (+ `tf`, `targetPnlUsd`, `riskPct`), raised in `openIn` for bot trades
  (they carry a lab ref; a weekend re-open alerts again); push.ts `fxOpen` (default on) → "📈 Coin bot sold XRP/USD —
  rsi_dip 4h · stop −$200 · target +$400 (20% of the account at risk)". Owner's own trades never alert. Labels now Forex bot /
  Coin bot / Your trade; taps open /forex/bot or /crypto/bot.
- **Weekly log**: pnl.ts `mondayOf`, `weeklyLog` (Monday-start weeks in the viewer's clock, newest first, ≤ 26: money,
  trades, wins, best / worst, per strategy, per market), `weekText`; `PnlReport.weeks` → FxPnl card "Weekly log" (tap a
  week). index.ts `weekPush`: Mondays after 00:05 UTC, last week's line per bot once (`fx:weekpush:<acct>:<monday>` NX) →
  FxNotice 'week' → push setting `fxWeek` (default on). Controls → Alerts has both toggles. tests/forex-v27-30 (5).
## v27.29 coin bot today struck (Oct 23, owner: "only trade rsi, revert the results from today, keep everything else in the lab
unless profitable") — the chooser already does the rest (v27.27 provenOnly: only Edge rows; today that is coin rsi_dip:4h).
One-time `v27.29-undo-coin-oct23` (index.ts): `undoClosed('cbot', not rsi_dip, closed Oct 23 UTC)` (balance, stats, R ledger,
P&L log; read 13:34 UTC: 5 trades, −$62.49) + `undoPositions('cbot', not rsi_dip)` (the open DOGE round_break 4h long, −$10.69
then); their refs go on `skipRefs`. Forex untouched.
## v27.28 tight trailing stop once in profit (Oct 23, owner: "I need it to trail its SL VERY tightly if it's in profit"; asked
first what 20% margin at 1:200 would do — told: a 0.5% move against liquidates it, every tested stop is wider, keep risk sizing)
`PROFIT_LOCK` (profit-lock.ts) ⅓ / ⅓ / 0.1 → **atFrac 0.15, gapFrac 0.15, keepFrac 0.05**: on a 2R target the lock arms at
+0.3R, the stop jumps to entry + costs + 0.1R, then trails 0.3R behind the best price (only tighter). Same object drives the
engine (every lab row, paper trade, honest test) and both bot accounts → the strict test grades this exit → ONE re-pick event
after deploy, and rsi_dip:4h may lose its Edge (then the coin bot waits; Lab → "Profit lock" shows with vs without).
Positions already open keep the plan they armed with. Tests that pin the old numbers set them back at the top (forex-pnl,
forex-v14, forex-profit-lock); forex-proven-only (+1).
## v27.27 only proven strategies trade, both desks, big size (Oct 23, owner: "only trade what actually is profitable on forex
and crypto with a big big size like rsi dip; everything else keep testing in the lab; if something else ends up doing really
good I want it on; all strategies that aren't profitable off")
`FX_CONFIG.provenOnly` {on true, riskPct 20} (lab.ts) replaces the v27.26 fixed list (`only` now empty, `BOT.allIn` {}):
- Chooser (hourly + fast `chosenOf`): ONLY rows with verdict 'edge' (the strict test: 30+ unseen trades, both halves
  positive, PF 1.2+, beats random, luck twins, deflated Sharpe ≥ 50%) that clear the profit floor and aren't dropped by the
  learner. `planChosen` returns the row's own answer first → no side doors (per-market cells / trial / work bars, owner
  trials, ownerLive ICT picks, botAlways, rolling picker; desks already study-only). A row that earns Edge goes live by itself;
  one that loses it stops opening (its open trades run out on their own stops). Empty list → log "only proven strategies
  trade: none passes the strict test right now — the bot waits".
- Size: `toLabTrade` sets `LabOpenTrade.allIn` = 20 on every chosen trade → syncBot's v27.26 all-in path (20% of the account
  on the tested stop, all all-in trades together ≤ 20%, past the mode / currency / heat caps, the $20 cap skips it).
VPS 15:36 UTC: coins = rsi_dip:4h only (the one Edge row); forex = NOTHING (0 Edge rows; best pivot_bounce:4h real % 0)
→ the forex bot waits until a row earns Edge. `provenOnly.on = false` = the older choosers (tests that pin those set it at
the top: forex-ict, forex-montecarlo, forex-profit-floor). tests/forex-proven-only (3, was forex-v27-26).
## v27.26 coin bot = ONE strategy, all in (Oct 23, owner: "I don't need 100 strategies, just 1 that sticks… if it happens
trade it with extreme size up to 20% of the wallet")
VPS read 15:36 UTC: of every row on both desks only coin `rsi_dip:4h` passes the strict test (46 unseen, +0.41R, PF 2.68,
deflated Sharpe 89%); every other chosen row 'maybe' with real % ≈ 0; coin 4h RANDOM entries made +0.05R (pivot_bounce 4h
0.07 barely beats it); the coin bot's own closes −9.1R on 29 trades (every profitable day came from the owner's hand closes).
`FX_CONFIG.only` {fx [], crypto ['rsi_dip:4h']} + `onlyOk(universe, strategy, tf)` (lab.ts): checked in `planChosen` (by the
pair's desk), the hourly chooser and fast `chosenOf(…, universe)` → the coin bot opens nothing else (other rows stay graded;
held trades run out on their own stops). `BOT.allIn` {cbot: {'rsi_dip:4h': 20}} (practice.ts syncBot): such a trade risks
20% of the account on its TESTED stop (all all-in trades together ≤ 20%), coin leverage cap 20×, up to
`BOT.allInMarginShare` 90% of free margin, past the risk mode / currency cap / heat cap / streak; `PracticePosition.allIn`
→ the account's $20 loss cap (`tick`) leaves it alone. Expect ~1–2 coin trades a week. Told plainly: three losers in a row
≈ −49%. Empty `only.crypto` / `allIn.cbot` = back to the old setup. Forex unchanged. tests/forex-v27-26 (2).
## v27.25 no losing-streak brake, only the max loss (Oct 23, owner: "there doesn't have to be a cooling-off system, just a
max loss system") — `BOT.streak.on` false: no half size after 3 losses, no 4-hour pause after 4; the $20 per-trade loss cap
(`maxLossUsdByAcct`, both bots) stays. `lossStreak` kept; `on: true` restores it. VPS read 10:00 UTC (590aec1): doubling up
ACTIVE on both desks (forex unseen together +0.02R vs alone −0.13R; coins +0.06R vs −0.17R) — the gap is mostly lone
signals losing; coin cap saved $53 on 3 stops.
## v27.24 how it could have won, the losing-streak brake, doubling up tested in the lab (Oct 23, owner: "and how to have
turned it into a win"; "every bot can lose but 4 losses in a row is different"; "if you think doubling up is worth it to
try in lab then do it")
- **How it could have won** (loss-review.ts `howToWin(closed, bars, barMs)`, pure): from the candles since the entry
  (15m trades on 15m candles, else hourly — `loadFastBars` / `loadBars` in `noteLosses`): `bank_early` (it was ≥ +0.5R
  of the TESTED stop distance before the exit), `tested_stop` (target reached later and the worst dip stayed inside the
  tested stop — the cap cut it), `wider_stop` (target reached after a dip up to 2× the tested stop; also "entering at X
  after the dip"), `later_entry` (dip > 2×), `skip` (target never reached). `LossReview.win`, bot-log line "— how it
  could have won: …", `lossSummary.winKinds`. Display / evidence only — nothing is changed by it automatically.
- **Losing-streak brake** (practice.ts `BOT.streak` {halveAt 3, pauseAt 4, pauseHours 4, factor 0.5}, `lossStreak(closed)`
  pure: newest bot closes until a win; manual / partial / weekend skipped): 3+ in a row → every new trade's risk × 0.5
  until a win; 4+ → no new trades for 4 h after the last loss (wait "N losses in a row — no new trades until HH:MM UTC").
  Per account (each desk). A safety rule, NOT graded (like the VIX brake). why.ts kinds `streak` / `doubled`.
- **Doubling up, tested** (`src/forex/confluence.ts`, pure): `isTogether` (another strategy, same market and direction,
  within `CONFLUENCE.bars` 2 candles) + `confluenceStudy(picked rows' finished trades, oosFrom)` → first-70% / unseen
  avg R for "together" vs "alone"; `active` only with ≥ 60 unseen together trades, unseen edge ≥ +0.1R AND the first part
  pointing the same way → `mult` 1.5. Hourly lab: Redis `fx:confluence` / `cm:confluence`, `/api/<desk>/bot`
  `confluence`; when active a lab open trade with a chosen partner gets sizeF × 1.5 → ONE bigger trade (clampRisk's 1.5×
  ceiling; the v27.23 one-bet-per-market-and-direction rule stays). 15m charts not included. Card line on the Trades
  page loss-review card. tests/forex-v27-24 (6).
## v27.23 every losing trade gets reviewed + one bet per market and direction (Oct 23, owner: "any time a loss happens
that's not a bug, analyse it thoroughly and make sure it doesn't happen again"; told plainly: losses can't be stopped,
only the avoidable kind)
VPS read 08:25 UTC: since the cap (Oct 22 17:00) the coin bot had 4 cap stops (−$81): on 3 the lab's tested trade hit
the ORIGINAL stop too (the cap saved $68), 1 (ETH round_break) still open in the lab at −0.29R; 2 of the 4 were the same
LINK candle bought by news_drift AND momentum_bar (a doubled bet). Owner asked "is the tight SL needed for crypto?" →
kept: the data says it saves money so far. Built:
- `BOT.onePerMarketSide` (practice.ts syncBot): no second open trade / resting order on the same market and direction,
  whatever the strategy → skip "already in a buy trade on this market (one bet per market and direction)". Both desks.
- `src/forex/loss-review.ts` (pure): `reviewLoss` grades each losing close (not manual / partial / weekend) against the
  lab's paper trade with the same ref (`tradeKey`): **normal** (the tested trade lost too) / **avoidable** (causes:
  `doubled` — `doubledWith` finds an overlapping same-market same-side trade; `loss_cap` — a cap stop while the tested
  trade ended better than −0.5R; `worse_than_test`) / **pending** (tested trade still running) / **unknown** (none after
  3 days); `capDelta` on cap stops = USD saved (+) / cost (−) vs the tested result at the original size;
  `reviewLosses` (finished reviews kept, pending re-graded, struck trades dropped), `lossSummary` (counts / USD by
  verdict and cause, `capSavedUsd`, `capVerdict` "the loss cap is costing money" once 5+ cap stops net negative).
  `ForexLab.noteLosses(closedLab, labOpenRefs)` after every sync (hourly: `out.report.paper.recent`; fast: its report's)
  → Redis `fx:lossrev` / `cm:lossrev` (150) + one bot-log line per finished review ("loss review: … → normal loss /
  AVOIDABLE: … — fix: …"); `Practice.rawAccount(acct)`. `/api/<desk>/bot` → `losses`; Trades page card "Why it lost
  (loss review)" (`components/FxLosses.tsx`). Avoidable causes map to rules: doubled → the new guard; loss_cap → the cap
  check above; worse_than_test / repeated normal losses → the restricted learner (halves / drops a losing
  strategy:chart on the bot's own record). tests/forex-loss-review (5); forex-v17 delayed-feed test now uses a sell for
  its second EURUSD trade (the guard blocks a second buy).
## v27.22 the forex bot gets the $20 loss cap too (Oct 22, owner: "does forex not have a stoploss? … the SL also for forex
past 20") — `BOT.maxLossUsdByAcct` {cbot: 20, bot: 20}: same stop pull-in as v27.20, size unchanged. tests/forex-loss-cap.
Then (owner: "take away the trade that's −60 right now, don't make it count"): the open forex NZDUSD pivot_bounce:4h long
(opened ~20:05 UTC before the cap, −$63, $82 at its stop) is struck once (`oneTimeUpgrade('v27.22-undo-nzd-pivot')`):
`undoPositions(a, pick)` (open positions + parts + booked rolls) and, in case the cap closed it at market first,
`undoClosed` too; both add the trade's ref to `PracticeAccount.skipRefs` (newest 50) and `syncBot` never opens a struck
ref again (else the still-fresh lab trade would be re-opened). tests in forex-loss-cap (+1).
## v27.21 losing-market check on the 15-minute chart too (Oct 22, owner: "stupid crypto trades, is it rushing — check if the
latest losers are justifiable")
VPS read of the coin bot's 12 latest losers (−$322, 11 of 12 full −1R stops): 9 came from strategies proven on that coin
(strict cells, e.g. pivot_bounce:4h SOL 188 unseen +0.16R PF 2.19) and, where visible, the lab lost the same trade → normal
losses. NOT justified: 3 mss_sweep:15m shorts (BTC / ETH / DOGE, −$79) on coins where that rule's record was PF 0.06–0.62 —
the fast lab never set `marketRec`, so the losing-market wait only existed on 1h / 4h. Entries were not rushed (1h / 4h open
4–7 min after the close: the lab run; 15m ≈ 45 s). Now `marketRecOf(rec, cell, ownerTrial)` (lab.ts, pure) is used by both
labs: losing = 12+ trades at PF < 0.9 (as before) OR 5+ at PF < 0.6 OR — unless the strategy proved itself on that market
(cellPass / trial bars) — 4+ unseen trades there with a negative average (`strict.market` {badN 5, badPf 0.6, cellMinN 4}).
tests/forex-market-rec (3). Owner: "revert the last 3 losses if it was a bug" → `undoClosed(a, pick)` (practice.ts, pure:
closed rows + their parts, balance, `stats`, R ledger) + `Practice.undoClosed(acct, pick, label)` (also the P&L log), run
once at start (`oneTimeUpgrade('v27.21-undo-mss-15m')`): cbot, mss_sweep 15m, BTC / ETH / DOGE, closed Oct 21 00–14 UTC,
losses only → bot-log line with the USD put back. tests/forex-market-rec (+1).
Then (owner: "needs to be added onto the PnL"): the $79.37 shows on TODAY — P&L-log correction rows (reason 'adjust',
`isTrade` false, dashboard "correction"; `Practice.bookAdjust`), once (`v27.21-mss-credit-today`): Oct 21 −79.37, today
+79.37 → Oct 21 back to its old total, today +79.37; balance and all-time unchanged.
## v27.20 coin bot: no trade loses more than $20; memecoins buy again (Oct 22, owner: "memecoins barely buy, also make the SL
on crypto much stricter, not past $20")
- **Loss cap** (practice.ts): `BOT.maxLossUsdByAcct` {cbot: 20} → `PracticeAccount.maxLossUsd` (set by syncBot). Size stays the
  risk mode's (owner, after a first version shrank the size: "no smaller trades, still turbo, just a tighter SL"). `tick`: any
  trade whose stop would lose more than $20 gets the stop pulled in to the $20 loss (never loosened) — at turbo that is roughly
  a quarter of the tested stop distance, so more stop-outs than the backtest; one already past it closes at the market. Gaps
  can still fill a little past. The forex bot has no cap. tests/forex-loss-cap (3).
- **Memecoins** (VPS 16:51 UTC: 0 buys in 55 h; 467 coins / h; all 14 Migration rule-passes refused by **Sniper mode, ON again**
  although v54 / v57 had set it off — changed from Controls or another path, not traced; curve / SOON coins stopped by bundlers
  > 18%, safety hard fails, liquidity < 5 SOL, too few active wallets, curve outside 70–90%; 81% of checkpoints still waiting
  for their safety check = the throughput limit, left as is). Migration **v59** (create): `sniper.enabled` false, bundlers 25%
  (half size ≤ 35%), liquidity 2 SOL, migrated holders 20, SOON curve 50–95%. Hard safety fails / rug / bundle / vamp guards stay.
## v27.19 forex trades like the coin bot + memecoins practise a lot (Oct 22, owner: "what does crypto do so different… I want forex
to perform like crypto" → chose "Both"; "make memecoin requirements basic so memecoins can practise A LOT in the background")
Told plainly: the coin bot trades more because coins are 24/7 and 9 rows + ~20 market cells pass there vs 1 row + ~6 cells on
forex; its own closes are ~−$220 (the profit was the owner's hand closes), so "more trades" ≠ more money. Changed:
- `FX_CONFIG.botFastCharts` **true**: forex strategies that cleared the bar on the 15-minute chart trade it (fast.ts
  `isChosen`; CME indices / metals excluded — `isFutures`, their Yahoo price is ~10 min late). `FX_CONFIG.focus.mode`
  **'prefer'**: every forex market trades what passed there; the focus markets pick first. Tests that pin the old
  defaults set them at the file top (forex-v15, forex-montecarlo, forex-profit-floor) or inside the test (ict, v18-7).
- Memecoin bot (paper, pump.fun) — migration **v58** (create): max 40 positions, score bar 35, safety 40, sellers-in-control
  70%, owner filters loosened (migrated 25 holders / 3 SOL fees / $15k MC, soon $5k volume / $6k MC, narrative off),
  holders new pair 5 / soon 20, active wallets soon 12 / migrated 8, chase caps +40% / 1 min, +80% / 3 min, buyers ≥ 45%,
  entry quality 1 buyer / volume ratio 0.1, learning trades margin 30 / 25 open / 150 an hour / drought 10 min,
  thin-coin probes 40 an hour. Kept: hard safety fails, rug / bundle / vamp / dumper / deployer guards, sizes, usage
  budgets. tests in crypto-reset (+1).
## v27.18 delayed CME prices no longer block hourly / 4-hour trades (Oct 22, owner: "46 fired · 0 opened like it's NOT trading there")
VPS read 16:16 UTC (1f9c9fc): 24 h = 29 signals from traded strategies, 2 opened; the main hold-back was "skipped RUTUSD / DJIUSD /
NDXUSD / XAUUSD: the newest price is 10 min old (this chart needs ≤ 10 min)" — incl. RUTUSD pivot_bounce:4h, a strict-proven
cell, twice. Yahoo's CME futures (indices + metals) are ~10 min late but the chart meta declares no delay
(`exchangeDataDelayedBy` 0), so v17's `feedDelayOk` added nothing. `BOT.futuresDelayMs` 15 min: `openIn` uses
max(declared delay, 15 min on `isFutures` markets) for hourly / 4-hour trades (`feedDelayOk`); 15m / 1m and currency pairs
unchanged. ("46 fired" on the home = every strategy's signals on that close; the 1h run had 3 from strategies it trades.)
tests in forex-v17 (+1).
## v27.17 pivot ladder: + middle of yesterday's range + S3 / R3 (Oct 22, owner's second level list 29,813.75 / 29,770.75 /
29,664.25 / (29,601.25): "more signs make forex trade more and better")
Those are the range middle ((H + L) ÷ 2 ≈ 29,812.6), S1, S2 and S3 = L − 2(H − P) ≈ 29,599.5 from the same day as v27.16.
`pivotLadderSignal` now also buys / sells the middle of yesterday's range (both sides) and S3 / R3 = H + 2(P − L); same entry,
½ ATR stop, yesterday's high / low target, 1.5R minimum room. It stays one lab row (`pivot_ladder`), graded like every row.
tests/forex-pivot-ladder (+1).
## v27.16 pivot ladder — the friend's MNQ trades (Oct 22, owner's 1-minute MNQ chart + level list "another trade taken today")
The owner's levels 30,004.75 / 29,941.59 / 29,834.50 / 29,770.75 / 29,664.50 are the classic daily pivots R2 / R1 / P / S1 / S2
(yesterday H ≈ 29,898, L ≈ 29,727 — also in the list; 29,792.75 unexplained); the friend bought at P / S1 / 29,792.75 with ~10-pt
stops, all targeting ~29,899 = yesterday's high. strategies.ts **`pivot_ladder`** (`pivotLadderSignal`, `LADDER` {stopAtr 0.5,
minR 1.5}, family reversion, every chart / market): the candle comes down into P / S1 / S2 (previous candle still above it),
trades through and closes back above → long, stop ½ ATR under the level, target yesterday's HIGH if ≥ 1.5R away; shorts mirrored
with P / R1 / R2 → yesterday's LOW. Days = UTC days like `pivot_bounce` (CME's 17:00 NY session would shift the levels a little).
Graded like every row; trades only where the lab finds it works. 1-minute isn't a bot chart (v18.8) and Yahoo's index price is
~10 min delayed, so the 15m Nasdaq version can't open live (v27.2 note). tests/forex-pivot-ladder (2).
## v27.15 the untested market-checks gate is off (Oct 21 22:45 UTC, owner: "all these strategies and skills but not one trade")
VPS read (4ab2943): 26.7 h without a forex open; 24 h = 80 checks, 2,579 signals, 3 from traded strategies, 0 opened; the only
waits were SPXUSD pivot_bounce 4h shorts "only 0 of 3 market checks agree"; the other chosen-strategy signals (USDJPY / NZDUSD
pivot_bounce, XAU cci_break) were held back by the rows' own TESTED filters (strength / bigger chart) — left as is. Proven /
trial cells: S pivot_bounce:4h RUT (108, +0.19R, PF 2.40) + NDX (106, +0.19R, 2.47); T pivot_bounce:4h DJI, weekend_gap:1h NDX,
round_break:4h XAU (42, +0.19R, 1.93), cci_break:1h XAU. `FX_CONFIG.strict.minAgree` 1 → **0**: the agree gate was never in a
backtest and for bounce / fade rules the bigger-chart trend points against the trade by design. Live = what the test took; the
shadow book keeps scoring. Put 1 back to restore it. forex-strict expectation updated.
## v27.14 the friend's two ICT trades as lab strategies (Oct 21, owner's annotated chart: "a friend of mine took it, he's profitable")
Chart: long = filled a 30m FVG, then IFVG + CISD + good displacement, TP the previous week's high; short = a 5m gap inverted,
retrace into the CE (middle) of the new 5m gap, initial TP the swing low, stopped at the trailed high. strategies.ts (family
'ict', any chart / market, written once as the long and mirrored through `sided`): **`ifvg_cisd`** (`ifvgSignal`: a gap against
the trade in the last `ICT.ifvgLook` 12 candles, the move into the low swept the 10 candles before it, then one candle with body
≥ `ifvgBodyAtr` 1 ATR closes above the gap's top (first close through only) AND above the open of the down-run that made the low
(CISD) → stop under the low, 2R) and **`fvg_ce`** (`fvgCeSignal`: a displacement candle (≥ 1.2 ATR) closes through a gap that
had held for up to `ceInvLook` 20 candles (inversion) and leaves its own gap; within 6 candles the first touch of that gap's
middle that closes back away → enter; a close through the gap = dead; stop under the retrace low / gap, 2R). NOT owner-live:
graded like every row and they trade only where the lab finds they work (profit floor / per-market tiers, v27.10–v27.13).
The run-past-target trailing stop (v27.8) stands in for "TP at PWH / trail". The higher-chart "filled the 30m FVG" context is
left to the filter lab (mtf). tests/forex-ifvg (5).
## v27.13 use what works, on every forex market (Oct 21, owner: "the +42R on the Russell counts all its tested trades, so use the
strategies that worked … use what works actively and trade actively")
New tier `workTrial(pair, cell, rec)` (lab.ts, `FX_CONFIG.workTry` {on, sizeF 0.5, minN 30, minPf 1.2, minTotalR 5, minOosN 10}):
a strategy × chart whose ALL tested trades on that forex market (`Row.pairs` record: n, pf, totalR) show 30+ trades, PF 1.2+ and
+5R, with 10+ unseen trades there whose average isn't negative, and which clears neither `cellPass` nor `cellTry`, trades there at
half size (× vol / learner / VIX as usual). Never a coin. `planChosen` counts it as proven (past the focus list and any market plan;
the learner's drop still wins); `provenCells` / plan messages / `rowFor` / the dead check include it. **`FX_CONFIG.marketPlan` = {}**
(was NDX Judas-only): the Nasdaq trades every strategy that works there; the v27.11 owner trial keeps Judas on NDX 1h. Weaker than
the unseen-only bars (the all-trades record includes the first 70% the rows were picked on) — owner's call, half size for that
reason; judge it on the bot's R ledger / shadow book. Switch off: `workTry.on = false`. Test in forex-profit-floor (+1).
## v27.12 month-end flow + pin bar as quarter-size trials (Oct 21, owner: "add month end and pin bar")
VPS read 15:33 UTC (bced1fa): closest rows to the profit floor = month_end_flow:1h (21 unseen, +0.80R, PF 7.11, 86% won,
first part +0.27R, MC 1.00) and pin_bar:4h (26, +0.42R, PF 2.63, first part +0.11R, MC 0.97) — both fail only n ≥ 30.
`FX_CONFIG.ownerTrials` + {pair '*', month_end_flow, 1h, 0.25} and {pair '*', pin_bar, 4h, 0.25}: '*' = every forex-desk
market, never a coin (`ownerTrialOf`); for '*' trials the losing-record-on-this-market wait still applies (only the one-market
Judas trial forces `marketRec.ok`). Also seen: coin bot −$134 today on 13 trades, 5 correlated BTC / XRP longs at max mode —
owner offered a same-direction cap / lower coin risk, not decided. Test in forex-profit-floor (+1).
## v27.11 Judas swing back on the Nasdaq hourly at a quarter size (Oct 21, owner chose "B")
Owner saw a Judas swing on the Nasdaq that wasn't taken. VPS read 14:23 UTC: judas_swing 1h 'no' (unseen 295 / −0.23R / PF 0.61),
NDX record 172 trades / PF 0.89 / −8.9R → the v27.2 plan's losing rule switched it off there; the 15m row has 5 NDX trades
but Yahoo's CME price is ~10 min delayed and 15m never opens on a delayed price. Owner offered (a) leave off / (b) hourly at a
quarter size / (c) 15m with a real-time feed → chose B. `FX_CONFIG.ownerTrials` [{NDXUSD, judas_swing, 1h, sizeF 0.25}] +
`ownerTrialOf(strategy, tf, pair)`: `planChosen(…, tf)` returns true for it first (skips profit floor, focus, the plan's
losing rule), hourly `botTrades` sizes it at 0.25 (× vol / learner / VIX) and its `marketRec.ok` is forced true; `rowFor`
returns its row. Judge / checks / news / caps / learner drop still apply. Callers now pass `tf` to planChosen (both labs).
Test in forex-profit-floor (+1).
## v27.10 every chart checked: proven strategies trade where they proved themselves (Oct 21, owner: "check all other charts too")
VPS read 12:32 UTC (9adcad0), per market (strict = `cellPass`, trial = `cellTry`): FOREX strict = NDX pivot_bounce:4h (106
unseen, +0.19R, PF 2.47) and RUT pivot_bounce:4h (108, +0.19R, PF 2.40); trial = DJI pivot_bounce:4h (84, +0.11R, PF 1.66),
NDX weekend_gap:1h (22, +0.49R), gold cci_break:1h / round_break:4h; every currency pair 0 on both bars (best near-misses:
SPX pivot_bounce:4h fails Monte Carlo only (0.84), USDCAD pdh_pdl:1h first part exactly 0). CRYPTO 20 strict cells (BTC 5,
XRP 5, ETH 3, SOL 3, DOGE 3, LINK 1; ADA / AVAX 0; news_drift:1h strict on BTC / ETH / SOL / XRP, pivot_bounce:4h on BTC / SOL /
XRP / LINK) + 44 trial cells. Before this, RUT / DJI were shut by the focus list and NDX by the Judas-only market plan.
Changed: `planChosen` → a strategy proven on THAT market (cellPass or `focusTrial`) trades there first, past the focus list and
next to a market plan's own strategies (the learner's drop still wins); unproven strategies keep the old focus / plan rules.
`focusTrial` = every forex-desk market (was the focus list), never a coin (coins have 20 full-bar cells; the trial bar would add
44 thin ones). `provenCells(rows)` → `ForexLab.proven` (set in syncFrom + from the stored report at start) → plan
`PlanInputs.proven` (no "not a focus market" / "not on this market's list" for them). Dashboard trial badge on every forex
market tab. Tests in forex-profit-floor (+1), forex-montecarlo expectation updated.
## v27.9 trial bar on the focus markets (Oct 21, owner: "look at gold 5%, it has a lot of good trades; if a chart has good
strategies I want you to use them")
VPS read 12:26 UTC (9adcad0, risk mode turbo, chosen = pivot_bounce:4h only): 85 of 99 rows have gold trades; NONE clears the
strict market bar (`cellPass`); on a looser bar only `cci_break:1h` (26 unseen gold trades) and `round_break:4h` (20) pass;
the best-looking one, `psar_adx:1h` (43 unseen, +0.25R, PF 1.89), LOST before the 70/30 line (−0.08R) → stays out. The
"5%" numbers on the page are the pooled row at 5% risk (every market), and most rows' worst drop there is ~90%. Built:
`MARKET_TRY` + `cellTry` (montecarlo.ts: 20+ unseen, +0.05R, PF 1.15+, 10+ trades before the line and profitable there,
Monte Carlo 85%+), `FX_CONFIG.focusTry` {on, sizeF 0.5} + `focusTrial(pair, cell)` (lab.ts: only the FIXED focus markets —
gold, NDX, SPX, USDJPY, EURUSD — clears the trial bar but not `cellPass`) → `planChosen` lets it trade there; hourly
`botTrades` sizes it at 0.5 (× vol / learner / VIX as usual) when its row isn't chosen; a row with a trial cell is not
"dead". The learner can still drop it; the losing-record / judge / checks gates still apply. Fast charts unchanged (15m
trades only the ICT session rules). Dashboard market tab: "Trial on <market> · half size" badge + count line
(`cellTry` copy, `MarketResults focus`). Switch off: `focusTry.on = false`. Tests in forex-profit-floor (+1); forex-montecarlo
expectation updated (mcP 0.9 on USDJPY is now a trial).
## v27.8 run past the target + home / menu cleanup (Oct 21, owner: "if you're taking a trade you're allowed to go higher than
your TP, just set a tight trailing SL"; "remove why-no-trades from the middle of my screen, raise the chart under the P&L, not
what it's watching, and remove trade by hand")
- Engine `SimOpts.runPastTarget` (DEFAULT on, `RUN_PAST_TP` {on, atr 0.6}) + `withRunPastTarget(sig)`: every signal with a
  target and no trailing take-profit of its own gets `tpTrail` 0.6 ATR / `tpFrac` 0 → at the target the trade is NOT closed:
  the stop locks 0.6 ATR behind the target (never under break-even + costs) and trails the best close by 0.6 ATR (the v15
  trailing take-profit machinery). EVERY backtest / paper / honest-test trade includes it → ONE re-pick event after deploy.
  Live: lab open trades carry `tpTrailPx` → the bot positions inherit it → practice `tick` converts at the target. Positions
  opened before this deploy keep their old plan. Tests that pin the target exit set `DEFAULT_SIM.runPastTarget = false` at the
  top (forex, v14, v15, entries, profit-lock); tests/forex-run-past-tp (2).
- Dashboard: ControlRoom hub — the "Why no trades?" line removed (it stays on the Trades page's Today card), the big screen
  (chart) now sits right under the P&L strip and the PlanBoard ("the plan, market by market") under the chart.
  **Trade by hand removed**: nav entries (forex + crypto), the `practice` section, the Markets drawer's "Trade X yourself"
  button and `components/FxTrade.tsx` (the owner's 'me' account + `/api/forex/practice*` routes stay on the server, unused
  by the UI). Verified by rendering (shots room.mjs at 390 px).
## v27.7 the strongest currencies back on the focus list (Oct 21, owner: "add the strongest currencies also back on the list")
`FX_CONFIG.focus.strong` {on, top 2, minGap 0.6} + `strongPairs(strengthNow)` (lab.ts, pure): traded FX pairs that put one of
the 2 strongest currencies of the strength meter against one of the 2 weakest, gap ≥ 0.6 → `setStrongFocus` (module set
`strongFocus`, rebuilt each hourly run in computeRun (fx lab only), in `syncFrom` from the report (worker runs) and at start
from the stored report). `focusOk` / `focusPrio` accept them; `focusMarkets()` = fixed five + this hour's strong pairs →
`/api/forex/bot` plan `focus`. Owner's screenshot (GBP +0.52, CAD +0.48 … JPY −0.33, USD −0.67) → GBPUSD, GBPJPY, USDCAD.
Direction is left to the strategies / strength check. Test in forex-profit-floor (+1).
## v27.6 VIX = expected volatility (Oct 21, owner: "look at the VIX index so you can see the expected volatility")
The VIX (^VIX, already a mood input since v13, only as its 24 h change) is now read as a level. mood.ts: `MoodBook.vixLvl` /
`vixRank` (rank among the previous ≤ 252 daily closes of days that ended before the hour's day, ≥ 60 needed — causal),
`VIX` {rankDays 252, minRankDays 60, panicRank 0.9, brake [[35, 0.5], [25, 0.75]]}, `vixRegime` (<15 calm / <20 normal /
<30 high / else extreme), `vixMove` (VIX ÷ √252 = expected S&P move a day, ÷ √52 a week), `vixFactor` (size brake),
`vixNowOf(book)`, `moodSeries(book, bars, barMin, 'vixRank' | 'vixLvl')`, `MoodNow.vix` {level, change, rank, regime, dayPct,
weekPct, sizeFactor, note}. Uses: (1) **size brake** — every bot trade's `sizeF` × `vixFactor` (hourly botTrades `vixBrake`,
fast decide) = 0.75× at VIX 25+, 0.5× at 35+: a safety rule, NOT graded (the honest test doesn't include it); (2) **filter
'vix'** (filters.ts `passVix`, `FilterEnv.vixRank` via makeSeries, coverage + missing-input label "VIX fear index"): no new
trade in the VIX's top 10% of the past year — picked per strategy on the FIRST 70% like every filter (12 variants now, lab
≈ +9% CPU); (3) dashboard Markets → Market mood card → "Expected volatility (VIX)" block (`VixBlock` in FxInsights: regime
badge, ±% a day / week, past-year rank, the brake note); FILTER_SHORT 'vix'. tests/forex-vix (3).
## v27.5 village removed, opening-range breakout, Kelly (Oct 21, owner: "look up Investopedia and what could help; remove
the village and clean everything up")
- **Village removed** (v19.1 / v19.3 / v21.1): `dashboard/src/components/Village.tsx` deleted, route `/forex/village`, nav entry
  and the control-room link gone; comments in why.ts / desks.ts updated. The v19–v21 notes above that mention it are history.
  No other dashboard file is unused (checked by import scan).
- **Investopedia** blocks automated readers (the search tool refuses investopedia.com); ideas came from other public trading
  pages instead. Built: `orb_ny` (strategies.ts, family session, 15m only, `ORB` {from 570, rangeTo 600, until 690, r 1.5}):
  9:30–10:00 New York range (two 15m candles, `sessionRange`), the FIRST 15m close outside it before 11:30 → that way, stop at
  the other side (the middle when that is > 4 ATR), 1.5R, flat 4 pm NY; DST-aware (the old `ny_open` uses fixed UTC 12–13
  and is off by an hour half the year — left as is, graded like any row); in NOT_FOR_CRYPTO. Kelly: `McResult.kellyPct`
  (win rate and avg win / avg loss of the unseen trades, ≤ 0 → 0); the Strategies drawer's Monte Carlo block shows it with
  quarter- / half-Kelly and warns when the chosen risk % is past half-Kelly. Display only — nothing is resized by it.
  tests/forex-orb (4).
## v27.4 Monte Carlo, per-market results, NY sessions, market-only edges (Oct 21, owner: "implement Monte Carlo; remove
strategies that clearly don't work, I don't want it flooded; test certain strategies on certain markets, results might vary;
in Strategies a tab for each currency with its results, by time frame and NY time")
`src/forex/montecarlo.ts` (pure, seeded mulberry32): `monteCarlo(rs)` (400 bootstrap reshuffles: pProfit, p5 / p50 R a trade,
ddR95 = 1-in-20 worst drop over 100 trades, streak95), `ddPctAt`, `sessionOf` / `bySession` (New York time: Asia 18–03, London
03–08, NY open 08–12, NY afternoon 12–18, by entry), `marketCells` (one row's finished trades per market: purged first-70% /
unseen split like statsOf, Monte Carlo on the unseen part (300 sims), sessions), `MARKET_EDGE` + `cellPass` (30+ unseen,
+0.1R, PF 1.3+, 20+ trades before the line and positive there, MC ≥ 95% — stricter than the row floor because ~1,800
market × strategy × chart tries get graded). Row (built in evaluateTf, so both labs): `mc`, `markets`, `sess`, `dead` (lost
before AND after the line with 30+ trades each and no market passes on its own). Row floor `profitFloor.minMcP` 0.9.
Chooser: `planChosen(…, cell)` → a strategy that passes `cellPass` on a market trades THERE even when its pooled row isn't
chosen (focus + market plan + learner drop still apply); hourly `rowFor` / `cellFor`, fast `followRows` include rows with a
passing cell. Dashboard: `components/FxMarketResults.tsx` (MarketResults, McBadge, McBlock, SessionStrip, dashboard copies of
cellPass / ddPctAt); Strategies page: market tabs (focus ★ first, remembered `fx.mkt`), dead rows folded ("Show the N that
clearly don't work"), "MC N%" badge per row, drawer = Monte Carlo block (worst drop at the chosen risk %) + NY-session strip;
a market tab lists every strategy × chart on that market with its own unseen record, MC, sessions, "Edge on <market>" /
"Doesn't work here" (both halves negative, folded). Verified by rendering (scratchpad shots/strat27.mjs, phone + desktop).
Report grows ~100–150 KB (cells). tests/forex-montecarlo (4).
## v27.3 focus markets (Oct 21, owner: "focus more on XAU/USD gold, Nasdaq 100 and 500, USD/JPY and EUR/USD")
`FX_CONFIG.focus` {mode 'only' | 'prefer', markets [XAUUSD, NDXUSD, SPXUSD, USDJPY, EURUSD]} (lab.ts). `focusOk(pair)` is checked
first inside `planChosen` (hourly botTrades + labOpen, fast `isChosen`): 'only' = the forex bot opens new trades on these five
alone (other markets stay graded, shown, and feed the strength meter; held trades keep their own stops); coins never affected.
`focusPrio` (+10 to `prio`, both labs) = first pick when the caps are full ('prefer' mode keeps every market but ranks these
first). plan.ts `PlanInputs.focus` (server passes it): focus markets sort first, `PlanMarket.focus`, signals elsewhere read
"not a focus market (…)", plan sentence "Not a focus market…". Dashboard ControlRoom PlanBoard + Scout: focus first + "Focus"
chip. Change the list / mode in one line. Tests in forex-profit-floor (+1).
## v27.2 market plan: specific strategies for specific markets (Oct 21, owner: "only do our Judas swing thing on NAS100 as
well, I want specific strategies for specific charts")
`FX_CONFIG.marketPlan` {NDXUSD: ['judas_swing']} + `planLosing` {minN 20, pf 1.0} + `planChosen(strategy, pair, rowChosen,
rec, dropped)` (lab.ts, pure): a listed market trades ONLY its listed strategies; a listed strategy trades there even when its
pooled row (all markets) isn't chosen / fails the profit floor, judged on its tested record on THAT market (`Row.pairs`, all
trades): off at 20+ trades with PF < 1, or when the learner dropped the row. Unlisted markets: the normal chooser. Wired: hourly
`botTrades` (`rowFor` = the chosen row, else the full row for a planned strategy → its filter / size factor 0.6 for 'no'),
`labOpen`, fast `decide` (follows planned rows on every market, `isChosen` per market), plan.ts `PlanInputs.marketPlan` ("not on
this market's list (Nasdaq 100 trades only judas_swing)"). Add a market / strategy = one line in `marketPlan`. NOTE: Yahoo's
CME quotes are ~10 min delayed, so the 15-minute Judas trade on NAS100 is refused by the stale-price guard (15m never uses a
delayed feed); the hourly one opens (1h / 4h may). A real-time index price feed is needed for 15m. Tests in
forex-profit-floor (+2).
## v27.1 profit floor: the less profitable strategies are off (Oct 21, owner: "remove less profitable bots")
VPS read 10:58 UTC: forex chosen = carry_trend:4h only (unseen 153 / 0.01R / PF 1.05; 98 of 99 rows 'no' after the fee re-pick);
every ICT / always-on row losing on unseen data (judas_swing 1h −0.45R PF 0.39, amd_daily 1h −0.18R, tsmom 1h −0.16R, fix_flow
−0.05R); coin desk 24 chosen rows, 18 at unseen PF 1.02–1.18 → −$71.53 today on 3 stops (trendline_break 1h ×2, mss_sweep 15m).
`FX_CONFIG.profitFloor` {on, minN 30, minAvgR 0.05, minPf 1.2} + `profitFloor(row)` (lab.ts, pure; = the quality bar's first
four checks): EVERY live row must clear it whatever put it on the list (verdict, botAlways, ownerLive, rolling picker), both
desks, hourly chooser + fast `chosenOf`. Expected after deploy: forex 0 chosen rows (carry_trend fails) → the bot waits and logs
"no strategy clears the profit floor"; coin desk ≈ 6 rows (rsi_dip 4h, news_fade 1h, news_drift 1h, mss_sweep 4h,
momentum_bar 1h, fib_pullback 4h). Also fixed the v25 precedence slip in the hourly chooser (`ownerLive.has(x.id) || mode ===
'edge' ? …` read as `(a || b) ? …`, so the ICT picks never got in on 1h / 4h). Held trades are kept on their own stops (v26.2).
Switch off: `profitFloor.on = false`. tests/forex-profit-floor (3).
## v27 US stock indices on the forex desk (Oct 21, owner: "I want it to trade Nasdaq too, Nasdaq 100 etc")
`INSTRUMENTS` + kind **'index'**: NDXUSD Nasdaq 100 (NQ=F), SPXUSD S&P 500 (ES=F), DJIUSD Dow 30 (YM=F), RUTUSD Russell 2000
(RTY=F) — Yahoo hourly CME futures, 730 days, graded by the forex lab like every market (18 markets; nothing trades one until
a row clears the bar on it). Ids end in USD so every base / quote reading sees a dollar-priced asset. types.ts: `isIndex`,
`isFutures` (metals + indices: no strength / CFTC / Dukascopy / Pyth / streamed price — Yahoo's futures quotes are delayed,
`feedDelayOk` covers 1h / 4h; the CME daily halt hour skipped in `lagBars`; judge 'metal' group), `INDEX.maxLeverage` 50 +
`maxLeverageFor` (bot leverage cap), `digitsOf`. `NOT_FOR_INDEX` (strategies.ts, in `runsOn`): currency-basket / rate / CFTC /
FX-flow rules (local_hours, fix_flow, month_end_flow, carry_trend, cot_squeeze, stretch_squeeze, ccy_momentum, stat_arb,
oil_cad, yield_jpy, stocks_jpy, dollar_gold, asian_fade); ICT / NY-open rules run. Financing −USD rate like a CFD (macro.ts
`NO_RATE`), USD calendar news + headlines pause them (headlines tag NDX / SPX / DJI / RUT on stock-market words), risk-on in
the mood check (`RISK_CLASS` NDX 1, SPX .8, DJI .6, RUT 1), round numbers 100 / 25 / 250 / 10 points, 1 unit = $1 a point.
Venue fee `VENUE_FEES.indexPct` 0.03% a side — NOT confirmed (search found no gTrade index rate). Dashboard `lib/markets.ts`
(digits / pip / TradingView `OANDA:NAS100USD` etc. for every market, replaces five copies), Trade by hand lists the indices,
news chips NDX / SPX. Lab run ≈ 30% longer (18 markets). tests/forex-indices (7).
## v26.5 gTrade fees confirmed, bigger trades, Turbo risk (Oct 21, owner: "check gTrade's real fees, also use more risk when
you trade for more profit")
Fees: gTrade's own docs (docs.gains.trade → Fees & Spread, via search extracts) = 0.012% open + 0.012% close of the position
on majors + ~0.01% spread → `VENUE_FEES` was right; third-party pages say 0.008–0.012%. Since the fee is a share of the
position, a wider stop at the same % risk means a smaller position and a smaller fee in R → exit lab variants `roomy`
(stop 1.6×, target 1.6×) and `swing` (stop 2.2×, target 2.5×, maxBars ×2.5, trailAtr × the stop factor) via `wider()`
(exits.ts); picked like every exit on the FIRST 70% only (`chooseVariant`), so a strategy switches only where it tested
better. Risk mode **turbo** (practice.ts `RISK_MODES`: 8% a trade, 500×, ccy cap 17%, heat 24%, conv cap 12%); honest
test level 8% (`portfolioRiskPct`); dashboard mode buttons (FxBot card 2×2 / 4 across, ControlRoom risk desk, FxBrief);
one-time `v26.5-turbo` switches the forex bot account to it (coin bot unchanged). tests/forex-roomy-exits (3).
## v26.4 news strategies trade the news (Oct 21, owner: "aren't you supposed to trade WITH news? why no trades")
VPS read 10:29 UTC: 14 h without an open; 2,187 signals in 24 h, only 106 from strategies the bot trades (1 opened, 6
skipped, 48 waits; 12 news waits = amd_daily 15m during an Iran-war headline); the hourly / 4-hour chosen list had
shrunk to `carry_trend:4h` alone — most likely the v26 fee re-pick (gTrade fee ≈ 0.024% of the price round trip = ~0.15R
on a 15-pip hourly stop) turned the Maybe rows into 'no'. Bug fixed: `news_drift` / `news_fade` were blocked by the same
news pause (calendar ±30 min, big headlines, 15-min price shock) that exists to protect every other strategy — the move
they trade. `NEWS_TRADERS` / `tradesNews` (strategies.ts); `ForexCalendar.blockFor(pair, now, newsTrader)` → holidays only
(`newsBlock(…, holidaysOnly)`); `syncBot` blockFor gets `(pair, strategy)` and skips `priceShock` for them; both labs skip
the headline block for them. Their backtests never had the pause, so live now matches the test. tests/forex-news-traders (3).
## v26.3 charts that don't glitch (Oct 21, owner's screenshot: "fix the charts, they often bug a lot")
Seen on the control-room big screen: trendlines ran off the plot over the price labels / time axis (their ends were clamped
to the edge separately, which also bent them), stopped half a candle short of the newest one, a moving 1 px "scanline"
crossed the whole screen like a stray price line, and the screen hopped between markets on every refresh. Fixes:
`MarketChart` — `cleanBars` (drops candles with a missing / NaN price, sorts, one per time, widens a high / low that
misses the body; a bad candle used to blank the whole SVG), a `clipPath` (`useId`) around everything drawn on the plot,
trendlines as polylines through each candle's centre to the right edge (`linePoints`), hover index guarded. `useWidth`
= a callback ref (with `.current`) that re-observes when its element mounts later — charts inside a toggle / drawer /
loading state (Trade by hand "Bot's view", Markets drawer, active trade) stayed blank forever before; one width read per
frame, ±2 px jitter ignored. ControlRoom: scanline removed (CSS `cr-scan` gone); the automatic market on screen sticks
(`autoRef`) until a trade opens elsewhere or its market disappears. Verified by rendering (shots `chart26.mjs`).
tests/fx-chart-fixes (2).
## v26.2 "+$10 then sold for $1" (Oct 21, owner; USDJPY fib_pullback 4h long, entry 158.222, closed 00:06 UTC on 'signal')
VPS read: gross ≈ +$7.19, venue fee $5.81 → booked +$1.38 (+$1.24 swap banked) — the profit lock never armed. Two causes:
(1) the open P&L on screen didn't count the fee charged at the close → `view()` now subtracts `feeUsd(...)` from every open
position's P&L (equity / margin level too), so the screen shows what closing now would book. (2) The first run after the
fee deploy re-picked filters / exits, the lab's trade vanished, and `syncBot` read "lab trade missing" as the strategy's exit.
Now `RunOutput.doneKeys` (hourly: lab paper trades that ENDED in the last 7 days) / fast `labDone` (its simulated closed
trades + `report.paper.recent`) → `syncBot(…, { labDone })`: a held trade missing from the open list AND not in labDone is
kept on its own stop / target / profit lock (one bot-log line "a re-test changed its strategy's rules…") until
`BOT.orphanMaxBars` 30 candles of its chart since it opened, then closed as before. No labDone passed → old behaviour.
tests/forex-v26-2 (5). 1,364 tests.
## v26.1 Hyperliquid backup prices + Dukascopy's firewall named (Oct 21, owner: "build all the rest too besides the lean rule
changes")
From the GitHub safety review (no new npm packages added — both use the `ws` client the bot already has):
- `src/forex/hyperliquid.ts` `HyperliquidLive` (`hyperliquidLive`, started / stopped in index.ts): Hyperliquid's public WebSocket
  `wss://api.hyperliquid.xyz/ws`, one `l2Book` subscription per coin (`hlCoin`: BTCUSD → BTC), best bid / ask (`parseL2`), a
  ping every 30 s, watchdog 60 s, back-off; ticks only when the mid moves; feed 'hyperliquid-live' (provider
  'hyperliquid-stream'). `LiveFeed(streams, backups)`: backups answer only for markets no main stream prices right now —
  Coinbase stays the coins' main price (the coin lab is graded on Coinbase candles; Hyperliquid perps differ a little).
  Read-only, no keys. UNVERIFIED from the sandbox: Setup → Data feeds says whether the VPS reaches it.
- Dukascopy: the 202 is its AWS WAF bot challenge (dukascopy-node issue #261: `x-amzn-waf-action: challenge`), not a cold
  file — v21.2's retries can't help. `probeDukascopy` returns `DK_WAF_TEXT` on 202 + that header → history refresh skipped,
  `DkMeta.blocked` stored, next probe after `DK.blockedRetryHours` 24 (was hourly); a good refresh clears it. The maintainer's
  `dukascopy-node@1.50.0-beta.2` passes the challenge with headless Chrome (playwright-core) — NOT adopted (one day old,
  ~300 MB Chromium in a 2 GB container). Alternative for older history: a one-off histdata.com 1-minute download offline.
- NOT built: `@gainsnetwork/sdk` borrowing / funding / price-impact maths (needs gTrade's live trading variables — wire it
  with the gTrade price feed once the owner picks gTrade), ccxt (not needed), LEAN fill rules (owner: not now).
tests/forex-hyperliquid (5). 1,359 tests.
## v26 the venue's fee in every test and paper trade (Oct 20 ~21:30 UTC, owner: "add the real gTrade fees"; "my trades
aren't like 25k tho")
`src/forex/venue-fees.ts` (`VENUE_FEES` on, gTrade per side, % of the WHOLE position = margin × leverage: majors 0.012, crosses
0.016, metals 0.05; coins 0 because their `spreadPips` already is a perp taker cost): `feeR(inst, entry, risk)` = 2 × fee% ×
entry ÷ stop distance → engine `finish` subtracts it from every trade's R (`SimOpts.venueFees`, default on: lab, fast lab,
honest test, luck twins, judge rows all see it → ONE re-pick event after deploy; some Maybe rows may turn 'no' = fewer
trades); practice `closePos` / `closePart` take `feeUsd(inst, margin, leverage)` (open + close of the closed size) out of
`pnlUsd` and store `ClosedPractice.feeUsd` (all accounts; charged at the close — since v26.2 the open P&L already shows it). Rates came from search extracts of docs.gains.trade (host unreachable from the sandbox; a
DefiLlama snapshot showed 0.02 maker / 0.05 taker for EUR/USD + XAU in June) — re-check before going live. NOT modelled:
gTrade borrowing / funding fees (financing stands in) and open price impact. Bot sizing: position = equity × risk% ÷ stop%
(margin = that ÷ leverage, capped at 25% of free margin) → at max mode ≈ $10–25k positions on forex majors, which the owner
sees as ~$50–125 of margin. Tests that pin other features' numbers set `VENUE_FEES.on = false` at the top; tests/forex-venue-fees (4).
## v25 owner's rules: ICT live, Fibonacci never alone (Oct 20 ~20:45 UTC, owner: "don't use Fibonacci alone, it clearly
didn't work yet, put ICT trades live")
- `FX_CONFIG.ownerLive` ['judas_swing', 'ny_q3', 'amd_daily', 'fvg_entry', 'mss_sweep'] (lab.ts): on the FOREX desk these join
  the chosen list whatever their verdict (hourly chooser `ownerLive.has(x.id) ||`, fast `chosenOf(…, ownerLive)`); a 'no'
  row trades at 0.6× base risk (`stratFactorFromVerdict`); judge / market checks / losing-market record / news / caps still
  apply; the learner can still drop one. On real data all five were 'no' (best fvg_entry:4h +0.11R / PF 1.37 on 29 unseen;
  judas_swing 1h −0.15R / PF 0.72) — told to the owner. 15m: only the three session rules (`botFastStrategies`).
- `FX_CONFIG.needsConfluence` ['fib_pullback'] + `confluenceBars` 2: `soloWait(t, others, barMin)` (lab.ts, pure) → a fib
  trade waits unless another strategy (not random) has an open lab trade / a signal on the newest close the same way on the
  same market within 2 candles; `LabOpenTrade.soloWait` → syncBot wait (desk trades exempt), why.ts kind 'solo', shadow
  label. Both labs (hourly: all rows' open paper trades; fast: open trades + `fired`). The USDJPY fib trade opened at 20:03
  was left running. tests in forex-ict (4); forex-v15 fast-chart expectation allows the ICT session rules.
## v24.3 coin list cleanup (Oct 20, VPS read 20:21 UTC)
The coin bot's chosen list carried local_hours:1h / fix_flow:1h (botAlways rows kept with 0 coin trades — they never fire on a
coin, `NOT_FOR_CRYPTO`); the coin lab's chooser now drops every NOT_FOR_CRYPTO id. VPS 20:21: forex 10 chosen, 1 open (USDJPY
fib_pullback 4h long), 15 of 105 signals opened in 24 h; coin bot 3 open news_fade shorts; Coinbase candles + live OK (the
Data-age "source: yahoo" label = the primary store, not the feed); every ICT row 'no' (best fvg_entry:4h 29 unseen, +0.11R, PF
1.37); Dukascopy still 0 bars — every file answers 202 even after 8 × 2 s retries (v21.2 didn't fix it on the VPS).
## v24.2 coin trades can be closed by hand (Oct 20, owner: "I can't close trades by hand crypto")
`POST /api/forex/practice/close` and `/reset` mapped `acct` with `=== 'bot' ? 'bot' : 'me'` (v22.1 missed them), so a
coin-bot close went to the owner's own account ("no such position") and the crypto Trades page's Reset would have reset
the OWNER's account. Both now use `acctParam(req.body?.acct, 'me')`. Regression test in forex-crypto.
## v24.1 the gates behind the gate (Oct 20 ~19:00 UTC, owner: "still no trades in forex… it's been hours")
With the 1-check rule live (18:01 look) the next gates bit: EURUSD pivot_bounce "no winning record on this market (282 trades,
PF 1.05)", NZDUSD round_fade "no winning record (11 trades)", GBPUSD round_fade judge 58% < 65%, USDJPY pivot_bounce 0 of 3
checks. And the quality bar left only 3 chosen rows, all 4-hour → at most a handful of chances a day. Changes:
- `FX_CONFIG.strict.mode` 'quality' → **'off'** (the v18.9 chooser: Edge + Maybe rows − dropped, always-on rows unless resting;
  the live read had 10 Maybe rows). The quality bar is still graded and shown; `qualityPass` untouched. Put 'quality' back
  for the 3-row list.
- Market gate = a LOSING record only: `strict.market` {minN 12, losingPf 0.9}; `marketRec.ok` = !(n ≥ 12 && pf < 0.9), a
  thin / missing record passes; computed in every mode (was null when strict was off). Wording "losing record on this
  market (…)"; why.ts hint. The judge gate (tested, AUC 0.58) and the 1-check rule stay. The shadow book scores all of them.
## v24 shadow book, the 2-checks gate loosened, real exchange data + 5 more coins (Oct 20, owner: "forex hasn't traded all
day, enough solid signals; crypto isn't trading at all, needs more accurate data, more hardworking; you didn't add a shadow
trade feature on forex")
VPS read 17:17 UTC (c86afe7): forex 88 chosen signals in 24 h, 18 opened, 35 waits ALL "only N of 3 market checks agree
(needs 2)" (pivot_bounce / round_fade on USDJPY, EURUSD, NZDUSD, GBPUSD, XAU/XAG; judge 2×); coin bot 15 chosen signals, 0
opened, 19 waits all the same rule (a coin has no strength reading and mood is mostly "no say", so 2 of 4 was near
impossible). Bot account +$37 all time (13 trades), today +$1.20.
- **Shadow book** (`src/forex/shadow.ts`, pure): `recordShadows(book, syncReport, labOpen, heldRefs)` writes every refused
  signal of a chosen strategy (one row per lab trade: entry / stop / target / why / `classify` kind / wait|skip; a later
  refusal updates the reason, a trade the bot took after all is struck, unresolved rows die after 45 days, 1,500 max);
  `gradeShadows(book, labClosedTrades)` fills in R from the lab's own finished paper trade with the same identity
  (`tradeKey` = the bot's ref); `shadowSummary` → total / per reason / per strategy (n, done, win %, total R, $ at the
  bot's base risk × equity), still-running rows with R so far at the live mid, newest finished. Both labs call
  `ForexLab.noteShadows` after every sync (hourly: `out.report.paper.recent`; fast: `report.paper.recent`), Redis
  `fx:shadow` / `cm:shadow`. `/api/<desk>/bot` → `shadow`; Trades page card **"Trades it held back (shadow book)"**
  (`components/FxShadow.tsx`: By reason / By strategy / Still running / Finished). This is the evidence for every
  hold-back rule from now on.
- **`strict.minAgree` 2 → 1** (lab.ts): a trade needs at least one of the four checks on its side. The 2-of-4 rule was never
  tested; the shadow book now scores it. why.ts hint updated. (Tests still pass `minAgree: 2` explicitly where they test the
  wording.)
- **Coinbase Exchange data** (`src/forex/coinbase.ts`, free, no key): hourly candles `/products/<BTC-USD>/candles` paged 300
  a call back 1,100 days (`refreshCoinSeries`, used by `refreshAll` for `kind === 'crypto'`, Yahoo as the fallback), 15-minute
  candles for the fast lab (`fetchCoinbaseFast` inside `DEFAULT_FAST_SOURCE.bars`), and the public WebSocket `ticker`
  channel (`CoinbaseLive`: real bid / ask per trade, 1-minute candles, watchdog + back-off; `liveFeed` = [pyth, yahoo,
  coinbase], started / stopped in index.ts) → feeds `coinbase-candles` / `coinbase-live` (provider breaker 'coinbase' /
  'coinbase-stream'), `FeedStatus.source`. Unverified from the sandbox: Setup → Data feeds says whether the VPS reaches it.
- **Coins**: + XRPUSD, DOGEUSD, ADAUSD, LINKUSD, AVAXUSD (8 coins; roundStep / RISK_CLASS / headline words added). The coin
  lab's first run after deploy pulls ~1,100 days × 8 from Coinbase (≈ 90 calls a coin) and grades ~30 rules × 2 charts × 8.
- **Coin bot trades the 15-minute chart** (`FX_CONFIG.botFastChartsCrypto` true; forex stays 1h / 4h + the ICT session
  rules): fast.ts `isChosen`, server passes `fastCharts` per universe. Caps unchanged (`BOT.maxOpenByTf` 15m 3).
- tests/forex-shadow (4), tests/forex-coinbase (5); forex-strict / forex-crypto / forex-ict expectations updated. 1,344 tests.

## v23 ICT / smart-money rules + the desk plans fixed (Oct 20, owner: "ICT quarterly theory, automate it and order flow,
trustworthy news outlets (ForexFactory…), a Judas swing at the NY open, 15:45 / 10 am")
- `src/forex/ny-time.ts` (pure): `usDst`, `nyOffsetMs`, `nyMinOfDay`, `nyDow` (calendar.ts re-exports them); `Ctx.nyMin` =
  minutes since New York midnight at the bar's open (ta.ts). `Strategy.charts` = the only charts a rule runs on
  (`runsOn` honours it); family **'ict'** (Playbook label "ICT / smart money", first in the list).
- Five rules (strategies.ts, `ICT` consts, `sessionRange` / `fvgSignal` / `mssSignal` exported, all causal, graded by the lab
  like every other row — nothing trades until it clears the quality bar): `judas_swing` (15m + 1h: after the 9:30 NY open the
  first close back inside the pre-open 3:00–9:30 range after a sweep ≥ 0.05 ATR past it → fade, stop past the sweep, target
  the other side, flat 4 pm NY; first signal at the 9:45 close), `ny_q3` (15m only, quarterly theory 90-min quarters: at the
  9:00 NY close, Q2 7:30–9:00 swept Q1 6:00–7:30 and closed back inside → trade Q3 the other way, 2R, flat noon), `amd_daily`
  (15m + 1h: at the 6:00 am NY close, London 0–6 swept Asia 18–24 (previous NY day) and came back → target Asia's other side,
  flat noon), `fvg_entry` (any chart / market: sweep of the last 10 lows, displacement body ≥ 1.2 ATR leaving a 3-candle fair
  value gap, retrace into the gap within 6 candles closing back above it → 2R; a gap the price falls through is dead),
  `mss_sweep` (any: dip under a confirmed swing low, close above the last lower swing high within 6 candles → 2R). Session
  blocks use the bar's CLOSE minute, so the hourly 9–10 NY bar counts for the Judas window. The three session rules are in
  `NOT_FOR_CRYPTO` (+ `pdh_pdl`, which was misspelt there).
- **15m trading for the ICT session rules**: `FX_CONFIG.botFastStrategies` ['judas_swing', 'ny_q3', 'amd_daily'] — fast.ts
  passes them `chosen: true` while `botFastCharts` stays false (they hold hours, not minutes; still only once chosen by the
  quality bar on the 15m chart); plan.ts `PlanInputs.fastStrategies` (no "lab only" tag for them). Dashboard texts updated.
- **News outlets**: headlines.ts `FEEDS` + DailyFX market news + Investing.com forex RSS (unverified from the sandbox; a feed
  that fails only loses its own items). ForexFactory stays the calendar.
- **Fixes from the v22.1 VPS read** (16:56 UTC: coin lab 93 rows / 1 edge / 16 quality rows, chosen 16, both bots "waiting
  for a setup" on the 2-checks rule; forex lab clean): `buildPlan` listed every instrument (17) on BOTH desks →
  `PlanInputs.universe` (server passes `lab.universe`); `/api/crypto/feeds` was a 404 → one feeds route per desk, the Data
  feeds card reads `apiBase()`. Dukascopy: the hours-long cold pull now saves `fx:dk:meta` after EVERY market (old `at`, so a
  restart re-runs it) — before, the Setup card showed 0 bars until the whole pull finished; the VPS meta was still from 12:04
  at 16:56, i.e. the post-deploy pull was still running — read Setup → Data feeds again before judging v21.2.
- tests/forex-ict.test.ts (13). 1,335 tests. Synthetic candles only — the lab grades the ICT rows on real data after deploy.

## v19 control room (Oct 19, owner: "I want him in the middle, a big monitor screen, everything around it like a web, other rooms /
people that work and diagnose for me, animated, also crypto")
`dashboard/src/components/ControlRoom.tsx` = the new Forex home (`/forex`, section 'room'; Auto-bot moved to `/forex/bot`; nav
"Control room" first, phone bar Control room · Auto-bot · Markets · Lab · More). Pure display over existing endpoints (`/api/forex/bot`
5 s, `/api/forex` 60 s, `/api/forex/calendar` 60 s, `/api/system` 15 s, `/api/overview` 30 s, live ticks via `useFxLive`, trade
reads via `useTradeReads`). **Hub** in the middle: pulse rings + breathing cpu icon (CSS `cr-*` keyframes in index.css, all off under
prefers-reduced-motion), state word (Market closed / In N trades / Waiting on setups / Scanning), Next look countdown (plan `next`,
else the local UTC grid), equity + day P&L, last check, labError, and the **big screen**: market chips → `MarketChart` of the focused
market (open trade's pair, else the closest 'wait' signal, else the first) with its trendlines / levels / the bot's trade, the live
read track + AI headline for the trade on screen, lean / signal / block badges. **Eight rooms** around it, each with an avatar and a
"says" line: Scout (every market, live price flash, lean, status), Analyst (1h / 4h / Day arrows, lean, structure, signals, judge, held
back), Trader (open trades with live P&L, progress to target, next exit line, resting orders), Risk desk (equity / free margin /
drawdown, exposure bars vs the per-currency cap, risk-mode buttons → POST `/api/forex/bot/mode`), Decisions (bot log), Historian
(chosen combos with verdict tone, picker / resting / dropped / sniper), News desk (next high-impact event, headlines, no-new-trades
badge), Crypto room (checked / h, open, today SOL, checker verdict, links). Desktop: 12-column grid, hub spans the middle, rooms
left / right / bottom, SVG **web lines** hub → room (measured with getBoundingClientRect, re-measured every 2 s, animated dash flow);
phone: hub first, rooms stacked, no lines. Every read tolerates partial data (`expList`, `?.`), so a fresh VPS with no lab run yet
shows placeholders, never a crash. Verified by rendering with Playwright at 390 px + 1440 px, light + dark, against a stubbed API
(scratchpad `shots/room.mjs`).

## v19.2 control room on the phone + P&L back on the home (Oct 20, owner: "make it mobile friendly and I can't see my
P&Ls anymore")
`useControlRoomData` now also loads `/api/forex/pnl?acct=bot` (30 s) → `CRData.pnl`; the hub shows a **P&L strip**
(Today / Week / Month / All time: $ + trades + % won) under the account tiles on every screen size; new room key `pnl`
("P&L", icon chart) whose body is the full `FxPnl` (balance curve + month calendar), desktop grid row 4 full width.
**Phone (< 1024 px)**: hub first, then a horizontal chip strip of the nine rooms (P&L first, remembered in
`tab.cr.room` via `useTab`), ONE room open at a time — the page is a third as long as the stacked version. Every
calendar read is guarded (`clock?.`, `events ?? []`) so a calendar without a clock can't blank the page. Village: the
**Treasurer** villager (teal, outside the vault) carries today / week P&L and opens the P&L room.

## v19.3 the village, readable (Oct 20, owner: "make the city more accessible and readable, it's a tad confusing")
Village.tsx: every worker wears an always-on **name tag in its cloak colour** and a white **"doing now" bubble** above
it whenever it is busy, within 2.5 tiles of you or hovered (apprentices only when near / hovered); building labels
11 px bold on a darker plate; the operator is tagged "You"; the worker you can talk to gets an amber ring under its
feet. `saysFor(data)` (module-level) is the one source of every worker's one-liner for the map AND the new
**Roster** under the map ("Who is working right now": sprite avatar via `spriteUrl` (the sprite drawn once to a tiny
canvas → data URL), name, building, live line, busy dot, tap → the same screen; apprentices as chips) — the
accessible, no-walking twin of the canvas. **Help card** "How the village works" (first visit, localStorage
`village.help`; "?" button on the map and "How it works" link re-open it). `prefers-reduced-motion`: villagers and
apprentices stay put (the operator still walks). Verified with Playwright at 390 / 1440 px, light + dark.

## v19.4 "Why no trades?" (Oct 20, owner: "there hasn't been a single trade for hours on either chain"; VPS not reachable
from the sandbox → the diagnosis is built into the app, like the crypto checker verdict)
`src/forex/why.ts` `whyNoTrades(input)` (pure): hours since the bot last opened anything (positions `openedAt`, orders
`placedAt`, closed rows), the last 24 h of `RunNote`s (checks / signals / chosen / opened / skipped / waits), every
"waiting on / waited on / skipped" line of the bot log + the newest `SyncReport` per chart bucketed by `classify(why)`
(not_chosen / cooldown / caps / judge_missing / judge_no / check_data / stale_feed / clock / news / shock / late /
ccy_cap / heat / margin), lagging 1h / 4h markets (`staleReason`), and ONE verdict in order: lab failing → no check in
2.5 h → market closed → no chosen strategies → nothing fired → fired but none chosen → top hold-back reason (+ a hint:
what fixes it / "working as designed"). `quiet` = market open and 3 h+ since the last open. `/api/forex/bot` → `why`.
Dashboard `WhyLine` (ControlRoom.tsx; amber `role=status` when quiet, "details" = the full count list with an example
line each): control-room hub, Today card (FxBrief), village HUD. FIRST thing to read when forex is quiet.
tests/forex-why.test.ts (6). For crypto the same question is Scanner → Bot health → Coin checker (v18.10) + Buying.

## v19.1 the village (Oct 19, owner: "turn this all into a game: an open world where villagers work for us, medieval pixel
style; click the guy trading forex and see the full trade with all explanations; a cool environment to learn in")
`dashboard/src/components/Village.tsx`, route `/forex/village` (Forex menu "The village"; link from the control room).
Same data as the control room: `ControlRoom.tsx` now exports `useControlRoomData()` (one hook: bot / lab / calendar /
system / overview / live ticks / trade reads + the derived focus market, state word, next look), `roomView(k, data)`
(a room's "says" line + body) and `HubView` — the grid page and the village both render from them. The village is a
30 × 18-tile canvas world drawn in code (no image assets; procedural tiles, buildings, people, smoke, fountain, river
shimmer; `image-rendering: pixelated`): **guild hall** = the bot (banner + flag), **watchtower** Scout, **observatory**
Analyst, **trading post** Trader, **vault** Risk keeper, **town board** Clerk (decisions), **library** Historian,
**tavern** Crier (news), **mine** Miner (crypto). One villager per room wanders near its door (BFS paths on the tile
grid, `findPath`), stays home and bobs when busy (trader in trades, news block, scout with setups close), and carries a
bubble with its live one-liner when you are within 2.5 tiles or hover it. **Apprentices** = one small sprite per
strategy × chart the bot has put to work (`chosen`, ≤ 12), around the library; tap one → its row (verdict). The operator
walks with arrows / WASD, tap-to-walk, or the phone d-pad; E / Enter / tap opens the screen of whoever is within 1.6
tiles (or the building whose door you stand at): desktop = a drawer inside the world, phone = a full-screen sheet; the
Trader's and the guild hall's screens include the hub's big chart + live read; Esc closes. Day while forex is open,
night (blue wash, lamp glows at every door, stars) when closed; new bot-log lines float up over the guild hall for 7 s.
HUD: Gold = equity + today's P&L, state word, next look, villagers / apprentices / trades. Desktop scale 2 (whole world
fits), phone scale 2 with the camera following the operator (13 tiles tall). Verified with Playwright at 390 / 1440 px,
light + dark, incl. opening the Trader's screen (scratchpad `shots/village.mjs`). Display only.

## v20 market desks (Oct 20, owner: "scan all markets properly, an agent / villager on each market with its own
strategies, learning what works, at least 1 trade a day in each market")
`src/forex/desks.ts` (pure, `DESK` consts): one desk per traded market. Arms = every strategy × chart row with a paper record
on THAT market (`Row.pairs`, `random` excluded). Arm mean R = (paper totalR + 2 × the bot's own totalR here) ÷ (n + 2 nOwn +
10 pretend break-even trades); own = the bot's R ledger rows on that market, last 60 days, R clamped ±3, manual closes
ignored. Score = mean + 0.35 · √(ln(N+1) ÷ (nEff+1)) (UCB-style exploration bonus — rarely tried arms get a turn). Trading
day rolls 22:00 UTC. **Quota**: a market with no trade opened today (positions + closed rows, weekend / partial rows don't
count) whose best-ranked firing arm the bot does NOT already trade (`chosen: false`, signal fresh today, arm mean ≥ −0.08)
takes it as a LEARNING trade: `applyDesks` sets chosen, `desk {rank, of, why}`, `sizeF` 0.5 (half the risk mode's base),
`order` null (market entry, never a resting order), conviction / sniper null; the judge gates are skipped for desk trades
(`!t.desk`), every other guard stays (news, clock, stale feeds, cooldown, caps, currency cap, heat, margin). `buildDesks`
→ {desks, picks}, `desksSummary`. Wired in `ForexLab.syncFrom` (parent process, before `syncBot`): snapshot('bot') +
report rows + `ledgerRows` → `applyDesks(out.botTrades)`, bot-log line "desk: …", Redis `fx:desks` {at, desks}.
`PracticePosition.desk` true on such positions (log "DESK learning trade: …"). `/api/forex/bot` → `desks`. Dashboard:
Control room → **Market desks** room (`DeskTile` grid, status dot traded / taking one / waiting / no record, tap a tile →
`DeskDetail` table: rank, strategy · chart, mean R, score, paper n, own n; hub summary "N of 14 markets traded today");
the village gets **market watchers**: one hooded villager per desk at fixed posts round the square (`WATCH_POSTS`, no
wandering; far tags alternate above / below so they never overlap; bubble only within talking distance / hover / busy),
tap one → its desk table + the hub with that market on screen (`setPicked`); roster row "Market watchers · Round the
square"; help card line. tests/forex-desks.test.ts (6). Verified with Playwright (room.mjs / village.mjs). 1,300 tests.
NOTE: the desk only lifts arms that already fire from the lab's own strategies; it buys ONE half-size data point a day per
market — judge how it does on the Lab / Historian cards and the bot's own R ledger before trusting any desk's ranking.

## v20.1 strict mode + open trades reverted (Oct 20, owner: "I want to win, make it trade only what will work with
proper research, revert all current active trades")
`FX_CONFIG.strict` {edgeOnly true, minAgree 2, deskTrades false} + `FX_CONFIG.liveEntries` false (lab.ts):
- **Edge only**: the live chooser keeps ONLY rows with verdict 'edge' (unseen ≥30 trades, both halves positive, unseen
  PF ≥1.2, beats random, survives the luck twins + deflated Sharpe) minus the learner's dropped list. The always-on four,
  the rolling picker's list and Maybe rows no longer get a row in (`chooser` stays 'verdict'). An empty list logs
  "strict mode: no strategy has passed the unseen exam right now — the bot waits" once per change. On the real feed
  v18.6 saw `edges: 0`, so EXPECT zero bot trades until a row earns Edge — that is the point, told to the owner.
- **2 market checks per trade**: every lab open trade carries `agree` {n (agreeCount at the signal close: strength gap,
  4h trend, daily trend, mood), of (4 on 1h, 3 on 4h), need}; `syncBot` waits "only N of M market checks agree (needs 2:
  strength, bigger charts, mood)" while n < min(need, of) (desk trades exempt). why.ts kind `agree` + hint.
- **Market entries only**: `liveEntries` false → every row's entry is 'market', no resting orders (the pullback orders
  filled on the signals that came back against the trade and missed the ones that ran).
- **Desks study only**: `DeskInput.quota` (0 → no pick, status 'waiting' = "study only · best here: …", summary
  "… waiting for a proven setup · desks study only"); the lab passes 0 while `strict.deskTrades` is false and never calls
  `applyDesks`. Dashboard tiles say "watching" instead of "0/1 today"; Village bubbles / help / Auto-bot "How it trades"
  text updated.
- **Revert**: `undoOpen(a)` (practice.ts, pure): strikes every open position + its parts (USD back out of the balance,
  peak lowered), resting orders and weekend pauses; closed trades stay. `Practice.undoOpen(acct)` also drops those ids'
  rows from the durable P&L log. One-time `v20.1-revert-open` (index.ts) → bot account, bot-log line + "strict mode on".
tests/forex-strict.test.ts (6). 1,306 tests. To loosen later: `strict.edgeOnly` false restores the v18.9 chooser.

## v20.2 the plan, made obvious (Oct 20, owner: "I want to know more obviously if it's waiting for a setup and what
it's planning on the countdown")
plan.ts: `BotPlan.mode` {kind closed / trading / waiting / nothing_proven / scanning, word, line} — the state in ONE word
("Market closed" / "In N trades" / "Waiting for a setup" / "Nothing qualifies yet") + one plain line (why; in strict mode
"no strategy has passed the unseen exam (strict mode: only Edge rows trade)"); `BotPlan.nextLook` {tf, at, does} = what
the next look will do in words ("Reads the hourly candle that just closed on 14 markets: did any of the N proven 1h
setups fire? If one did, 2+ checks agree, no news … it opens at market …"); per market `checks` (`checksOf`: the four
checks one by one — strength gap / 4-hour trend / daily trend / mood, each ▲ ▼ ·, with a tooltip text) and `plan` (one
sentence: "Leans BUY (3 of 4 checks up). Waiting for one of its N proven setups to fire long at a candle close with 2+
checks on its side — then it opens at market." / "A proven strategy (X, 1h) fired to buy — waiting: …" / "Nothing to wait
for: no strategy has passed the unseen exam yet"). `PlanInputs.strict` {edgeOnly, minAgree} (server passes FX_CONFIG.strict).
Dashboard: the hub's state word comes from `plan.mode` (fallback = the old local guess), the mode line replaces the
summary, "At the next look (time, chart): …" under it, and a **PlanBoard** ("The plan, market by market": status chip
In a trade / Setup fired · held / Watching / Blocked, lean, `CheckPips` Str ▲ 4h ▲ 1D · Mood ▲, the plan sentence; top 6,
"All 14"; tap → that market on the big screen) sits under the P&L strip on every screen size. The Today card (FxBrief)
opens with the same mode word + line, its Next look line carries `nextLook.does`, and lists the top 6 markets' plan
sentences. Village HUD shows the mode word. tests in forex-strict (buildPlan modes, checksOf). Verified with Playwright
(room.mjs stub carries mode / nextLook / checks).

## v21 the dashboard, easier + a live news feed (Oct 20, owner: "upgrade the dashboard a lot more, easier and much more
accessible, a live news feed, fun not a mess")
- **Nav** (App.tsx `WS.forex`): phone bar **Home · Trades · News · Markets · More**; sidebar groups "Every day" (Home =
  control room, Trades = /forex/bot, News = /forex/news, Markets) and "Deeper" (Lab, Strategies, Paper results, The
  village, Trade by hand, Setup). Page titles in plain words (Forex.tsx `TITLES`).
- **Live news tape** (`components/NewsTape.tsx`, CSS `tape-*` in index.css): a wire ticker of the newest headlines from
  `/api/forex/calendar` (re-read every 60 s; the bot reads ForexLive + FXStreet every 5 min) rolling right-to-left, a
  front chip = the next High-impact event / holiday counting down (`nextBig`, `inWords`; red left edge inside 45 min),
  currency tags in one colour per currency (`CcyTag`), big headlines with a red dot, headlines newer than this device's
  last look glow once (localStorage `fx.news.seenAt`). Pauses on hover / focus; prefers-reduced-motion = a plain
  scrollable row; `aria-hidden` roll + an `sr-only` static list for screen readers. On the Home (phone: above the hub;
  desktop: above the grid) and the Markets page (replaces the big news card there).
- **News desk** (`/forex/news`, `components/FxNewsPage.tsx`): hero "Next big one" with a countdown + what it does to the
  bot ("no new trades on GBP pairs from … to …"), "The bot right now" = currencies paused for news (`pausedNow`: mirrors
  calendar.ts newsBlock ±30 min High / Medium speeches, headlineBlock 30 min, holidays all day), the live feed with
  currency chips (+ counts last 24 h) and "Big only", grouped Last hour / Earlier today / Yesterday / Older, and "This
  week" as a timeline in the viewer's clock (impact dots, countdown badges inside the hour, forecast / last).
- **Home**: state word `text-3xl` + `aria-live="polite"`, label "Your forex bot, right now"; P&L tiles roll to their new
  value (`hooks/useCountUp.ts`, `MoneyTile`, `.money-pop`; off under reduced motion); phone room chips 44 px tall and
  ordered P&L · Trader · News desk · Scout first; links Trades / News desk / All markets.
- Playwright harness `scratchpad/shots/v21.mjs` (`serviceWorkers: 'block'` — the PWA service worker had been swallowing
  the stubbed API calls after the first navigation, which made the News page look empty; room.mjs / village.mjs fixed
  the same way). Verified phone 390 px + desktop 1440 px, light + dark.

## v21.1 the village, fixed (Oct 20, owner: "no, the town needs to be fixed — the village; I'll keep all the new features")
`Village.tsx` only (v21 untouched). The HUD (Gold / state word / next look / day-night / counts / "?") is a pill strip ABOVE
the map — before, three overlay pills covered the guild hall and the bubbles on a phone. Inside the canvas only the desktop
talk prompt / hover pill and the drawer remain. **Phone**: a control bar UNDER the map (44 px d-pad, "Next to the Trader — tap
Talk" line with `aria-live`, one Talk / Enter button, dimmed when nobody is in reach) replaces the d-pad + E that sat over the
buildings; scale 1.5 (≈15 tiles across, was 11 at scale 2 — the square never fit) and 14 tiles tall; building labels are the
short name (`b.name.split(' · ')[0]`). **Square declutter**: a market watcher far away shows only a status dot over its hood
(`Mover.status`: green traded / amber taking a trade / grey watching, none idle); its pair tag + bubble appear within 1.6
tiles (was 2.5: two tags overlapped) or on hover / busy, odd-numbered posts tag under the feet. The Treasurer moved from the
vault door (its tag sat on the Risk keeper's) to `TREASURER_HOME` by the observatory (first walkable of a short list, wander 1;
roster "By the observatory"). Help card = three lines (incl. the dot legend). Verified with Playwright (`shots/village.mjs`)
at 390 / 1440 px, light + dark, incl. opening a watcher's screen.

## v22.1 the Crypto desk = a real-coin bot on its own lab and account (Oct 20, owner: "nooo I don't want it in the forex
bot, I need it on the crypto side… change the crypto bot from memecoins to trading liquid real coins BTC/USD etc with
real strats")
Same engine, TWO labs: `new ForexLab(redis, universe)` (lab.ts `Universe` 'fx' | 'crypto'): `lab.insts` = currencies +
metals (fx) or the coins (crypto) — the forex lab never loads, grades or trades a coin again (v22 had put BTC / ETH /
SOL into the one lab, which would have mixed coin trades into the forex rows' stats); `lab.k(key)` maps every lab key
`fx:…` → `cm:…` for the coin lab (report, paper-since, filters chosen, judge, conviction, sniper, portfolio, heat, roll,
luck, learn, chosen hist, desks, bot log / runs / chosen / dropped; FastLab follows with `fx:fast:*` → `cm:fast:*`);
shared stores keep their names (bars `fx:bars:<id>`, feeds, calendar, headlines, macro, spread profiles); `lab.acct` =
'bot' (fx) / **'cbot'** (coins, Redis `fx:practice:cbot`, $1,000, own risk mode; `AcctId` adds 'cbot', ticked / flattened
(coins never) / resumed like the forex bot; `syncBot(…, { acct })`, `heldRefs / botLedger / botResults / setRiskMode /
riskMode(acct)`). `refreshAll(redis, cfg, insts, extras)`: the forex lab pulls its markets + strength crosses + mood,
the coin lab only its 3 coins. The worker child takes `WorkerInput.universe`. index.ts starts `cryptoLab` + `fastCrypto`
(calendar / headlines / practice shared); `ApiDeps.crypto` / `fastCrypto`. plan.ts counts `x.markets` (not
INSTRUMENTS), so the forex plan closes on the weekend as before and the coin plan never does.
**API**: the lab + bot routes are registered per universe (server.ts loop `U`): `/api/forex`, `/run`, `/bot`,
`/bot/status`, `/bot/mode` and the same under **`/api/crypto/*`** (keys through `K`, account 'cbot'). Account-agnostic
routes stay under `/api/forex/*` and accept `acct=cbot` (`acctParam`: practice, pnl, pnl/day, trades/read, trades/ai).
**Dashboard**: `lib/ws.ts` `inCrypto()` (route `#/crypto…`), `apiBase()` '/api/forex' | '/api/crypto', `wsBase()`,
`botAcct()` 'bot' | 'cbot' — ControlRoom / FxBot / FxBrief / FxLab / Forex page / NewsTape / Village / the header pill
read them, so the SAME pages serve `/crypto` (Home = control room on the coins), `/crypto/bot`, `/crypto/news`,
`/crypto/live`, `/crypto/lab`, `/crypto/strategies`, `/crypto/paper`, `/crypto/practice` (Forex.tsx `CRYPTO_TITLES`).
App.tsx Crypto workspace: Every day (Home / Trades / News / Markets) + Deeper + **"Memecoins (paper watch)"** (the
pump.fun pages: Overview now at `/memes`, Positions, History, Performance, Chart strategies, Shadow, Brain, Learning,
Wallets, Live feed); phone bar Home · Trades · News · Markets. The memecoin bot itself keeps running untouched (paper
data collector) — switching it off is the owner's call. tests: forex-v15 weekend expectation restored (the forex plan
has no coins). 1,322 tests. Verified by typecheck + build only (no VPS yet): after deploy the coin lab's first run
builds `cm:report`; read `/api/crypto` + `/api/crypto/bot` on the VPS.

## v22 crypto majors inside the forex engine (Oct 20, owner: "do it — a forex AND a crypto base, strategies, news, free tools")
The forex engine is a candle engine; it now also trades **BTC/USD, ETH/USD, SOL/USD** (`INSTRUMENTS` kind `'crypto'`, Yahoo
spot `BTC-USD` etc., 24/7; spreads 25 / 15 / 6 pips = a typical perp taker cost). Same lab, same 70/30 exam, same quality
bar, same bot account — the memecoin bot is a different product and untouched. What changed for a coin, all tested:
- **Clock**: `clockFor(pair, t)` (calendar.ts) = the forex clock for currencies / metals, `CRYPTO_CLOCK` (always open, no
  weekly close / rollover / Monday warm-up) for a coin. Used by `syncBot` (wait reasons + `canOpenFor`), the weekend
  flatten (coin positions / orders ride through), freshness (`lagBars` / `dataAgeOf` expect a coin candle every hour of
  the week), the fast lab (`decide` runs on the weekend; forex markets skipped per market), plan.ts (per-market blocks;
  mode is never 'closed' while coins exist — forex closed → `nextLook.does` says "Forex is closed… reads the coin
  markets only"), the Yahoo stream watchdog. The engine's weekend pause is gap-based, so a coin series (no gaps) is
  untouched; `spreadMultAt` → 1 (no rollover / weekend widening); financing: unknown carry = 0 (perp funding ignored).
- **Rules**: `NOT_FOR_CRYPTO` (strategies.ts; `runsOn(s, tf, pair)`, enforced inside `signalsFor` + both live passes):
  session rules, local_hours, fix_flow, month_end_flow, weekend_gap, nr7_break, carry_trend, cot_squeeze,
  stretch_squeeze, ccy_momentum, stat_arb, mom_blend, the intermarket four, turtle_soup never run on a coin (~25 rules
  do). `roundStep` BTC $1000 / ETH $100 / SOL $10. Strength meter: fx pairs only (a coin's strength check is '·', so
  `agree.of` is effectively 3 on 1h). Mood: `RISK_CLASS` BTC / ETH / SOL +1 (risk-on). News: headlines tag BTC / ETH /
  SOL (named coin, or generic crypto / Coinbase / Binance / stablecoin / ETF words → all three); `newsBlock` → USD High
  events still pause a coin, USD bank holidays don't; `currenciesOf(coin)` = ['USD', base].
- **Account**: `unitsFor` / `pnlUsd` treat `kind !== 'fx'` as USD-priced (1 unit = 1 coin); live Yahoo-stream prices for
  coins too (`kind !== 'metal'`; Pyth stays fx-only); leverage capped at `CRYPTO.maxLeverage` 20 whatever the risk mode
  (max mode = 5% risk at 20×); the currency cap counts BTC / ETH / SOL as their own currency. Dukascopy / DK fill /
  stitch: fx only. Desk (forecast.ts): coins priced in USD like metals. TradingView symbol `COINBASE:<id>`.
- Candles: Yahoo's 60m chart gives 730 days for the coins (free, no key) — enough for the 70/30 exam; a free exchange
  history (Binance / Coinbase) is the later upgrade if the lab wants more. Expect the first hourly run after deploy to
  grade ~25 strategies × 2 charts × 3 coins; nothing trades a coin until a row clears the quality bar on it (strict
  mode unchanged, 2-checks rule included). tests/forex-crypto.test.ts (9); forex-v15 / v16 expectations updated
  (decide runs on weekends for coins; Dukascopy ids exclude coins). 1,322 tests. Verified on SYNTHETIC candles only —
  read Markets / Strategies on the VPS after the first run.

## v21.2 Dukascopy never got a bar: the HTTP 202 warm-up (Oct 20, owner ran the probe from PowerShell: "HTTP 202", empty body)
`jetta.dukascopy.com/v1/candles/hour/<INSTR>/BID/<y>/<m>` answers **202 Accepted with an empty body** on the first request
for a month it hasn't cached ("preparing the file") and serves the data on a later request. dukascopy-node 1.50.0 counts
any non-200 as a failed attempt, retried it `retryCount` 2 × 500 ms apart and (with `failAfterRetryCount` false) returned
an EMPTY array → "empty answer from Dukascopy" on every VPS since v16, the probe passing (202 isn't 403 / 5xx). Fix
(dukascopy.ts): `DK.retries` 8 × `DK.retryPauseMs` 2 s per file (`pauseBetweenRetriesMs`, `retryOnEmpty: true`; m1 tail
5 × 1.5 s), `DK.timeoutMs` 75 s (a 90-day piece = 3–4 files, batch 5 in parallel), and `DK.failRetryHours` 1: a refresh
whose every market came back with 0 bars counts as fresh for an hour, not `refreshHours` 24 (one bad run blocked the
next try for a day; after this deploy the 3-min-after-start refresh runs at once because the stored meta is all-empty).
First full pull ≈ 22 markets × 36 months, mostly cold → expect 30–60 min; watch Setup → Data feeds → Dukascopy bars grow.
VERIFIED only by the owner's PC: a second request should answer 200 with candles. Pyth: the key's plan has no Hermes
price rights (poll 403 too) — Yahoo stream is the live feed; nothing more to build there.

## v20.6 Pyth: the key is accepted, the stream is refused → poll (Oct 20, owner: "Pyth is fixed now")
VPS read 12:05 UTC (version 5177c8c): the dashboard key is saved (`pyth.dourolabs.app`), `/v2/price_feeds` answers 200
with it (12 pairs planned), but `/v2/updates/price/stream` answers **HTTP 403** (109 fails) → no tick ever arrived.
Pyth's docs (search extracts; docs.pyth.network is DNS-blocked from the sandbox) give the same URL + `Authorization:
Bearer` we send, so the 403 is the plan / gateway refusing SSE for this key, not a wrong request. pyth.ts: a stream
refused with `PYTH.pollOn` [403, 404, 405, 426] → `mode` 'poll': GET `/v2/updates/price/latest?ids[]=…&parsed=true`
every `pollMs` 1.2 s (Hermes limit 10 requests / 10 s per IP), applied like a stream event, feed 'pyth-live' ok; the
stream is tried again after `streamRetryMs` 30 min; `streamError` text; `/api/forex/pyth` → `mode`, `streamError`;
PythCard badge "live (polling every second)". Other stream errors keep the old back-off. tests/forex-pyth (+1).
If the poll ALSO answers 403, the key has no Hermes data rights at all (Pyth Terminal → the key's plan).

## v20.5 Dukascopy probe hit a dead host (Oct 20, owner: "get me the correct site for Dukascopy")
The v18.6 `probeDukascopy` tested `datafeed.dukascopy.com/datafeed/…bi5` — the OLD endpoint, retired — while the pinned
dukascopy-node 1.50.0 downloads from **`https://jetta.dukascopy.com/v1/candles/hour/<INSTRUMENT>/BID/<year>/<month>`**
(its `DATA_API_ROOT`; the subdomain is built from char codes in the dist). So the probe failed on every VPS ("no answer
in 10 s") and the whole history refresh was skipped for a week → 2 years of Yahoo history instead of 3+. Now the probe
hits `DK_PROBE_URL` on `DK_HOST` (dukascopy.ts). If the Setup card still shows an error after this deploy, the VPS really
can't reach `jetta.dukascopy.com` (test: `curl -sS -m 10 -o /dev/null -w "%{http_code}\n" "https://jetta.dukascopy.com/v1/candles/hour/EURUSD/BID/2024/1"`
→ 200 = fine, 403 = Dukascopy blocks the Vultr IP, 000 = network). The sandbox can reach neither host (proxy).

## v20.4 quality mode — the bot trades again, on a bar it can actually clear (Oct 20, owner: "make the bot trade
again but good, accurate setups, not a random chase")
Live read of the VPS (11:07 UTC, through the Trading-env check session): 93 rows, **0 Edge**, 10 Maybe, 83 no — the
deflated-Sharpe test (82 rows graded on the same 30 unseen weeks, expected max no-edge Sharpe 0.279) downgrades every
Edge row on 2 years of hourly data, so v20.1 edge-only = zero trades for good. `FX_CONFIG.strict.mode` 'edge' |
**'quality'** (default) | 'off' (v18.9 chooser) replaces `edgeOnly`:
- **`qualityPass(row, randomAvgR)`** (lab.ts, pure; `Row.quality {ok, why}` set after the luck meter + honest stats):
  unseen n ≥ 30, unseen avg R ≥ 0.05, unseen PF ≥ 1.2, first-part avg R > 0, all-trades avg R ≥ random's (no margin),
  not beaten by its luck twins (`luck.twinsP90`). The deflated Sharpe is reported, not required. On the live numbers
  this admits round_fade:4h (102 unseen, 0.13R, PF 1.45), carry_trend:4h (154, 0.06R, 1.21), fix_flow:1h (495,
  0.05R, 1.21), pivot_bounce:4h (1333, 0.05R, 1.24); near-misses month_end_flow:1h (28 trades, 1.06R, PF 13.8 —
  needs 30), cot_squeeze:1h (22), pin_bar:4h (20). Sizing stays the Maybe factor (×1) — nothing here is "proven".
- **Winning record on the market** (`FX_CONFIG.strict.market` {minN 12, minPf 1.1}): every bot trade carries
  `LabOpenTrade.marketRec` {n, pf, totalR, ok} from `Row.pairs` for its pair; `syncBot` waits "no winning record on this
  market (N tested trades here, profit factor x, R)" / "no tested record on this market yet" while not ok (desk trades
  exempt). why.ts kind `market_rec` + hint.
- Kept from v20.1: 2 market checks per trade, market entries only, desks study only. plan.ts `PlanInputs.strict.mode`
  → "No strategy clears the quality bar (…)" / per-market "no strategy clears the quality bar yet"; server passes
  `mode`; Auto-bot "How it trades" text. Empty list logs "strict mode: no strategy clears the quality bar right now".
- Told the owner: the bot account is on risk mode **max** (5% a trade at 200×) — their call, not changed; Dukascopy
  is unreachable from the VPS ("no answer in 10 s") so the lab only has ~2 years of Yahoo history; Pyth answers 401
  (no key). tests in forex-strict (4 new). 1,312 tests.

## v20.3 letting the cloud session read the VPS (Oct 20, owner: "how can I make you see the VPS always"; then "from now
on use the check-the-VPS one")
**ONE VPS CHAT ONLY (owner, Oct 21: "stop making a new chat every time, make 1 and stick to it"):** reuse the session
"VPS checks (read-only)" = `session_01T8FxWXjhWtvC7KgJ2Dykzb` (Trading env) — send each new read-only check to it with
`send_message`, read the answer with `list_events` (kinds result). Only `create_session` again if that one is archived /
broken, then write the new id here.
**HOW TO READ THE VPS from a cloud session (works since Oct 20 11:07 UTC):** this session's own environment ("Default",
env_015uAncD8PFHDYjV3dBm4rWb) has neither the network allow nor the password. The owner's environment **"Trading"**
(env_018GTAh2vGzsVhy1Vayijo3U) has both. So: `create_session` with `environment_id` = the Trading env,
`source_url` https://github.com/smaxhy/super-secret-weapon, `source_revision` claude/festive-albattani-6aufe6,
`clone_depth` 1, and a read-only prompt (test the env var, GET /api/health, POST /api/auth/login with
$BOT_DASHBOARD_PASSWORD → token, GET /api/forex/bot, /api/forex, /api/forex/feeds, /api/forex/pnl?acct=bot&tz=0; report
in < 60 lines; never print the password; change / push nothing), then read its result with `list_events` (kinds
assistant / result; page back with before_id) a few minutes later (send_later). Do NOT spawn it without `environment_id`:
it inherits Default and gets a proxy 403. A session STARTED on the Trading env with the repo attached can curl the API
directly.
Two settings on the owner's cloud environment ("Trading": claude.ai/code → session title bar → environment → Edit):
(1) Network access → Allowed domains: `209-250-254-34.sslip.io`; (2) an ENVIRONMENT VARIABLE (not a Bearer network
secret — the API wants a JWT, which the session gets itself by POST /api/auth/login with the password):
`BOT_DASHBOARD_PASSWORD` = the dashboard password. A new session then logs in, keeps the 7-day JWT in memory and reads
every /api route (`/api/forex/bot`, `/api/forex`, `/api/forex/feeds`, …). An auth change that accepted the password as a
Bearer was written and REVERTED unpushed: the permission check flagged it as weakening auth and the owner was asked —
if they want the Bearer-secret route instead, re-add it in auth.ts with the login's lockout, with their say-so. No SSH:
docker logs / diagnose.sh still need the owner.

## v18.10 crypto checker plumbing (Oct 19, owner: "crypto still isn't trading or learning")
Cause suspected from the code (VPS not reachable from the sandbox): a coin is only SCORED once its safety check (RPC
`getAccountInfo` + Postgres, safety queue worker, concurrency 4) has landed; every checkpoint before that returns silently.
A backed-up / failing safety worker = "52 coins checked in 7 h" with the stream healthy. Built: evaluator early-exit
counters (`stats.jobs / alreadyDone / noToken / noView / waitSafety / safetyAsked`); safety worker stats
(`registry.safetyStats`: done / failed / stale / queue wait EWMA / last done) and **stale jobs skipped** (a safety job
older than 20 min is dropped unless the coin migrated — `SAFETY_STALE_MS`; a backlog no longer burns RPC on dead
launches); `HealthSnapshot.checker` (`setCheckerStatsSource` in index.ts: counters + BullMQ `getJobCounts` for the
evaluate / safety queues + the RPC provider) with `checkerVerdict` = one plain-words line naming the bottleneck (no RPC /
worker not running / Postgres behind / safety worker stuck or failing / safety queue backed up / live state dropping
coins / scoring). Scanner → Bot health → "Bot process" card → **Coin checker** block. Watchdog rewritten
(`src/lib/checker-watch.ts`): rolling 20-min window, every minute ≥ 10 launches and ≤ 2 coins scored in the whole window
→ WARN `checker_stalled` carrying the verdict; self-restart at most twice per 6 h (Redis `bot:checkerRestarts`), then the
warning only (a restart loop fixes nothing). FIRST thing to read when crypto is quiet: that verdict line.
tests/checker-watch.test.ts.

## v18.11 thin-coin learning probes (Oct 19, owner's Bot health paste: 739 coins scored / h, 0 signals, last buy 9 h)
The checker is healthy again (739 / h vs 52 in 7 h). New pair / Soon fail only "holders < N", "only N active wallets",
"liquidity N SOL < M" — size / age rules, not safety. `src/evaluator/thin-probe.ts` (`THIN_RULE`, `thinOnly`, `HourWindow`)
+ `explore.thinCoin` {enabled true, maxPerHour 8}: in the evaluator, after the normal learning-trade step, a coin whose
ONLY failed rules are thin ones (holders / active wallets / liquidity / volume / fees), no safety hard fail, score within
the learning margin, strategy in `explore.strategies` → BUY as a learning probe (`explore` + `probe` → minimum size,
counts toward the learning caps, edge gate skipped, Sniper refuses it as any learning trade), ≤ 8 an hour (sliding).
Rug / bundle / dumper / deployer / owner filters / momentum / pressure / chart rules keep their full force; the trader's
rug screen, bundle guard and vamp guard still run. Reason text "learning probe: early coin (…)". tests/thin-probe.test.ts.

## v15.4 crypto reset (Oct 18 night, owner's explicit request — overrides the VERDICT's "no more tweaks" for this one)
Owner: "copy only the consistent wallets; reset the crypto strategies, trade smarter and faster; track
5aLY85pyxiuX3fd4RgM3Yc1e3MAL6b7UgaZz6MS3JUfG (trustworthy); only SOON and migrated coins; stick to what worked somewhat
and improve it". Told plainly: nothing measured so far has an edge, this stays paper. Done:
- Migration v55 (create): SOON + MIGRATION_MOMENTUM (the two least-bad in every review) + SMART_MONEY_COPY on; new
  pairs / runners / swings off; allocation 0.55 / 0.35 / 0.1; 12 positions; confirmation 8 s, 1 pass (faster); score
  bar 60; edge gate ON (records reset → passes until 30 trades); learning trades only SOON / MIGRATION, margin 10, 4
  open, 12 an hour. One-time `v15.4-crypto-reset`: trade coach + `_strategySince` reset (P&L counter NOT reset).
- Copies: `copy.onlyConsistent` — a COPY wallet's buy is copied only if the latest copy test (`copyrep:last`) marks it
  `consistent` (6+ copies, both halves positive; `src/learner/copy-consistent.ts` `copyDecision`), else event
  `copy_skipped` and its buy stays a KOL signal. Nightly copy test (`copy.nightlyTest` 04:00 UTC, last 3 days,
  method-only, child process). `copy.focusStages`: copies + KOL follows only on coins ≥ the SOON curve floor (70%) or
  migrated (evaluator rule fail).
- 5aLY… added once (`track-5aLY`) as TrackedWallet kind COPY, weight 1.5 (trusted KOL signal now; copied once the
  copy test finds it consistent). `OWNER_TRUSTED_COPY` in config/kol-wallets.ts.

## v17.15 crypto = data collector, everything on (Oct 19, owner's explicit request — overrides v15.4's focus + the VERDICT's "no tweaks" for this one)
Owner: "for crypto lower things even more, I want it to gather a lot of data; I want everything on in case it does better
over time". Told plainly: still paper; nothing measured so far has an edge; this buys data, not profit. Migration v57
(create): all six strategies on (allocation MIGRATION .25 / SOON .2 / CURVE_SNIPE .15 / RUNNER .15 / COPY .15 / SWING .1),
30 positions, per-strategy caps 8 / 6 / 6 / 5 / 4 / 4, size 0.2 SOL; score bar 45, safety 45; OFF: edge gate, chart buy
rules + dip waits, dip-only, quiet hours, Sniper mode (it refuses nearly every buy); chase caps 30% / 1 min, 50% / 3 min;
learning trades on every strategy but copies (margin 20, 12 open, 60 an hour, drought 20 min → margin 20); copies from
every tracked COPY wallet on every coin (`copy.onlyConsistent` / `focusStages` false); ON again: TA lab, tournament,
outcome replays 120/min with exit variants S / R / W, shadow, brain, timing, self-loop, coach + calibration, AI coach +
meme reader (their daily budgets $0.5 / $0.25 still cap them; need ANTHROPIC_API_KEY), live-path dry run (skipped past the
RPC soft budget). Untouched: hard safety fails, rug / bundle / vamp guards, owner filters, usage budgets. One-time
`v17.15-crypto-data` (coach + `_strategySince` reset) and `v17.15-paper-room` (paper balance < 20 SOL → topped up to 25 SOL,
counted as capital). If the dashboard / forex lab slows: `FX_LAB_WORKER=on` in the VPS .env (see v17.2).

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
  Repo at `/root/bot`. `docker compose` runs postgres (TimescaleDB), redis, bot (crypto + forex, one process), caddy.
- **v15.4 crypto / forex split — REVERTED in v15.5** (owner: "just put it together with crypto again, make it all work").
  The split (own `forex` container, Caddy `/api/forex*` route, `which-containers.sh`) broke forex on the VPS: Caddy's
  config is a single-FILE bind mount, `git pull` writes a new Caddyfile (new inode), so the container kept the OLD file
  and `/api/forex*` went to the crypto bot, which no longer had the routes. Forex is back inside the bot process
  (index.ts starts ForexLab / Practice / Calendar / Headlines / FastLab, server.ts serves `/api/forex*`), every push
  rebuilds everything again. Kept: `src/lib/gbdt.ts` (tree-model re-exports it) and `heal_caddy` in auto-update.sh
  (every 5-min run + after a deploy: file inside the container ≠ repo's → `docker compose up -d --force-recreate
  --no-deps caddy`; never rely on `caddy reload` after a pull). Manual: `cd /root/bot && docker compose up -d
  --force-recreate --no-deps caddy`. The v15.4 crypto reset (above) stays.
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
