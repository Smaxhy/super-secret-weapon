# Solana Pump.fun Trading Bot

An autonomous Pump.fun scanner, evaluator and trader that learns from every token it sees.
It's being built in phases. **Phase 1 is done:** the scanner, safety checks and observation memory.

> ⚠️ Memecoin trading is extremely high-risk. Most Pump.fun tokens go to zero. Run in `PAPER`
> mode until the numbers prove themselves, and only ever fund the bot wallet with money you can lose.

---

## What Phase 1 does

```
Helius WebSocket ──► pumpfun-listener ──► token-registry ──┬─► Postgres: Token row
 (logsSubscribe on      decodes Create /                    ├─► Redis: live state (every trade)
  the Pump.fun program) Trade / Complete events             ├─► BullMQ: 7 snapshot jobs ─► TokenSnapshot (TimescaleDB)
                                                            └─► BullMQ: safety check ─► SafetyCheck row + score
```

* **Listener** (`src/scanner/pumpfun-listener.ts`): one WebSocket subscription to every transaction
  that touches Pump.fun. It decodes the program's events straight from the logs, so a launch or
  trade costs **zero extra RPC calls**. It sends heartbeat pings, reconnects automatically with
  backoff, drops duplicates, and only decodes events Pump.fun itself emitted (it tracks the
  program call stack). If the logs come back truncated, it fetches the full transaction instead.
* **Live state** (`src/scanner/live-state.ts`): every buy and sell updates a per-token ledger in
  Redis. From that we get holder count, dev %, top-10 concentration, volume, buy/sell ratio,
  price, market cap and curve %, all without polling the chain.
* **Safety checker** (`src/evaluator/safety-checker.ts`): runs 3 seconds after launch and scores
  the token 0–100. It hard-fails on a live mint authority, a live freeze authority, an unknown
  token program, dangerous Token-2022 extensions (transfer hook, permanent delegate, pausable,
  non-transferable, default-frozen) or a blacklisted creator. It deducts points for a big dev
  buy, transfer fees, an odd supply or a bad name/URI.
* **Observation logger** (`src/learner/observation-logger.ts`): snapshots *every* token at
  creation, 1m, 5m, 15m, 1h, 6h and 24h. Those rows become the ML training data later. The jobs
  live in Redis, so they survive restarts.
* **TimescaleDB** (`src/db/timescale.ts`): snapshots go in a hypertable with daily chunks.
  Chunks older than 7 days are compressed and raw rows are dropped after 30 days. Two daily
  aggregates are kept forever: `token_daily_outcomes` and `market_daily_stats`.

The Phase 1 holder ledger only sees curve trades. It misses direct wallet-to-wallet transfers.
Phase 2's market analyzer cross-checks on-chain data for any token we actually consider buying.

---

## Step-by-step: run it locally (Windows)

You need **Node 20+**, **Docker Desktop** and **Git**.

```powershell
git clone https://github.com/Smaxhy/super-secret-weapon.git solana-trading-bot
cd solana-trading-bot
npm install

Copy-Item .env.example .env
notepad .env        # set HELIUS_API_KEY and POSTGRES_PASSWORD (and the same password inside DATABASE_URL)

npm run check:rpc   # 1) proves your Helius key works and prints live Pump.fun launches for 30s

docker compose up -d postgres redis   # 2) start TimescaleDB + Redis
npx prisma db push                    # 3) create the tables
npm run db:seed                       # 4) load default config

npm run dev                           # 5) start the bot (auto-restarts when you edit code)
```

You should see `🆕 SYMBOL` lines for each launch, `safety: 100/100` (or a FAIL) a few seconds later,
and a `📊 stats` line every minute. To browse the data, run `npm run db:studio`.

## Step-by-step: deploy to the VPS

1. **On your PC**, create an SSH key and copy it to the server so you never need the root password again:
   ```powershell
   ssh-keygen -t ed25519
   type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh root@YOUR_VPS_IP "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"
   ```
2. **On the VPS as root**, harden the box and install Docker:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/Smaxhy/super-secret-weapon/main/scripts/setup-vps.sh -o setup-vps.sh
   bash setup-vps.sh
   ```
   (Until this is merged to `main`, swap `main` for `claude/festive-albattani-6aufe6` in the URL.)
3. **Log in as the `bot` user** (`ssh bot@YOUR_VPS_IP`). Clone the repo, create `.env` and start everything:
   ```bash
   git clone https://github.com/Smaxhy/super-secret-weapon.git solana-trading-bot
   cd solana-trading-bot
   cp .env.example .env && nano .env
   docker compose up -d --build
   docker compose logs -f bot
   ```
4. **Later updates:** `./scripts/deploy.sh`

---

## Dashboard

**Locally:** add `DASHBOARD_PASSWORD` and `JWT_SECRET` to `.env` and restart the bot. Then in a second window run:
```powershell
cd dashboard
npm install
npm run dev
```
Open http://localhost:5173 and log in.

**Online (GitHub Pages + VPS):**
1. On the VPS, set `DASHBOARD_PASSWORD`, `JWT_SECRET` and `API_DOMAIN=45-32-238-44.sslip.io` in `.env`, then run `docker compose up -d --build`. Caddy gets an HTTPS certificate automatically.
2. Merge this branch into `main`. In GitHub, go to repo Settings → Pages → Source and pick **GitHub Actions**.
3. Open `https://smaxhy.github.io/super-secret-weapon/`. Under "Bot address", enter `https://45-32-238-44.sslip.io` and log in.

### Install it on your phone
The dashboard is an installable web app. Open the GitHub Pages link on your phone:
- **Android (Chrome):** tap **Install app**, or ⋮ → *Install app*.
- **iPhone (Safari):** tap **Share** → **Add to Home Screen**.

It then opens full-screen from its own icon, like a normal app. The bot's data is always fetched live and never stored on the phone.

## Useful commands

| Command | What it does |
|---|---|
| `npm run dev` | Run the bot with auto-reload |
| `npm run check:rpc` | Test Helius + watch launches for 30s (no DB needed) |
| `npm test` | Unit tests (decoder, curve maths, safety scoring, metrics) |
| `npm run typecheck` | TypeScript strict-mode check |
| `npm run db:studio` | Browse the database in your browser |
| `docker compose logs -f bot` | Follow the bot logs on the VPS |

## Project layout

```
src/
  config/     env.ts (validated .env), default.ts (all trading params), strategies.ts, types.ts
  lib/        logger, rate limiter, Redis/Prisma/Solana clients, queues, Pump.fun decoder
  scanner/    pumpfun-listener ✅  live-state ✅  token-registry ✅  social-scanner (interface) …
  evaluator/  safety-checker ✅  wallet/market analyzers, scorer (Phase 2) …
  executor/   paper trader (Phase 2), buyers / sell manager / Jito (Phase 4)
  learner/    observation-logger ✅  Bayesian, daily adjuster, regime (Phase 7)
  api/        Fastify API + WebSocket (Phase 3)
  db/         schema.prisma (every table for every phase), timescale.ts, seed.ts
ml/           Python ML service (Phase 8)
dashboard/    React dashboard (Phase 3)
scripts/      setup-vps.sh, deploy.sh, check-rpc.ts
```

Files marked as placeholders say which phase builds them.

## Security rules

* Secrets live **only** in `.env`, which is git-ignored. Logs redact API keys automatically.
* Postgres and Redis listen on `127.0.0.1` only. The firewall opens only SSH and the API port.
* Use a **dedicated bot wallet** holding only trading capital. Never use your main Phantom wallet.
