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
- Phases done: 1 (scanner), 2 (scoring + paper trading), 3 (API + dashboard + PWA), plus parts of
  6 (PumpSwap/migration strategy, copy-trading tracked wallets) and 9 (free metadata socials/keywords).
- Mode: **PAPER only** (10 SOL fake balance). No wallet key on the server. Phase 4 (live) not built.
- Data source default `DATA_SOURCE=hybrid`: PumpPortal (launches/migrations) + Solana public RPC
  `logsSubscribe` (trades). Helius is only for RPC checks (1M credits/month plan — be frugal).
  Helius logsSubscribe burned ~5%/hour → never default to it.
- Owner's entry rules: min $12k volume, min $12k MC, min 1 SOL total fees paid (terminal-style:
  protocol fees + priority fees + Jito tips), score ≥ 75 (copy trades 65), anti-rug limits
  (bundlers ≤15%, top10 ≤45%, single wallet ≤8%, dev ≤10%).
- Exits: 40% at 1.8x, 30% at 3x, trailing 25% from 1.5x, protect profit (1.5x → floor 1.05x),
  momentum-risk exits, max hold per strategy, rug exits, copy exits. Owner wants profits banked early.

## Open items / next steps
1. Verify on the VPS that hybrid trade stream flows (`tradesPerMin` in hundreds+). If Solana's public
   node throttles, consider a cheap paid stream.
2. Phase 7 learning engine (nightly weight tuning from outcomes, Bayesian beliefs, regime detection,
   missed-opportunity tracking). Owner explicitly wants the bot to LEARN.
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
