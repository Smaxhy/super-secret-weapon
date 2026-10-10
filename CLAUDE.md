# Project handoff — Solana Pump.fun trading bot

Read this first when continuing work in a new session.

## What this is
Autonomous Pump.fun scanner + scorer + paper trader with a web dashboard (installable PWA).
Owner has some coding knowledge; explain simply, keep chat short, spend effort on the bot itself.
Original master plan: 9 phases (scanner → scoring/paper → dashboard → live execution → controls →
smart money → learning engine → ML → social). See README.md.

## Where things run
- **Branch:** `claude/festive-albattani-6aufe6` (all work goes here; the VPS and GitHub Pages follow it).
- **VPS:** Vultr, Ubuntu 24.04, `ssh root@209.250.254.34` (SSH key from the owner's Windows PC).
  Repo at `/root/bot`. `docker compose` runs postgres (TimescaleDB), redis, bot, caddy.
  Cron runs `scripts/auto-update.sh` every 5 min: pulls the branch and rebuilds if it changed.
  Log: `~/bot-update.log`. Bot logs: `docker compose logs -f bot`.
- **API:** `https://209-250-254-34.sslip.io` (Caddy → bot:8080, Let's Encrypt).
- **Dashboard:** `https://smaxhy.github.io/super-secret-weapon/` built by `.github/workflows/dashboard.yml`
  on pushes to the branch (github-pages environment allows the branch).
- Secrets live only in `/root/bot/.env` on the VPS (never in git).

## Current state (keep this section updated)
- Phases done: 1 (scanner), 2 (scoring + paper trading), 3 (API + dashboard + PWA), 7 (learning:
  outcome labels 1h after each stored evaluation, Bayesian pattern odds, nightly weight tuning 00:05 UTC,
  regime detector every 15 min), plus parts of 6 (PumpSwap/migration strategy, copy-trading tracked
  wallets) and 9 (free metadata socials/keywords). Positions stream live over WebSocket ('positions').
- Mode: **PAPER only** (10 SOL fake balance). No wallet key on the server. Phase 4 (live) not built.
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
  - v5 research (Oct 2026): graduation ~1–2% (0.26–6.7%); median graduate peaks AT graduation (~$31k at
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
- Copy trades (OFF by default since v5): bar +5 (stricter), size ×0.5, max 1 open, 120s minimum hold
  (copied wallet selling / risk / resistance / stale exits ignored; stop loss + rug exits still fire).
- Saved settings: `src/config/migrations.ts` versioned migrations (BotConfig `_version`) push deliberate
  default changes into saved rows (Controls saves whole sections, which otherwise freeze old defaults).
- Owner's entry rules: min $12k volume, min $12k MC, min 1 SOL total fees paid (terminal-style), score ≥ 70
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
