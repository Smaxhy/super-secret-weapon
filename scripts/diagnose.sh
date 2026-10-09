#!/usr/bin/env bash
# One command that shows why the bot is offline / not updating.
# On the VPS:  bash /root/bot/scripts/diagnose.sh
# Prints no secrets (only status, versions, memory, disk and recent log lines).
cd "$(dirname "$0")/.." || exit 1
line() { printf '\n==== %s ====\n' "$1"; }
line "code"
echo "checked out: $(git rev-parse --short HEAD)  deployed: $(cut -c1-7 .deployed-sha 2>/dev/null || echo none)  remote: $(git rev-parse --short "origin/$(git rev-parse --abbrev-ref HEAD)" 2>/dev/null)"
line "containers"
docker compose ps --format 'table {{.Name}}\t{{.Status}}' 2>/dev/null || docker compose ps
echo "bot restarts (docker): $(docker inspect -f '{{.RestartCount}}' "$(docker compose ps -q bot 2>/dev/null)" 2>/dev/null || echo '?')"
echo "bot OOM-killed last time: $(docker inspect -f '{{.State.OOMKilled}}' "$(docker compose ps -q bot 2>/dev/null)" 2>/dev/null || echo '?')"
line "memory / disk"
free -m
df -h / | tail -1
docker compose exec -T redis redis-cli info memory 2>/dev/null | grep -E '^used_memory_human|^maxmemory_human'
line "health"
curl -s -m 5 http://127.0.0.1:8080/api/health; echo
line "last updates"
tail -n 8 ~/bot-update.log 2>/dev/null || echo "no ~/bot-update.log"
crontab -l 2>/dev/null | grep -c auto-update | sed 's/^/auto-update cron entries: /'
line "bot errors (last 30 min)"
docker compose logs --since 30m bot 2>/dev/null | grep -Ei 'error|fatal|exiting|out of memory|killed' | tail -n 15
line "kernel OOM kills"
dmesg 2>/dev/null | grep -i 'killed process' | tail -n 3 || true
