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
docker stats --no-stream --format '{{.Name}}  cpu {{.CPUPerc}}  mem {{.MemUsage}}' 2>/dev/null
df -h / | tail -1
echo "-- per-container memory vs its limit (4 GB VPS caps: bot 2g, forex 1.4g, postgres 1.5g, redis 2g maxmemory, caddy 128m) --"
docker stats --no-stream --format '{{.Name}}  {{.MemUsage}}  ({{.MemPerc}} of its limit)' 2>/dev/null
docker compose exec -T redis redis-cli info memory 2>/dev/null | grep -E '^used_memory_human|^maxmemory_human'
echo "-- Postgres settings in effect --"
docker compose exec -T postgres psql -U "${POSTGRES_USER:-bot}" -d "${POSTGRES_DB:-solbot}" -Atc "SELECT name || '=' || setting || COALESCE(unit,'') FROM pg_settings WHERE name IN ('shared_buffers','effective_cache_size','work_mem','maintenance_work_mem','max_wal_size','max_worker_processes','max_parallel_workers','timescaledb.max_background_workers')" 2>/dev/null | tr '\n' ' '; echo
echo "-- Trade tape (replay recording) on disk --"
docker compose exec -T postgres psql -U "${POSTGRES_USER:-bot}" -d "${POSTGRES_DB:-solbot}" -Atc "SELECT 'TradeTape ' || pg_size_pretty(hypertable_size('\"TradeTape\"')) || ', rows ~' || (SELECT reltuples::bigint FROM pg_class WHERE relname='TradeTape') || ', oldest ' || COALESCE((SELECT min(t)::text FROM \"TradeTape\"),'-')" 2>/dev/null || echo "TradeTape: not a hypertable / no TimescaleDB"
docker compose exec -T postgres psql -U "${POSTGRES_USER:-bot}" -d "${POSTGRES_DB:-solbot}" -Atc "SELECT 'compressed chunks: ' || count(*) FILTER (WHERE is_compressed) || ' of ' || count(*) FROM timescaledb_information.chunks WHERE hypertable_name='TradeTape'" 2>/dev/null
docker compose exec -T postgres psql -U "${POSTGRES_USER:-bot}" -d "${POSTGRES_DB:-solbot}" -Atc "SELECT 'before/after compression: ' || pg_size_pretty(before_compression_total_bytes) || ' -> ' || pg_size_pretty(after_compression_total_bytes) FROM hypertable_compression_stats('\"TradeTape\"')" 2>/dev/null
echo "-- Redis keys per prefix (what fills the memory) --"
docker compose exec -T redis sh -c "redis-cli --scan --count 1000 | cut -d: -f1 | sort | uniq -c | sort -rn | head -15" 2>/dev/null
echo "-- Biggest Redis keys --"
docker compose exec -T redis redis-cli --memkeys 2>/dev/null | grep -E 'Biggest|found' | head -12
line "health"
curl -s -m 5 http://127.0.0.1:8080/api/health; echo
line "last updates"
tail -n 8 ~/bot-update.log 2>/dev/null || echo "no ~/bot-update.log"
crontab -l 2>/dev/null | grep -c auto-update | sed 's/^/auto-update cron entries: /'
line "bot errors (last 30 min)"
docker compose logs --since 30m bot 2>/dev/null | grep -v '📊 stats' | grep -Ei 'error|fatal|exiting|out of memory|killed' | tail -n 15
line "forex errors (last 30 min) — the forex container (v15.4)"
echo "forex restarts (docker): $(docker inspect -f '{{.RestartCount}}' "$(docker compose ps -q forex 2>/dev/null)" 2>/dev/null || echo '?')"
docker compose logs --since 30m forex 2>/dev/null | grep -Ei 'error|fatal|exiting|out of memory|killed' | tail -n 10
line "kernel OOM kills"
dmesg 2>/dev/null | grep -i 'killed process' | tail -n 3 || true
