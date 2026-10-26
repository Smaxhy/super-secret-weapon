# Discord signal copier (the owner's self-bot)

Reads Kojiro's posts in the elite-signals channel and sends each one to the trading bot, which copies it as a
**paper** trade on the forex bot account (coins → the coin bot):

| He posts | The bot does |
|---|---|
| `SIGNAL · NQ — LONG @ 29,026.25` | opens a long on the Nasdaq 100 (NQ / MNQ / NAS100 → NDXUSD; ES → S&P, YM → Dow, GC → gold …) |
| `SELL @ 29,189.75` | closes the open long copies (`BUY` / `COVER @` closes shorts, `CLOSE` / `EXIT @` closes both) |
| `SL to BE` | moves the copies' stop to their entry |
| anything else | ignored |

Size: a safety stop 0.5% from the price (or the `SL @` his message names), sized so that stop loses 2% of the
account — never more than the account's $20 loss cap. No target and no profit lock: the copy closes when he posts
his exit. Signals older than 10 minutes (a reconnect) are not opened; each message is used once.

> ⚠️ A self-bot logs in as YOUR Discord account. That breaks Discord's terms and the account can be banned.

## Setup (on the PC or the VPS — anywhere that stays on)

```bash
cd scripts/discord-scanner
pip install -r requirements.txt
export DISCORD_TOKEN='your Discord user token'          # see "Getting your token" below
export BOT_DASHBOARD_PASSWORD='the dashboard password'
python bot.py        # first run makes config.json from config.example.json
```

Windows PowerShell: `$env:DISCORD_TOKEN='…'` and `$env:BOT_DASHBOARD_PASSWORD='…'` instead of `export`.

Then in `config.json` (never committed — it's in .gitignore):
- `copy.channel_ids`: the elite-signals channel id (Discord → Settings → Advanced → Developer Mode on, then right-click
  the channel → **Copy Channel ID**). Numbers, no quotes: `[1234567890123456789]`.
- `copy.author_ids`: Kojiro's user id (right-click his name → **Copy User ID**). Leave `[]` to copy every post in the
  channel.

Restart `python bot.py`. A copied signal prints a green `[COPY] open: copied LONG NDXUSD …` line, and the same
line appears in the bot's log on the dashboard (Trades → What it did). Everything it received:
`GET /api/forex/discord` (newest 50).

## Settings on the VPS (.env, all optional)

| Variable | Default | |
|---|---|---|
| `DISCORD_COPY` | on | `off` stops copying |
| `DISCORD_COPY_RISK_PCT` | 2 | % of the account the safety stop risks |
| `DISCORD_COPY_STOP_PCT` | 0.5 | safety stop, % of the price, when his message names none |
| `DISCORD_COPY_LEVERAGE` | 50 | capped per market (indices 50×, coins 20×) |
| `DISCORD_COPY_LOCK` | off | `on` = the bot's profit lock also trails these trades |

## Getting your token

1. Open Discord in your browser (not the desktop app)
2. Press `F12` → **Network** tab
3. Send a message in any channel
4. Click the request, look for the `Authorization` header value — that string is your user token

Never paste it in a chat or commit it.

## Scanner (the original keyword features still work)

`scan_keywords` / `scan_regex_patterns` and the `!scan help | stats | add | rm | list | pause | resume | reload` commands
work as before; `pause` now really pauses the keyword scan (copying keeps running).
