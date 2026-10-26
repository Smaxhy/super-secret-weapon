#!/usr/bin/env python3
"""
Discord Self Bot — Text Scanner
Monitors messages across servers/channels for keyword and regex matches.
Logs hits to file, optional DM alerts, optional channel logging.

Copy trading (v27.46): every message in the signal channel(s) under "copy" in
config.json is POSTed to the trading bot (/api/forex/discord-signal), which
reads it ("SIGNAL · NQ — LONG @ 29,026.25", "SELL @ 29,189.75") and opens /
closes a paper trade. Secrets come from the environment first:
  DISCORD_TOKEN           your Discord user token
  BOT_DASHBOARD_PASSWORD  the dashboard password (the bot API login)

⚠️  Self bots violate Discord TOS. Use at your own risk.
"""

from __future__ import annotations

import json
import re
import os
import sys
import asyncio
import logging
from datetime import datetime, timezone
from pathlib import Path

import aiohttp
import discord
from colorama import Fore, Style, init as colorama_init

colorama_init(autoreset=True)

# ─── Load Config ─────────────────────────────────────────────────────────────

CONFIG_PATH = Path(__file__).parent / "config.json"

def load_config() -> dict:
    if not CONFIG_PATH.exists():
        example = CONFIG_PATH.with_name("config.example.json")
        if not example.exists():
            print(f"{Fore.RED}[ERROR] config.json not found at {CONFIG_PATH}")
            sys.exit(1)
        CONFIG_PATH.write_text(example.read_text())
        print(f"{Fore.YELLOW}Made config.json from config.example.json — fill in channel_ids / author_ids{Style.RESET_ALL}")
    with open(CONFIG_PATH, "r") as f:
        return json.load(f)

CFG = load_config()

# ─── Logging Setup ───────────────────────────────────────────────────────────

logger = logging.getLogger("scanner")
logger.setLevel(logging.INFO)

console_handler = logging.StreamHandler()
console_handler.setFormatter(
    logging.Formatter(f"{Fore.CYAN}%(asctime)s{Style.RESET_ALL} %(message)s", datefmt="%H:%M:%S")
)
logger.addHandler(console_handler)

if CFG.get("log_to_file", True):
    log_path = Path(__file__).parent / CFG.get("log_file", "scan_hits.log")
    file_handler = logging.FileHandler(log_path, encoding="utf-8")
    file_handler.setFormatter(
        logging.Formatter("%(asctime)s | %(message)s", datefmt="%Y-%m-%d %H:%M:%S")
    )
    logger.addHandler(file_handler)

# ─── Compile Patterns ────────────────────────────────────────────────────────

KEYWORDS: list[str] = CFG.get("scan_keywords", [])
REGEX_PATTERNS: list[re.Pattern] = []

_flags = 0 if CFG.get("case_sensitive", False) else re.IGNORECASE
for raw in CFG.get("scan_regex_patterns", []):
    try:
        REGEX_PATTERNS.append(re.compile(raw, _flags))
    except re.error as e:
        logger.warning(f"Bad regex pattern '{raw}': {e}")

# ─── Helpers ─────────────────────────────────────────────────────────────────

def matches_keywords(text: str) -> list[str]:
    """Return list of keywords found in text."""
    if not text:
        return []
    check = text if CFG.get("case_sensitive", False) else text.lower()
    hits = []
    for kw in KEYWORDS:
        compare = kw if CFG.get("case_sensitive", False) else kw.lower()
        if compare in check:
            hits.append(kw)
    return hits

def matches_regex(text: str) -> list[str]:
    """Return list of regex patterns that matched."""
    if not text:
        return []
    hits = []
    for pat in REGEX_PATTERNS:
        if pat.search(text):
            hits.append(pat.pattern)
    return hits

def should_scan_guild(guild_id: int) -> bool:
    if CFG.get("monitor_all_guilds", True):
        return True
    return guild_id in CFG.get("monitored_guild_ids", [])

def should_scan_channel(channel_id: int) -> bool:
    if channel_id in CFG.get("ignored_channel_ids", []):
        return False
    monitored = CFG.get("monitored_channel_ids", [])
    if monitored:
        return channel_id in monitored
    return True

def should_ignore_user(user_id: int) -> bool:
    return user_id in CFG.get("ignored_user_ids", [])

def message_text(msg: discord.Message) -> str:
    """Content + every embed's text (signal bots often post embeds only)."""
    parts = [msg.content or ""]
    for embed in msg.embeds:
        parts += [embed.title or "", embed.description or ""]
        parts += [f"{f.name} {f.value}" for f in embed.fields]
        if embed.footer and embed.footer.text:
            parts.append(embed.footer.text)
    return "\n".join(p for p in parts if p).strip()

# ─── Copy trading → the trading bot ─────────────────────────────────────────

def copy_cfg() -> dict:
    return CFG.get("copy", {}) or {}

def is_signal_message(msg: discord.Message) -> bool:
    c = copy_cfg()
    if not c.get("enabled", False):
        return False
    if msg.channel.id not in c.get("channel_ids", []):
        return False
    authors = c.get("author_ids", [])
    return not authors or msg.author.id in authors

class BotApi:
    """Logs in to the trading bot once (JWT, 7 days) and re-logs in on a 401."""

    def __init__(self):
        self.token: str | None = None
        self.session: aiohttp.ClientSession | None = None

    def base(self) -> str:
        return os.environ.get("BOT_API_URL") or copy_cfg().get("api_url", "https://209-250-254-34.sslip.io")

    async def _session(self) -> aiohttp.ClientSession:
        if self.session is None or self.session.closed:
            self.session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=20))
        return self.session

    async def login(self) -> bool:
        password = os.environ.get("BOT_DASHBOARD_PASSWORD") or os.environ.get("DASHBOARD_PASSWORD") or copy_cfg().get("api_password", "")
        if not password:
            logger.warning("copy: no BOT_DASHBOARD_PASSWORD set — can't send signals to the bot")
            return False
        s = await self._session()
        async with s.post(f"{self.base()}/api/auth/login", json={"password": password}) as r:
            if r.status != 200:
                logger.warning(f"copy: bot login failed (HTTP {r.status})")
                return False
            self.token = (await r.json()).get("token")
            return bool(self.token)

    async def send_signal(self, msg: discord.Message, text: str) -> dict | None:
        body = {
            "id": str(msg.id),
            "text": text,
            "at": int(msg.created_at.timestamp() * 1000),
            "source": copy_cfg().get("source", "kojiro"),
            "channel": str(msg.channel.id),
        }
        for attempt in range(3):
            if not self.token and not await self.login():
                return None
            try:
                s = await self._session()
                async with s.post(f"{self.base()}/api/forex/discord-signal", json=body,
                                  headers={"Authorization": f"Bearer {self.token}"}) as r:
                    if r.status == 401:
                        self.token = None
                        continue
                    return await r.json(content_type=None)
            except Exception as e:  # network hiccup: try again shortly
                logger.warning(f"copy: send failed ({e}), retry {attempt + 1}/3")
                await asyncio.sleep(2 * (attempt + 1))
        return None

bot_api = BotApi()

async def forward_signal(msg: discord.Message):
    text = message_text(msg)
    if not text:
        return
    res = await bot_api.send_signal(msg, text)
    if res is None:
        logger.warning(f"COPY FAILED | {text[:120]!r}")
        return
    kind = res.get("kind")
    if kind in ("none", "duplicate"):
        return
    color = Fore.GREEN if res.get("ok") else Fore.RED
    print(f"{color}[COPY] {kind}: {res.get('what')}{Style.RESET_ALL}")
    logger.info(f"COPY {kind} | {res.get('what')} | {text[:200]!r}")

def format_hit(msg: discord.Message, matched: list[str], source: str = "content") -> str:
    guild_name = msg.guild.name if msg.guild else "DM"
    channel_name = getattr(msg.channel, "name", "DM")
    return (
        f"MATCH [{source}] in #{channel_name} ({guild_name}) | "
        f"User: {msg.author} ({msg.author.id}) | "
        f"Matched: {', '.join(matched)} | "
        f"Content: {msg.content[:200]}"
    )

def format_hit_pretty(msg: discord.Message, matched: list[str], source: str = "content") -> str:
    guild_name = msg.guild.name if msg.guild else "DM"
    channel_name = getattr(msg.channel, "name", "DM")
    timestamp = msg.created_at.strftime("%Y-%m-%d %H:%M:%S UTC")
    return (
        f"{Fore.GREEN}╔══ MATCH FOUND ══╗{Style.RESET_ALL}\n"
        f"  {Fore.YELLOW}Server:{Style.RESET_ALL}  {guild_name}\n"
        f"  {Fore.YELLOW}Channel:{Style.RESET_ALL} #{channel_name}\n"
        f"  {Fore.YELLOW}User:{Style.RESET_ALL}    {msg.author} ({msg.author.id})\n"
        f"  {Fore.YELLOW}Source:{Style.RESET_ALL}  {source}\n"
        f"  {Fore.YELLOW}Matched:{Style.RESET_ALL} {Fore.RED}{', '.join(matched)}{Style.RESET_ALL}\n"
        f"  {Fore.YELLOW}Time:{Style.RESET_ALL}    {timestamp}\n"
        f"  {Fore.YELLOW}Content:{Style.RESET_ALL} {msg.content[:300]}\n"
        f"  {Fore.YELLOW}Link:{Style.RESET_ALL}    {msg.jump_url}\n"
        f"{Fore.GREEN}╚═════════════════╝{Style.RESET_ALL}"
    )

# ─── Bot Setup ───────────────────────────────────────────────────────────────

bot = discord.Client()
bot._scanner_paused = False

scan_stats = {
    "messages_scanned": 0,
    "matches_found": 0,
    "started_at": None,
}

@bot.event
async def on_ready():
    scan_stats["started_at"] = datetime.now(timezone.utc)
    print(f"""
{Fore.GREEN}{'='*50}
  Discord Self Bot Scanner — ONLINE
{'='*50}{Style.RESET_ALL}
  {Fore.YELLOW}Account:{Style.RESET_ALL}    {bot.user} ({bot.user.id})
  {Fore.YELLOW}Guilds:{Style.RESET_ALL}     {len(bot.guilds)}
  {Fore.YELLOW}Keywords:{Style.RESET_ALL}   {len(KEYWORDS)} loaded
  {Fore.YELLOW}Regex:{Style.RESET_ALL}      {len(REGEX_PATTERNS)} patterns
  {Fore.YELLOW}Monitoring:{Style.RESET_ALL} {'All guilds' if CFG.get('monitor_all_guilds') else f'{len(CFG.get("monitored_guild_ids", []))} guilds'}
  {Fore.YELLOW}Copying:{Style.RESET_ALL}    {f"ON → {bot_api.base()} ({len(copy_cfg().get('channel_ids', []))} channel)" if copy_cfg().get('enabled') else 'off'}
  {Fore.YELLOW}Log file:{Style.RESET_ALL}   {CFG.get('log_file', 'scan_hits.log') if CFG.get('log_to_file') else 'Disabled'}
{Fore.GREEN}{'='*50}{Style.RESET_ALL}
  Scanning... (type {CFG.get('prefix', '!scan')} help in Discord for commands)
""")

@bot.event
async def on_message(message: discord.Message):
    # ── Self-commands ────────────────────────────────────────────────────
    prefix = CFG.get("prefix", "!scan")
    if message.author.id == bot.user.id and message.content.startswith(prefix):
        await handle_command(message)
        return

    # ── Copy trading: signal channel → the trading bot (runs even while paused) ─
    if is_signal_message(message):
        asyncio.create_task(forward_signal(message))

    # ── Ignore own messages ──────────────────────────────────────────────
    if message.author.id == bot.user.id:
        return
    if bot._scanner_paused:
        return

    # ── Filter checks ────────────────────────────────────────────────────
    if message.guild and not should_scan_guild(message.guild.id):
        return
    if not should_scan_channel(message.channel.id):
        return
    if should_ignore_user(message.author.id):
        return

    scan_stats["messages_scanned"] += 1

    # ── Scan message content ─────────────────────────────────────────────
    all_hits = []

    kw_hits = matches_keywords(message.content)
    rx_hits = matches_regex(message.content)
    content_hits = kw_hits + rx_hits
    if content_hits:
        all_hits.append(("content", content_hits))

    # ── Scan embeds ──────────────────────────────────────────────────────
    if CFG.get("scan_embeds", True):
        for embed in message.embeds:
            embed_text = " ".join(filter(None, [
                embed.title, embed.description,
                embed.footer.text if embed.footer else None,
                embed.author.name if embed.author else None,
            ]))
            for field in embed.fields:
                embed_text += f" {field.name} {field.value}"

            ekw = matches_keywords(embed_text)
            erx = matches_regex(embed_text)
            if ekw or erx:
                all_hits.append(("embed", ekw + erx))

    # ── Report hits ──────────────────────────────────────────────────────
    for source, matched in all_hits:
        scan_stats["matches_found"] += 1
        logger.info(format_hit(message, matched, source))
        print(format_hit_pretty(message, matched, source))

        # DM alert
        dm_id = CFG.get("alert_dm_user_id")
        if dm_id:
            try:
                user = await bot.fetch_user(dm_id)
                if user:
                    alert = (
                        f"🔔 **Scanner Match** [{source}]\n"
                        f"**Server:** {message.guild.name if message.guild else 'DM'}\n"
                        f"**Channel:** #{getattr(message.channel, 'name', 'DM')}\n"
                        f"**User:** {message.author}\n"
                        f"**Matched:** {', '.join(matched)}\n"
                        f"**Content:** {message.content[:500]}\n"
                        f"**Link:** {message.jump_url}"
                    )
                    await user.send(alert)
            except Exception as e:
                logger.warning(f"Failed to send DM alert: {e}")

        # Channel log
        log_ch_id = CFG.get("log_to_channel_id")
        if log_ch_id:
            try:
                ch = bot.get_channel(log_ch_id)
                if ch:
                    await ch.send(
                        f"🔍 **Match** [{source}] | "
                        f"#{getattr(message.channel, 'name', 'DM')} | "
                        f"{message.author} | "
                        f"Matched: `{', '.join(matched)}` | "
                        f"[Jump]({message.jump_url})"
                    )
            except Exception as e:
                logger.warning(f"Failed to log to channel: {e}")

# ─── Self-Commands ────────────────────────────────────────────────────────────

async def handle_command(message: discord.Message):
    global CFG
    prefix = CFG.get("prefix", "!scan")
    parts = message.content[len(prefix):].strip().split()
    cmd = parts[0].lower() if parts else "help"

    # Delete the command message to keep it stealth
    try:
        await message.delete()
    except Exception:
        pass

    if cmd == "help":
        await message.channel.send(
            f"```\n"
            f"Scanner Commands:\n"
            f"  {prefix} stats    — Show scan statistics\n"
            f"  {prefix} add <kw> — Add a keyword\n"
            f"  {prefix} rm <kw>  — Remove a keyword\n"
            f"  {prefix} list     — List current keywords\n"
            f"  {prefix} pause    — Pause scanning\n"
            f"  {prefix} resume   — Resume scanning\n"
            f"  {prefix} reload   — Reload config from file\n"
            f"  {prefix} help     — This message\n"
            f"```",
            delete_after=15,
        )

    elif cmd == "stats":
        uptime = datetime.now(timezone.utc) - scan_stats["started_at"]
        hours, remainder = divmod(int(uptime.total_seconds()), 3600)
        minutes, seconds = divmod(remainder, 60)
        await message.channel.send(
            f"```\n"
            f"Scanner Stats:\n"
            f"  Uptime:    {hours}h {minutes}m {seconds}s\n"
            f"  Scanned:   {scan_stats['messages_scanned']} messages\n"
            f"  Matches:   {scan_stats['matches_found']}\n"
            f"  Keywords:  {len(KEYWORDS)}\n"
            f"  Regex:     {len(REGEX_PATTERNS)} patterns\n"
            f"  Guilds:    {len(bot.guilds)}\n"
            f"```",
            delete_after=15,
        )

    elif cmd == "add" and len(parts) > 1:
        new_kw = " ".join(parts[1:])
        KEYWORDS.append(new_kw)
        _save_keywords()
        await message.channel.send(
            f"✅ Added keyword: `{new_kw}` ({len(KEYWORDS)} total)", delete_after=10
        )

    elif cmd == "rm" and len(parts) > 1:
        rm_kw = " ".join(parts[1:])
        if rm_kw in KEYWORDS:
            KEYWORDS.remove(rm_kw)
            _save_keywords()
            await message.channel.send(f"🗑️ Removed: `{rm_kw}`", delete_after=10)
        else:
            await message.channel.send(f"❌ Not found: `{rm_kw}`", delete_after=10)

    elif cmd == "list":
        kw_list = ", ".join(f"`{k}`" for k in KEYWORDS) or "None"
        await message.channel.send(f"📋 Keywords: {kw_list}", delete_after=15)

    elif cmd == "reload":
        CFG = load_config()
        KEYWORDS.clear()
        KEYWORDS.extend(CFG.get("scan_keywords", []))
        await message.channel.send("🔄 Config reloaded.", delete_after=10)

    elif cmd == "pause":
        bot._scanner_paused = True
        await message.channel.send("⏸️ Scanner paused.", delete_after=10)

    elif cmd == "resume":
        bot._scanner_paused = False
        await message.channel.send("▶️ Scanner resumed.", delete_after=10)

def _save_keywords():
    """Persist current keywords back to config.json."""
    CFG["scan_keywords"] = list(KEYWORDS)
    with open(CONFIG_PATH, "w") as f:
        json.dump(CFG, f, indent=2)

# ─── Run ─────────────────────────────────────────────────────────────────────

def main():
    token = os.environ.get("DISCORD_TOKEN") or CFG.get("token", "")
    if not token or token == "YOUR_DISCORD_TOKEN_HERE":
        if os.environ.get("DISCORD_IN_DOCKER"):
            import time
            print(f"{Fore.RED}[ERROR] DISCORD_TOKEN is not in /root/bot/.env{Style.RESET_ALL}")
            time.sleep(3600)
            sys.exit(1)
        print(f"{Fore.RED}[ERROR] Set DISCORD_TOKEN (or the token in config.json){Style.RESET_ALL}")
        print(f"{Fore.YELLOW}How to get your token:")
        print(f"  1. Open Discord in your browser")
        print(f"  2. Press F12 → Network tab")
        print(f"  3. Send any message, find the request")
        print(f"  4. Look for 'Authorization' header — that's your token{Style.RESET_ALL}")
        sys.exit(1)

    print(f"{Fore.CYAN}Starting scanner...{Style.RESET_ALL}")
    try:
        bot.run(token)
    except discord.LoginFailure:
        print(f"{Fore.RED}[ERROR] Discord refused the token — get a fresh one (README: Getting your token){Style.RESET_ALL}")
        # in the VPS container: wait an hour before Docker restarts it, so a dead token doesn't hammer Discord's login
        if os.environ.get("DISCORD_IN_DOCKER"):
            import time
            time.sleep(3600)
        sys.exit(1)

if __name__ == "__main__":
    main()
