#!/usr/bin/env bash
# Pull new code and rebuild the bot — only when something changed.
# Runs every minute from cron (see install-auto-update.sh). Log: ~/bot-update.log
#   - checks GitHub every 5 minutes, or at once when the dashboard's "Update now" button asked
#     (Redis key update:request = "normal" | "force"; "force" rebuilds even without new code)
#   - writes what it did to Redis update:status (shown on the dashboard)
#
# The last SUCCESSFULLY deployed commit is kept in .deployed-sha, so a failed
# build (full disk, network blip…) is retried on the next run instead of being
# skipped forever because the code was already pulled.
set -euo pipefail
cd "$(dirname "$0")/.."

# Never run two updates at once.
exec 9>/tmp/solbot-update.lock
flock -n 9 || exit 0

# Older installs ran this every 5 min — switch to every minute (so the button reacts fast).
if crontab -l 2>/dev/null | grep -q '^\*/5 .*auto-update.sh'; then
  crontab -l | sed 's#^\*/5 \(.*auto-update.sh\)#* \1#' | crontab - || true
fi

rcli() { docker compose exec -T redis redis-cli "$@" 2>/dev/null || true; }
status() { # status <state> <message>
  local json
  json="$(printf '{"at":"%s","state":"%s","message":"%s","deployed":"%s","remote":"%s"}' "$(date -u '+%FT%TZ')" "$1" "$2" "${DEPLOYED:0:7}" "${REMOTE:0:7}")"
  rcli SET update:status "$json" EX 86400 >/dev/null
}

REQ="$(rcli GETDEL update:request | tr -d '\r')"
MIN="$(date -u '+%M')"
# Nothing asked and not a 5-minute mark → done (no GitHub call).
if [[ -z "$REQ" && $((10#$MIN % 5)) -ne 0 ]]; then exit 0; fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
DEPLOYED="$(cat .deployed-sha 2>/dev/null || true)"
REMOTE=""
if ! git fetch -q origin "$BRANCH"; then
  status failed "can't reach GitHub"
  exit 1
fi
REMOTE="$(git rev-parse "origin/$BRANCH")"
if [[ "$REMOTE" == "$DEPLOYED" && "$REQ" != "force" ]]; then
  status up_to_date "already running the newest code"
  exit 0
fi

echo "$(date -u '+%F %T') updating $BRANCH ${DEPLOYED:0:7} → ${REMOTE:0:7}${REQ:+ (asked from the dashboard: $REQ)}"
status updating "pulling ${REMOTE:0:7} and rebuilding (takes 1–3 min)"
PREV="$(git rev-parse HEAD)"
if ! git pull -q --ff-only origin "$BRANCH"; then
  echo "$(date -u '+%F %T') git pull failed (local changes on the server?) — run: cd /root/bot && git status"
  status failed "git pull failed — local changes on the server? (cd /root/bot && git status)"
  exit 1
fi

# The bot reports this version on the dashboard (spot a stuck update).
GIT_SHA="$(git rev-parse --short HEAD)"
export GIT_SHA
FLAGS=(-d --build --remove-orphans)
[[ "$REQ" == "force" ]] && FLAGS+=(--force-recreate)
if ! docker compose up "${FLAGS[@]}"; then
  echo "$(date -u '+%F %T') BUILD FAILED — retrying in 5 min. Disk: $(df -h / | tail -1)"
  status failed "build failed — retrying in 5 min (disk: $(df -h / | tail -1 | awk '{print $5}') used)"
  exit 1
fi
# Caddy only reads its config at start/reload.
if [[ -z "$DEPLOYED" || -n "$(git diff --name-only "$PREV" HEAD -- Caddyfile)" ]]; then
  docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || true
fi
echo "$REMOTE" > .deployed-sha
DEPLOYED="$REMOTE"
status done "updated to ${GIT_SHA}"
# Keep the disk from filling up with old images / build cache.
docker image prune -f >/dev/null 2>&1 || true
docker builder prune -f --filter until=48h >/dev/null 2>&1 || true
echo "$(date -u '+%F %T') update done (${GIT_SHA})"
