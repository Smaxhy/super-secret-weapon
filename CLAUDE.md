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
- Data source default `DATA_SOURCE=hybrid`: PumpPortal (launches/migrations) + Solana public RPC
  `logsSubscribe` (trades). Helius is only for RPC checks (1M credits/month plan — be frugal).
  Helius logsSubscribe burned ~5%/hour → never default to it.
- Owner's entry rules: min $12k volume, min $12k MC, min 1 SOL total fees paid (terminal-style), score ≥ 70
  (copy 60), anti-rug limits (bundlers ≤18%, top10 ≤50%, single wallet ≤10%, dev ≤10%); strong coins breaking
  only concentration limits (within 30/65/15%) are bought at half size; near-misses go on a watchlist;
  volume spikes trigger immediate checks; X hot keywords (needs TWITTER_BEARER_TOKEN) boost narrative.
  All editable on the dashboard Controls page (BotConfig). Config sections deep-merge with defaults.
- **Focus = Soon + migrated coins** (`focus` config): SOON strategy fires when the curve crosses 70%
  (CrowdTracker.onSoon → evaluator.scheduleSoon); rules ≥3 SOL fees, ≥$20k MC/volume, ≥25 active wallets (5m).
  MIGRATION_MOMENTUM: ≥9 SOL fees, ≥$25k MC, ≥$2k liquidity (both sides, USD), ≥20 active wallets. Both get
  bar −5 and size ×1.25; allocation MIGRATION 40% / SOON 35% / COPY 15% / CURVE 10%.
- Crowd behaviour (`src/scanner/crowd-tracker.ts`, in-memory trade log for curve ≥40% / migrated coins):
  active wallets 5m ("eyes" — pump.fun's own viewer count isn't public), dip buying, paper hands, bot churn,
  retail share, buy acceleration, smart-wallet share → features `crowd` + `attention`. Wallet reputation
  (`src/learner/wallet-reputation.ts`): buyers at scoring time get the coin's 1h label → finds smart wallets.
- Swing trading (`focus.swing`, `src/executor/swing-watcher.ts`): after a SOON/migration exit (not rug) the coin
  is watched 2h; 15–45% pullback + bounce with buy/sell ≥1.2 → re-evaluation as a swing (≤3 re-entries).
- Trade coach (`src/learner/trade-coach.ts`): 30 min after every close it reviews the trade (late entry,
  gave back profit, stopped then ran, sold too early…), stores the lesson on the position and adjusts per
  strategy: buy bar −5…+12, size ×0.35–1 on losing streaks, stop bias ±5%, trail ×0.75–1.3.
- Stop loss (`exit.stopLoss`): owner's band = 10–20% loss AFTER fees: 2×volatility (+coach bias) clamped to
  10–20% (15% until volatility is known), confirmed break (2 ticks + 3s), immediate past the 20% hard limit.
- Exits: tiers (25% at 1.3x, 15% at 5x), then **initials** at 2x (sell enough to get the stake + fees back →
  "house money"), the rest rides as a **runner** with a volatility-adaptive trail (ignores resistance/risk exits,
  max hold 2× normal). Protect profit (1.3x → floor 1.05x), resistance exit, momentum-risk exits, rug/copy exits.
  Fees: curve 1.25%, PumpSwap 0.3%, 0.0015 SOL gas+tip per tx, 1.5% slippage, 0.4–1.2s random landing delay
  before each paper fill. Every trade stores an explanation (+ the coach's lesson after review).
- Dashboard: positions show entry MC vs current MC (SOL + USD), a live price chart per position
  (Redis `pos:hist:<id>`, 5s points, 3-day TTL) with TP/stop/trail lines; redesigned layout + footer.
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
