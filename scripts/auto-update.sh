#!/usr/bin/env bash
# Pull new code and rebuild the bot — only when something changed.
# Runs every 5 minutes from cron (see install-auto-update.sh). Log: ~/bot-update.log
#
# The last SUCCESSFULLY deployed commit is kept in .deployed-sha, so a failed
# build (full disk, network blip…) is retried on the next run instead of being
# skipped forever because the code was already pulled.
set -euo pipefail
cd "$(dirname "$0")/.."

# Never run two updates at once.
exec 9>/tmp/solbot-update.lock
flock -n 9 || exit 0

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git fetch -q origin "$BRANCH"
REMOTE="$(git rev-parse "origin/$BRANCH")"
DEPLOYED="$(cat .deployed-sha 2>/dev/null || true)"
[[ "$REMOTE" == "$DEPLOYED" ]] && exit 0

echo "$(date -u '+%F %T') updating $BRANCH ${DEPLOYED:0:7} → ${REMOTE:0:7}"
PREV="$(git rev-parse HEAD)"
if ! git pull -q --ff-only origin "$BRANCH"; then
  echo "$(date -u '+%F %T') git pull failed (local changes on the server?) — run: cd /root/bot && git status"
  exit 1
fi

# The bot reports this version on the dashboard (spot a stuck update).
GIT_SHA="$(git rev-parse --short HEAD)"
export GIT_SHA
if ! docker compose up -d --build --remove-orphans; then
  echo "$(date -u '+%F %T') BUILD FAILED — retrying in 5 min. Disk: $(df -h / | tail -1)"
  exit 1
fi
# Caddy only reads its config at start/reload.
if [[ -z "$DEPLOYED" || -n "$(git diff --name-only "$PREV" HEAD -- Caddyfile)" ]]; then
  docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || true
fi
echo "$REMOTE" > .deployed-sha
# Keep the disk from filling up with old images / build cache.
docker image prune -f >/dev/null 2>&1 || true
docker builder prune -f --filter until=48h >/dev/null 2>&1 || true
echo "$(date -u '+%F %T') update done (${GIT_SHA})"
